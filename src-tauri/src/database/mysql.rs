//! MySQL adapter backed by the pure-Rust `mysql` crate.
//!
//! This module implements the metadata, query, and guarded-write parts of the
//! shared [`DatabaseAdapter`] contract for MySQL servers:
//!
//! - Test a server connection, open one, report state, and disconnect.
//! - List the databases (schemas) a connection can address.
//! - List base tables and views in a database and describe their columns and
//!   primary key from `information_schema`.
//! - Execute a single SQL statement and return a normalized, capped result with
//!   column metadata, rows, affected-row count, duration, and structured errors.
//! - Fetch bounded, filtered, sorted pages of a table or view, reporting the
//!   primary key as a safe row identity when the object has one.
//! - Apply staged parameterized insert/update/delete changes with primary-key
//!   identity checks and stale-row conflict detection.
//! - Begin, commit, and roll back explicit transactions on a connection.
//!
//! Design rules:
//!
//! - Parameters supplied with a request are bound through the binary protocol;
//!   caller text is never concatenated into the statement. Object/database names
//!   are always bound values in `information_schema` predicates, never
//!   interpolated.
//! - An update or delete requires the row identity to match the table's primary
//!   key exactly. A statement that affects no row is reported as a conflict
//!   rather than a zero-row success.
//! - Driver-native [`mysql::Conn`] handles never leave this module. Callers
//!   receive opaque, serializable [`ConnectionId`] tokens.
//! - Credentials enter only through [`ConnectionSecret`] and are placed in the
//!   driver options; they are never added to errors, logs, or the connection id.
//!
//! **Driver decision:** the synchronous `mysql` crate (rust-mysql-simple) is used
//! instead of an async SQLx pool. It maps directly onto the adapter's
//! per-connection model, supports prepared statements and TLS, and needs no
//! async runtime to test — matching the `rusqlite` choice made for SQLite. SQLx
//! remains a candidate for the PostgreSQL adapter.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mysql::consts::{ColumnFlags, ColumnType};
use mysql::prelude::{Protocol, Queryable};
use mysql::{Column, Conn, Opts, OptsBuilder, SslOpts, Value};

use crate::database::{
    build_delete_statement, build_filter_clause, build_insert_statement, build_table_page_query,
    build_update_statement, conflict_columns, effective_sort_order, effective_table_page_limit,
    quote_identifier_backtick, require_identifier, validate_default_expression,
    validate_row_identity, validate_type_name, AdapterFuture, CancelOutcome, ChangeRequest,
    ChangeResult, ColumnDefinition, ConnectionId, ConnectionSecret, ConnectionState,
    ConnectionTest, ConstraintInfo, ConstraintKind, DatabaseAdapter, ForeignKeyDefinition,
    IndexInfo, ObjectKind, ObjectRef, ObjectScope, PendingChange, ScopeListing, TableDefinition,
    TableDescription, TableFilter, TablePage, TablePageRequest, TransactionId,
};
use crate::domain::{
    CellValue, ColumnInfo, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory,
    OperationId, QueryError, QueryRequest, QueryResult, Row, ServerConnection, TlsMode,
};

/// Upper bound on rows the adapter returns for one statement.
///
/// The application applies its own (smaller) default cap; this ceiling keeps a
/// caller that bypasses the application from loading an unbounded result into
/// memory. Rows beyond the cap are skipped and the result is marked truncated.
const MAX_RESULT_ROWS: u32 = 10_000;

/// How long the driver waits for the TCP connection and TLS handshake.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// The MySQL server's `binary` character set id, which marks BLOB/BINARY columns.
const BINARY_CHARSET_ID: u16 = 63;

/// State and driver handle for one open connection.
struct ConnectionSlot {
    state: ConnectionState,
    handle: Option<Conn>,
    /// Default database selected by the descriptor, if any.
    default_database: Option<String>,
    /// Explicit transactions begun on this connection and not yet ended.
    open_transactions: HashSet<TransactionId>,
}

/// MySQL adapter implementing the shared database boundary.
///
/// The adapter owns all [`mysql::Conn`] handles for its lifetime. Each is
/// addressed through an opaque [`ConnectionId`] so no driver object can cross
/// the Tauri IPC boundary. Each connection has its own lock, so a long-running
/// statement on one connection does not block another.
pub struct MySqlAdapter {
    connections: Mutex<HashMap<ConnectionId, Arc<Mutex<ConnectionSlot>>>>,
    next_connection: AtomicU64,
    next_transaction: AtomicU64,
}

impl Default for MySqlAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl MySqlAdapter {
    /// Creates an adapter with no open connections.
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(0),
            next_transaction: AtomicU64::new(0),
        }
    }

    fn connection_map(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<ConnectionId, Arc<Mutex<ConnectionSlot>>>> {
        self.connections
            .lock()
            .expect("MySQL adapter connection state poisoned")
    }

    /// Resolves the per-connection slot or reports an unknown-token error.
    fn connection_slot(
        &self,
        connection: &ConnectionId,
    ) -> Result<Arc<Mutex<ConnectionSlot>>, QueryError> {
        self.connection_map()
            .get(connection)
            .cloned()
            .ok_or_else(|| connection_error(connection))
    }

    /// Runs `use_connection` against an open connection or reports a normalized
    /// connection error for an unknown/closed token.
    ///
    /// Only the target connection's lock is held, so independent connections can
    /// be used concurrently.
    fn with_connection<T>(
        &self,
        connection: &ConnectionId,
        use_connection: impl FnOnce(&mut Conn, Option<&str>) -> Result<T, QueryError>,
    ) -> Result<T, QueryError> {
        let slot = self.connection_slot(connection)?;
        let mut slot = slot
            .lock()
            .expect("MySQL connection state must not be poisoned");
        let database = slot.default_database.clone();
        let state = slot.state;
        match (state, slot.handle.as_mut()) {
            (ConnectionState::Connected, Some(handle)) => {
                use_connection(handle, database.as_deref())
            }
            _ => Err(connection_error(connection)),
        }
    }
}

/// Error for an unknown or already-closed connection token.
fn connection_error(connection: &ConnectionId) -> QueryError {
    QueryError::new(
        ErrorCategory::Connection,
        format!("connection `{connection}` is not open"),
    )
}

/// Error for invalid or mismatched adapter configuration.
fn configuration_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Configuration, message)
}

/// Error for a capability that is not implemented in this slice.
fn unsupported_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Unsupported, message)
}

/// Extracts the server settings from a MySQL descriptor or reports a mismatch.
fn mysql_server(descriptor: &ConnectionDescriptor) -> Result<&ServerConnection, QueryError> {
    match descriptor {
        ConnectionDescriptor::MySql(server) => Ok(server),
        other => Err(configuration_error(format!(
            "the MySQL adapter cannot serve a {} connection",
            other.engine()
        ))),
    }
}

/// Maps a requested TLS mode onto the driver's SSL options.
///
/// The driver only has an "require TLS" switch: a set [`SslOpts`] makes the
/// connection mandatory. `Preferred` therefore requests TLS with certificate and
/// domain verification disabled; it does not fall back to plaintext.
fn ssl_opts_for(mode: TlsMode) -> Option<SslOpts> {
    match mode {
        TlsMode::Disabled => None,
        TlsMode::Preferred | TlsMode::Required => Some(
            SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true),
        ),
        // Verify the certificate chain but not that the certificate matches the
        // host name; the descriptor carries no custom root certificate.
        TlsMode::VerifyCa => Some(SslOpts::default().with_danger_skip_domain_validation(true)),
        // Verify both the chain and the server identity.
        TlsMode::VerifyFull => Some(SslOpts::default()),
    }
}

/// Builds driver options from a descriptor and its resolved secret.
///
/// The password is taken from [`ConnectionSecret`] and never added anywhere
/// else. Host/port are validated so a blank host fails before any I/O.
fn build_opts(
    server: &ServerConnection,
    secret: Option<&ConnectionSecret>,
) -> Result<Opts, QueryError> {
    let host = server.host.trim();
    if host.is_empty() {
        return Err(configuration_error("a MySQL host is required"));
    }
    if server.port == 0 {
        return Err(configuration_error("a MySQL port is required"));
    }

    let builder = OptsBuilder::new()
        .ip_or_hostname(Some(host))
        .tcp_port(server.port)
        .user(Some(server.username.as_str()))
        .pass(secret.map(ConnectionSecret::expose))
        .db_name(server.database.as_deref())
        // Connecting through a named pipe on Windows is surprising; always use
        // TCP so the host/port in the descriptor are what is addressed.
        .prefer_socket(false)
        .tcp_connect_timeout(Some(CONNECT_TIMEOUT))
        .ssl_opts(ssl_opts_for(server.tls));

    Ok(Opts::from(builder))
}

/// Opens a writable connection to a MySQL server.
///
/// The previous read-only slice switched the session to `READ ONLY`; that is no
/// longer done because the guarded-write path is implemented here.
fn open_writable(
    descriptor: &ConnectionDescriptor,
    secret: Option<&ConnectionSecret>,
) -> Result<Conn, QueryError> {
    let server = mysql_server(descriptor)?;
    let opts = build_opts(server, secret)?;
    Conn::new(opts).map_err(map_error)
}

/// Normalized category for a MySQL server error code/SQLSTATE.
fn categorize_mysql(code: u16, state: &str) -> ErrorCategory {
    match code {
        1045 | 1251 | 1698 => ErrorCategory::Authentication,
        1044 | 1142 | 1143 | 1207 | 1227 | 1290 | 1370 => ErrorCategory::Permission,
        1048 | 1062 | 1216 | 1217 | 1451 | 1452 | 1557 | 1586 | 3819 => ErrorCategory::Constraint,
        1205 | 1213 => ErrorCategory::Locking,
        1064 | 1149 => ErrorCategory::Syntax,
        1046 | 1049 | 1051 | 1054 | 1109 | 1110 | 1113 | 1146 => ErrorCategory::Validation,
        _ => categorize_sqlstate(state),
    }
}

/// Normalized category for a SQLSTATE class, used when the code is not known.
fn categorize_sqlstate(state: &str) -> ErrorCategory {
    if state.starts_with("28") {
        ErrorCategory::Authentication
    } else if state.starts_with("23") {
        ErrorCategory::Constraint
    } else if state.starts_with("08") {
        ErrorCategory::Connection
    } else if state.starts_with("40") {
        ErrorCategory::Locking
    } else if state.starts_with("22") {
        ErrorCategory::Validation
    } else if state.starts_with("42") || state.starts_with("HY") {
        ErrorCategory::Validation
    } else {
        ErrorCategory::Internal
    }
}

/// Safe, user-facing summary for a normalized category.
///
/// The raw server message is preserved separately in `engine_detail`; this text
/// is generic so it never needs to include a host, user, or credential.
fn safe_failure_message(category: ErrorCategory) -> &'static str {
    match category {
        ErrorCategory::Authentication => "the MySQL server rejected the credentials",
        ErrorCategory::Permission => "the MySQL user does not have permission for this operation",
        ErrorCategory::Configuration => "the MySQL connection configuration is invalid",
        ErrorCategory::Syntax => "the SQL statement has a syntax error",
        ErrorCategory::Validation => "the MySQL statement could not be executed",
        ErrorCategory::Constraint => "a MySQL constraint was violated",
        ErrorCategory::Locking => "the MySQL operation was blocked by a lock or deadlock",
        ErrorCategory::Timeout => "the MySQL operation timed out",
        ErrorCategory::Connection | ErrorCategory::Transport => {
            "the MySQL server could not be reached"
        }
        _ => "the MySQL operation failed",
    }
}

/// Maps a driver error onto the normalized error model.
///
/// `engine_detail` carries the driver's own message for diagnostics. The
/// password is never part of a driver message because it is only supplied
/// through [`OptsBuilder::pass`]; connection ids and engine messages are safe.
fn map_error(error: mysql::Error) -> QueryError {
    match error {
        mysql::Error::MySqlError(server) => {
            let category = categorize_mysql(server.code, &server.state);
            QueryError::new(category, safe_failure_message(category))
                .with_code(server.code.to_string())
                .with_engine_detail(server.message)
        }
        mysql::Error::DriverError(driver) => {
            let category = categorize_driver_error(&driver);
            QueryError::new(category, safe_failure_message(category))
                .with_engine_detail(driver.to_string())
        }
        mysql::Error::IoError(ref io) => {
            QueryError::new(ErrorCategory::Connection, safe_failure_message(ErrorCategory::Connection))
                .with_engine_detail(io.to_string())
        }
        mysql::Error::CodecError(ref codec) => QueryError::new(
            ErrorCategory::Connection,
            safe_failure_message(ErrorCategory::Connection),
        )
        .with_engine_detail(codec.to_string()),
        mysql::Error::TlsError(ref tls) => QueryError::new(
            ErrorCategory::Connection,
            "the MySQL TLS handshake failed",
        )
        .with_engine_detail(tls.to_string()),
        other @ (mysql::Error::UrlError(_)
        | mysql::Error::FromValueError(_)
        | mysql::Error::FromRowError(_)) => QueryError::new(
            ErrorCategory::Internal,
            "the MySQL driver could not process the request",
        )
        .with_engine_detail(other.to_string()),
    }
}

/// Normalized category for a driver-level (non-server) error.
fn categorize_driver_error(error: &mysql::DriverError) -> ErrorCategory {
    match error {
        mysql::DriverError::Timeout | mysql::DriverError::ConnectTimeout => ErrorCategory::Timeout,
        mysql::DriverError::ReadOnlyTransNotSupported => ErrorCategory::Configuration,
        mysql::DriverError::CouldNotConnect(_)
        | mysql::DriverError::SetupError
        | mysql::DriverError::PacketOutOfSync
        | mysql::DriverError::PacketTooLarge
        | mysql::DriverError::UnexpectedPacket
        | mysql::DriverError::UnsupportedProtocol(_)
        | mysql::DriverError::Protocol41NotSet
        | mysql::DriverError::TlsNotSupported => ErrorCategory::Connection,
        _ => ErrorCategory::Internal,
    }
}

/// Normalized column metadata for a MySQL result column.
fn column_info(column: &Column) -> ColumnInfo {
    ColumnInfo {
        name: column.name_str().into_owned(),
        type_name: Some(column_type_name(column.column_type())),
        nullable: Some(!column.flags().contains(ColumnFlags::NOT_NULL_FLAG)),
    }
}

/// Whether a result column carries binary data (BLOB/BINARY vs TEXT).
fn column_is_binary(column: &Column) -> bool {
    column.character_set() == BINARY_CHARSET_ID
}

/// Short engine type name for a column, for example `LONG` or `VAR_STRING`.
fn column_type_name(column_type: ColumnType) -> String {
    let raw = format!("{column_type:?}");
    raw.strip_prefix("MYSQL_TYPE_").unwrap_or(&raw).to_string()
}

/// Maps a MySQL `table_constraints.constraint_type` value onto a normalized kind.
fn mysql_constraint_kind(constraint_type: &str) -> Option<ConstraintKind> {
    if constraint_type.eq_ignore_ascii_case("PRIMARY KEY") {
        Some(ConstraintKind::PrimaryKey)
    } else if constraint_type.eq_ignore_ascii_case("FOREIGN KEY") {
        Some(ConstraintKind::ForeignKey)
    } else if constraint_type.eq_ignore_ascii_case("UNIQUE") {
        Some(ConstraintKind::Unique)
    } else if constraint_type.eq_ignore_ascii_case("CHECK") {
        Some(ConstraintKind::Check)
    } else {
        None
    }
}

/// Converts a normalized cell value into a bound MySQL parameter.
fn cell_to_value(value: &CellValue) -> Value {
    match value {
        CellValue::Null => Value::NULL,
        // MySQL has no boolean type; the conventional TINYINT(1) is stored.
        CellValue::Boolean(value) => Value::Int(i64::from(*value)),
        CellValue::Integer(value) => Value::Int(*value),
        CellValue::Float(value) => Value::Double(*value),
        // Exact numerics and text bind as bytes; the server coerces to the
        // target column type without the adapter losing precision first.
        CellValue::Decimal(value) => Value::Bytes(value.clone().into_bytes()),
        CellValue::Text(value) => Value::Bytes(value.clone().into_bytes()),
        CellValue::Bytes(value) => Value::Bytes(value.clone()),
    }
}

/// Converts a driver value into a normalized cell value.
fn cell_from_value(value: Value, binary: bool) -> CellValue {
    match value {
        Value::NULL => CellValue::Null,
        Value::Int(value) => CellValue::Integer(value),
        Value::UInt(value) => match i64::try_from(value) {
            Ok(signed) => CellValue::Integer(signed),
            // Larger than i64; keep the exact value as text.
            Err(_) => CellValue::Decimal(value.to_string()),
        },
        Value::Float(value) => CellValue::Float(f64::from(value)),
        Value::Double(value) => CellValue::Float(value),
        Value::Bytes(bytes) => {
            if binary {
                CellValue::Bytes(bytes)
            } else {
                // MySQL text protocol encodes all text as bytes.
                CellValue::Text(String::from_utf8_lossy(&bytes).into_owned())
            }
        }
        Value::Date(year, month, day, hour, minute, second, micros) => {
            let mut text =
                format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}");
            if micros > 0 {
                text.push_str(&format!(".{micros:06}"));
            }
            CellValue::Text(text)
        }
        Value::Time(negative, days, hours, minutes, seconds, micros) => {
            let sign = if negative { "-" } else { "" };
            let total_hours = days * 24 + u32::from(hours);
            let mut text = format!("{sign}{total_hours:02}:{minutes:02}:{seconds:02}");
            if micros > 0 {
                text.push_str(&format!(".{micros:06}"));
            }
            CellValue::Text(text)
        }
    }
}

/// Converts one driver row into normalized cells using the result's column kinds.
fn row_to_cells(values: Vec<Value>, binary_columns: &[bool]) -> Row {
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            cell_from_value(value, binary_columns.get(index).copied().unwrap_or(false))
        })
        .collect()
}

/// Resolves the database to use for metadata queries.
///
/// Preference order: the explicit scope, the connection's default database, then
/// the session's current database. Reports a validation error when none exist so
/// the UI can ask for a scope instead of guessing.
fn resolve_database(
    handle: &mut Conn,
    default: Option<&str>,
    requested: Option<&str>,
) -> Result<String, QueryError> {
    if let Some(database) = requested.map(str::trim).filter(|name| !name.is_empty()) {
        return Ok(database.to_string());
    }
    if let Some(database) = default.map(str::trim).filter(|name| !name.is_empty()) {
        return Ok(database.to_string());
    }

    let current: Option<Option<String>> = handle.query_first("SELECT DATABASE()").map_err(map_error)?;
    if let Some(database) = current.flatten().filter(|name| !name.is_empty()) {
        return Ok(database);
    }

    Err(QueryError::new(
        ErrorCategory::Validation,
        "a MySQL database is required for this operation",
    ))
}

/// Whole milliseconds elapsed since `started`, saturating instead of wrapping.
fn elapsed_millis(started: Instant) -> u64 {
    let millis = started.elapsed().as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

/// Executes one statement on an open handle and normalizes the outcome.
///
/// Completed outcomes (including a failed preparation or step) come back as a
/// [`QueryResult`] so the caller can render the state and error. The wrapper
/// always reports a duration, even for failures.
fn run_statement(handle: &mut Conn, request: &QueryRequest) -> QueryResult {
    let started = Instant::now();
    let mut result = match execute_statement(handle, request) {
        Ok(result) => result,
        Err(error) => QueryResult::failed(request.operation_id.clone(), error),
    };
    result.duration_ms = Some(elapsed_millis(started));
    result
}

/// Prepares and runs a statement, returning a successful normalized result.
///
/// A statement with no bound parameters uses the text protocol, which accepts
/// more statement forms (for example `SHOW`), while parameterized statements use
/// the binary protocol so caller values are always bound. Caller text is never
/// concatenated into the statement.
fn execute_statement(
    handle: &mut Conn,
    request: &QueryRequest,
) -> Result<QueryResult, QueryError> {
    let cap = request
        .max_rows
        .unwrap_or(MAX_RESULT_ROWS)
        .min(MAX_RESULT_ROWS) as usize;

    if request.parameters.is_empty() {
        let result = handle.query_iter(&request.sql).map_err(map_error)?;
        collect_result(result, request.operation_id.clone(), cap)
    } else {
        let parameters: Vec<Value> = request.parameters.iter().map(cell_to_value).collect();
        let result = handle
            .exec_iter(&request.sql, parameters)
            .map_err(map_error)?;
        collect_result(result, request.operation_id.clone(), cap)
    }
}

/// Consumes a driver result set into the normalized [`QueryResult`] shape.
///
/// The generic over the protocol lets the text and binary paths share one
/// implementation. Non-row statements report their affected-row count; row
/// statements report columns and rows and leave `affected_rows` unset.
fn collect_result<T: Protocol>(
    mut result: mysql::QueryResult<'_, '_, '_, T>,
    operation_id: OperationId,
    cap: usize,
) -> Result<QueryResult, QueryError> {
    let binary_columns: Vec<bool> = result
        .columns()
        .as_ref()
        .iter()
        .map(column_is_binary)
        .collect();
    let columns: Vec<ColumnInfo> = result.columns().as_ref().iter().map(column_info).collect();
    let is_row_statement = !columns.is_empty();
    let affected_rows = result.affected_rows();

    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(row) = result.next() {
        let row = row.map_err(map_error)?;
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        rows.push(row_to_cells(row.unwrap(), &binary_columns));
    }

    let mut normalized = QueryResult::succeeded(operation_id);
    normalized.columns = columns;
    normalized.rows = rows;
    normalized.truncated = truncated;
    if !is_row_statement {
        normalized.affected_rows = Some(affected_rows);
    }
    Ok(normalized)
}

/// Reads a MySQL object's columns and primary key in ordinal/key order.
///
/// The database and table names are bound values in the `information_schema`
/// predicates, never interpolated. A missing table or view is a validation
/// error; a view reports columns with no primary key.
fn mysql_table_shape(
    handle: &mut Conn,
    database: &str,
    object_name: &str,
) -> Result<(Vec<ColumnInfo>, Vec<String>), QueryError> {
    let rows: Vec<(String, String, String)> = handle
        .exec(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE \
             FROM information_schema.columns \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION",
            (database, object_name),
        )
        .map_err(map_error)?;

    if rows.is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!("`{object_name}` is not a table or view in this MySQL database"),
        ));
    }

    let mut columns = Vec::with_capacity(rows.len());
    for (name, column_type, is_nullable) in rows {
        let nullable = match is_nullable.as_str() {
            "YES" => Some(true),
            "NO" => Some(false),
            _ => None,
        };
        columns.push(ColumnInfo {
            name,
            type_name: Some(column_type),
            nullable,
        });
    }

    let keys: Vec<(String,)> = handle
        .exec(
            "SELECT COLUMN_NAME FROM information_schema.key_column_usage \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
            (database, object_name),
        )
        .map_err(map_error)?;
    let primary_key_columns: Vec<String> = keys.into_iter().map(|(name,)| name).collect();

    Ok((columns, primary_key_columns))
}

/// Fetches one bounded, filtered, sorted page from a MySQL table or view.
///
/// The table reference is qualified with the resolved database and quoted with
/// backticks. Filters/sorts are validated against the object's columns and their
/// values are bound through the binary protocol. The primary key, when present,
/// is appended to the ordering and reported as `row_identity`.
fn fetch_mysql_page(
    handle: &mut Conn,
    default_database: Option<&str>,
    request: TablePageRequest,
) -> Result<TablePage, QueryError> {
    let limit = effective_table_page_limit(request.limit)?;
    let database = resolve_database(handle, default_database, request.object.database.as_deref())?;
    let (columns, row_identity) = mysql_table_shape(handle, &database, &request.object.name)?;
    let order = effective_sort_order(&request.sort, &row_identity);
    let from = format!(
        "{}.{}",
        quote_identifier_backtick(&database),
        quote_identifier_backtick(&request.object.name)
    );

    // Ask for one row beyond the page so the loop below can tell whether a
    // further page exists without a separate COUNT, which could scan the whole
    // relation. The extra row is never returned; it only sets `truncated`.
    let (sql, values) = build_table_page_query(
        &from,
        &columns,
        &request.filters,
        &order,
        limit.saturating_add(1),
        request.offset,
        |_| "?".to_string(),
        quote_identifier_backtick,
    )?;

    // Fetch one extra row to learn whether another page exists without a
    // separate COUNT, which could scan the whole relation.
    let parameters: Vec<Value> = values.iter().map(cell_to_value).collect();
    let mut result = handle.exec_iter(&sql, parameters).map_err(map_error)?;
    let binary_columns: Vec<bool> = result
        .columns()
        .as_ref()
        .iter()
        .map(column_is_binary)
        .collect();

    let mut rows: Vec<Row> = Vec::new();
    let mut truncated = false;
    while let Some(row) = result.next() {
        let row = row.map_err(map_error)?;
        if rows.len() >= limit as usize {
            truncated = true;
            break;
        }
        rows.push(row_to_cells(row.unwrap(), &binary_columns));
    }

    let next_offset = if truncated {
        Some(request.offset + rows.len() as u64)
    } else {
        None
    };

    Ok(TablePage {
        operation_id: request.operation_id,
        columns,
        rows,
        row_identity,
        offset: request.offset,
        limit,
        total_rows: None,
        truncated,
        next_offset,
    })
}

/// Executes a generated parameterized DML statement and reports affected rows.
fn execute_change(handle: &mut Conn, sql: &str, bound: &[CellValue]) -> Result<u64, QueryError> {
    let parameters: Vec<Value> = bound.iter().map(cell_to_value).collect();
    let result = handle.exec_iter(sql, parameters).map_err(map_error)?;
    Ok(result.affected_rows())
}

/// Applies one staged change to a MySQL base table.
///
/// Views are rejected because they have no safe row identity. Updates and
/// deletes require an identity that matches the primary key exactly; a statement
/// that affects no row is returned as a conflict, never a zero-row success.
fn apply_mysql_change(
    handle: &mut Conn,
    default_database: Option<&str>,
    request: ChangeRequest,
) -> Result<ChangeResult, QueryError> {
    if request.object.kind != ObjectKind::Table {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!(
                "`{}` is not a base table and cannot be modified",
                request.object.name
            ),
        ));
    }

    let database = resolve_database(handle, default_database, request.object.database.as_deref())?;
    let (columns, primary_key) = mysql_table_shape(handle, &database, &request.object.name)?;
    let from = format!(
        "{}.{}",
        quote_identifier_backtick(&database),
        quote_identifier_backtick(&request.object.name)
    );
    let operation_id = request.operation_id.clone();

    let (sql, bound, conflict) = match request.change {
        PendingChange::Insert { values } => {
            let (sql, bound) = build_insert_statement(
                &from,
                &columns,
                &values,
                |_| "?".to_string(),
                quote_identifier_backtick,
            )?;
            (sql, bound, None)
        }
        PendingChange::Update { identity, values } => {
            validate_row_identity(&primary_key, &identity)?;
            let conflict = conflict_columns(&identity);
            let (sql, bound) = build_update_statement(
                &from,
                &columns,
                &identity,
                &values,
                |_| "?".to_string(),
                quote_identifier_backtick,
            )?;
            (sql, bound, Some(conflict))
        }
        PendingChange::Delete { identity } => {
            validate_row_identity(&primary_key, &identity)?;
            let conflict = conflict_columns(&identity);
            let (sql, bound) = build_delete_statement(
                &from,
                &columns,
                &identity,
                |_| "?".to_string(),
                quote_identifier_backtick,
            )?;
            (sql, bound, Some(conflict))
        }
    };

    match execute_change(handle, &sql, &bound) {
        Ok(affected) => {
            if affected == 0 {
                if let Some(conflict) = conflict {
                    return Ok(ChangeResult::conflict(operation_id, conflict));
                }
            }
            Ok(ChangeResult::applied(operation_id, affected))
        }
        Err(error) if error.category.may_have_unknown_outcome() => {
            Ok(ChangeResult::outcome_unknown(operation_id))
        }
        Err(error) => Ok(ChangeResult::failed(operation_id, error)),
    }
}

/// Executes a generated DDL statement, discarding any result set.
fn execute_mysql_ddl(handle: &mut Conn, sql: &str) -> Result<(), QueryError> {
    handle.query_drop(sql).map_err(map_error)
}

/// Renders a validated MySQL column definition for `CREATE`/`ALTER ... ADD`.
fn render_mysql_column(column: &ColumnDefinition) -> Result<String, QueryError> {
    let name = column.name.trim();
    require_identifier(name, "column")?;
    validate_type_name(&column.type_name)?;

    let mut sql = format!(
        "{} {}",
        quote_identifier_backtick(name),
        column.type_name.trim()
    );
    if !column.nullable {
        sql.push_str(" NOT NULL");
    }
    if let Some(default) = &column.default {
        validate_default_expression(name, default)?;
        sql.push_str(" DEFAULT ");
        sql.push_str(default.trim());
    }
    Ok(sql)
}

/// Whether `columns` contains `name`, ignoring ASCII case.
fn mysql_has_column(columns: &[ColumnInfo], name: &str) -> bool {
    let target = name.trim();
    columns
        .iter()
        .any(|column| column.name.eq_ignore_ascii_case(target))
}

/// Fully-qualified, backtick-quoted table reference for the resolved database.
fn mysql_qualified(database: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_identifier_backtick(database),
        quote_identifier_backtick(table)
    )
}

/// Renders a validated MySQL foreign-key clause.
fn render_mysql_foreign_key(
    handle: &mut Conn,
    database: &str,
    local_columns: &[ColumnInfo],
    foreign_key: &ForeignKeyDefinition,
) -> Result<String, QueryError> {
    if foreign_key.columns.is_empty()
        || foreign_key.columns.len() != foreign_key.referenced_columns.len()
    {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "a foreign key must pair the same number of local and referenced columns",
        ));
    }
    if foreign_key.referenced_table.trim().is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "a foreign key must name a referenced table",
        ));
    }
    for column in &foreign_key.columns {
        if !mysql_has_column(local_columns, column) {
            return Err(QueryError::new(
                ErrorCategory::Validation,
                format!("foreign key names unknown column `{column}`"),
            ));
        }
    }

    // MySQL treats a schema as a database, so a referenced schema names the
    // database to reference; it defaults to the table's own database.
    let ref_database = foreign_key
        .referenced_schema
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(database);
    let ref_table = foreign_key.referenced_table.trim();
    let (ref_columns, _) = mysql_table_shape(handle, ref_database, ref_table)?;
    for column in &foreign_key.referenced_columns {
        if !mysql_has_column(&ref_columns, column) {
            return Err(QueryError::new(
                ErrorCategory::Validation,
                format!("foreign key references unknown column `{column}` on `{ref_table}`"),
            ));
        }
    }

    let locals = foreign_key
        .columns
        .iter()
        .map(|column| quote_identifier_backtick(column.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let referenced = foreign_key
        .referenced_columns
        .iter()
        .map(|column| quote_identifier_backtick(column.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let target = mysql_qualified(ref_database, ref_table);

    Ok(
        match foreign_key
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => format!(
                "CONSTRAINT {} FOREIGN KEY ({locals}) REFERENCES {target} ({referenced})",
                quote_identifier_backtick(name)
            ),
            None => {
                format!("FOREIGN KEY ({locals}) REFERENCES {target} ({referenced})")
            }
        },
    )
}

/// Creates a table and returns a description built from the validated definition.
fn create_mysql_table(
    handle: &mut Conn,
    default_database: Option<&str>,
    definition: &TableDefinition,
) -> Result<TableDescription, QueryError> {
    if definition.object.kind != ObjectKind::Table {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "only base tables can be created",
        ));
    }
    let database =
        resolve_database(handle, default_database, definition.object.database.as_deref())?;
    let table = definition.object.name.trim();
    require_identifier(table, "table")?;
    if definition.columns.is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "a table definition requires at least one column",
        ));
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut primary_key: Option<String> = None;
    let mut pieces: Vec<String> = Vec::with_capacity(
        definition.columns.len() + 1 + definition.foreign_keys.len(),
    );
    let mut columns_info: Vec<ColumnInfo> = Vec::with_capacity(definition.columns.len());

    for column in &definition.columns {
        let name = column.name.trim();
        require_identifier(name, "column")?;
        if !seen.insert(name.to_ascii_lowercase()) {
            return Err(QueryError::new(
                ErrorCategory::Validation,
                format!("table `{table}` defines column `{name}` more than once"),
            ));
        }
        if column.primary_key {
            if primary_key.is_some() {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    "a table may have at most one primary-key column in this slice",
                ));
            }
            primary_key = Some(name.to_string());
        }
        pieces.push(render_mysql_column(column)?);
        columns_info.push(ColumnInfo {
            name: name.to_string(),
            type_name: Some(column.type_name.trim().to_string()),
            nullable: Some(column.nullable),
        });
    }

    for foreign_key in &definition.foreign_keys {
        pieces.push(render_mysql_foreign_key(
            handle,
            &database,
            &columns_info,
            foreign_key,
        )?);
    }
    if let Some(primary_key) = &primary_key {
        pieces.push(format!(
            "PRIMARY KEY ({})",
            quote_identifier_backtick(primary_key)
        ));
    }

    let sql = format!(
        "CREATE TABLE {} ({})",
        mysql_qualified(&database, table),
        pieces.join(", ")
    );
    execute_mysql_ddl(handle, &sql)?;

    Ok(TableDescription::new(
        columns_info,
        primary_key.into_iter().collect(),
    ))
}

/// Drops a base table, honoring `cascade` where the engine accepts it.
fn drop_mysql_table(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    cascade: bool,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    require_identifier(&object.name, "table")?;
    let suffix = if cascade { " CASCADE" } else { "" };
    let sql = format!(
        "DROP TABLE {}{suffix}",
        mysql_qualified(&database, object.name.trim())
    );
    execute_mysql_ddl(handle, &sql)
}

/// Adds a column to an existing table.
fn add_mysql_column(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    column: &ColumnDefinition,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let (columns, _) = mysql_table_shape(handle, &database, &object.name)?;
    let name = column.name.trim();
    require_identifier(name, "column")?;
    if mysql_has_column(&columns, name) {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!("table `{}` already has a column `{name}`", object.name),
        ));
    }
    if column.primary_key {
        return Err(unsupported_error(
            "MySQL cannot add a primary-key column to an existing table in this slice",
        ));
    }
    let definition = render_mysql_column(column)?;
    let sql = format!(
        "ALTER TABLE {} ADD COLUMN {definition}",
        mysql_qualified(&database, &object.name)
    );
    execute_mysql_ddl(handle, &sql)
}

/// Renames a column on an existing table (MySQL 8 `RENAME COLUMN`).
fn rename_mysql_column(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    from: &str,
    to: &str,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let (columns, _) = mysql_table_shape(handle, &database, &object.name)?;
    let from = from.trim();
    let to = to.trim();
    require_identifier(from, "column")?;
    require_identifier(to, "column")?;
    if !mysql_has_column(&columns, from) {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!("table `{}` has no column `{from}`", object.name),
        ));
    }
    if mysql_has_column(&columns, to) && !from.eq_ignore_ascii_case(to) {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!("table `{}` already has a column `{to}`", object.name),
        ));
    }
    let sql = format!(
        "ALTER TABLE {} RENAME COLUMN {} TO {}",
        mysql_qualified(&database, &object.name),
        quote_identifier_backtick(from),
        quote_identifier_backtick(to)
    );
    execute_mysql_ddl(handle, &sql)
}

/// Drops a column from an existing table.
fn drop_mysql_column(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    column: &str,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let (columns, _) = mysql_table_shape(handle, &database, &object.name)?;
    let column = column.trim();
    require_identifier(column, "column")?;
    if !mysql_has_column(&columns, column) {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!("table `{}` has no column `{column}`", object.name),
        ));
    }
    let sql = format!(
        "ALTER TABLE {} DROP COLUMN {}",
        mysql_qualified(&database, &object.name),
        quote_identifier_backtick(column)
    );
    execute_mysql_ddl(handle, &sql)
}

/// Adds a foreign-key constraint to an existing table.
fn add_mysql_foreign_key(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    foreign_key: &ForeignKeyDefinition,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let (columns, _) = mysql_table_shape(handle, &database, &object.name)?;
    let clause = render_mysql_foreign_key(handle, &database, &columns, foreign_key)?;
    let sql = format!(
        "ALTER TABLE {} ADD {clause}",
        mysql_qualified(&database, &object.name)
    );
    execute_mysql_ddl(handle, &sql)
}

/// Drops a named foreign-key constraint from an existing table.
fn drop_mysql_foreign_key(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    name: &str,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let name = name.trim();
    require_identifier(name, "constraint")?;
    let sql = format!(
        "ALTER TABLE {} DROP FOREIGN KEY {}",
        mysql_qualified(&database, &object.name),
        quote_identifier_backtick(name)
    );
    execute_mysql_ddl(handle, &sql)
}

/// Creates an index on one or more validated columns of a table.
fn create_mysql_index(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    name: &str,
    columns: &[String],
    unique: bool,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let (table_columns, _) = mysql_table_shape(handle, &database, &object.name)?;
    let name = name.trim();
    require_identifier(name, "index")?;
    if columns.is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "an index requires at least one column",
        ));
    }
    let mut quoted = Vec::with_capacity(columns.len());
    for column in columns {
        let column = column.trim();
        if !mysql_has_column(&table_columns, column) {
            return Err(QueryError::new(
                ErrorCategory::Validation,
                format!("index names unknown column `{column}`"),
            ));
        }
        quoted.push(quote_identifier_backtick(column));
    }
    let unique = if unique { "UNIQUE " } else { "" };
    let sql = format!(
        "CREATE {unique}INDEX {} ON {} ({})",
        quote_identifier_backtick(name),
        mysql_qualified(&database, &object.name),
        quoted.join(", ")
    );
    execute_mysql_ddl(handle, &sql)
}

/// Drops an index by name from its table.
fn drop_mysql_index(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    name: &str,
) -> Result<(), QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let name = name.trim();
    require_identifier(name, "index")?;
    let sql = format!(
        "DROP INDEX {} ON {}",
        quote_identifier_backtick(name),
        mysql_qualified(&database, &object.name)
    );
    execute_mysql_ddl(handle, &sql)
}

/// Counts a table's rows with the same validated filter clause as paging.
fn count_mysql_rows(
    handle: &mut Conn,
    default_database: Option<&str>,
    object: &ObjectRef,
    filters: &[TableFilter],
) -> Result<u64, QueryError> {
    let database = resolve_database(handle, default_database, object.database.as_deref())?;
    let (columns, _) = mysql_table_shape(handle, &database, &object.name)?;
    let (where_clause, values) = build_filter_clause(
        filters,
        &columns,
        |_| "?".to_string(),
        quote_identifier_backtick,
    )?;

    let mut sql = format!("SELECT COUNT(*) FROM {}", mysql_qualified(&database, &object.name));
    if !where_clause.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clause);
    }

    let parameters: Vec<Value> = values.iter().map(cell_to_value).collect();
    let count: Option<i64> = handle.exec_first(&sql, parameters).map_err(map_error)?;
    Ok(count.unwrap_or(0).max(0) as u64)
}

impl DatabaseAdapter for MySqlAdapter {
    fn engine(&self) -> EngineId {
        EngineId::MySql
    }

    fn capabilities(&self) -> EngineCapabilities {
        // This adapter implements connect/disconnect, metadata inspection, SQL
        // execution, guarded staged writes, and explicit transactions over
        // TLS-capable connections. MySQL treats a database as its schema, so
        // `schemas` stays `false` while `multiple_databases` reflects the
        // database picker `list_scopes` feeds. MySQL performs an implicit commit
        // around DDL, so `ddl_transactions` is `false`.
        EngineCapabilities {
            transactions: true,
            ddl_transactions: false,
            savepoints: false,
            cancellation: false,
            schemas: false,
            multiple_databases: true,
            tls: true,
        }
    }

    fn test_connection<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionTest, QueryError>> {
        Box::pin(async move {
            let server = mysql_server(descriptor)?;
            let opts = build_opts(server, secret)?;
            let mut handle = Conn::new(opts).map_err(map_error)?;
            let version: Option<String> =
                handle.query_first("SELECT VERSION()").map_err(map_error)?;
            // The handle is dropped here; `test_connection` must not retain it.
            Ok(ConnectionTest {
                engine: EngineId::MySql,
                server_version: version,
            })
        })
    }

    fn list_databases<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<Vec<String>, QueryError>> {
        Box::pin(async move {
            let server = mysql_server(descriptor)?;
            let opts = build_opts(server, secret)?;
            let mut handle = Conn::new(opts).map_err(map_error)?;
            // Server-level listing: opens an ephemeral connection (no database
            // selected) and filters the engine's own schemas so a picker shows
            // only user databases. The handle is dropped at the end of the block.
            let rows: Vec<(String,)> = handle
                .exec(
                    "SELECT SCHEMA_NAME FROM information_schema.schemata \
                     WHERE SCHEMA_NAME NOT IN \
                     ('information_schema', 'mysql', 'performance_schema', 'sys') \
                     ORDER BY SCHEMA_NAME",
                    (),
                )
                .map_err(map_error)?;
            Ok(rows.into_iter().map(|(name,)| name).collect())
        })
    }

    fn connect<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionId, QueryError>> {
        Box::pin(async move {
            let default_database = mysql_server(descriptor)?.database.clone();
            let handle = open_writable(descriptor, secret)?;

            let sequence = self.next_connection.fetch_add(1, Ordering::SeqCst) + 1;
            let connection = ConnectionId::new(format!("mysql-{sequence}"));

            self.connection_map().insert(
                connection.clone(),
                Arc::new(Mutex::new(ConnectionSlot {
                    state: ConnectionState::Connected,
                    handle: Some(handle),
                    default_database,
                    open_transactions: HashSet::new(),
                })),
            );

            Ok(connection)
        })
    }

    fn disconnect<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let mut slot = slot
                .lock()
                .expect("MySQL connection state must not be poisoned");
            slot.state = ConnectionState::Disconnected;
            slot.handle = None;
            slot.open_transactions.clear();
            Ok(())
        })
    }

    fn connection_state<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ConnectionState, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let slot = slot
                .lock()
                .expect("MySQL connection state must not be poisoned");
            Ok(slot.state)
        })
    }

    fn list_objects<'a>(
        &'a self,
        connection: &'a ConnectionId,
        scope: &'a ObjectScope,
    ) -> AdapterFuture<'a, Result<Vec<ObjectRef>, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, default_database| {
                let database =
                    resolve_database(handle, default_database, scope.database.as_deref())?;
                let rows: Vec<(String, String)> = handle
                    .exec(
                        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables \
                         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                        (database.as_str(),),
                    )
                    .map_err(map_error)?;

                let mut objects = Vec::with_capacity(rows.len());
                for (name, table_type) in rows {
                    let kind = if table_type.eq_ignore_ascii_case("VIEW") {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    };
                    objects.push(ObjectRef {
                        database: Some(database.clone()),
                        schema: None,
                        name,
                        kind,
                    });
                }
                Ok(objects)
            })
        })
    }

    fn list_scopes<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ScopeListing, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, _default_database| {
                // MySQL exposes databases (a synonym for schemas) on one
                // connection; there is no separate schema namespace.
                let rows: Vec<(String,)> = handle
                    .exec(
                        "SELECT SCHEMA_NAME FROM information_schema.schemata ORDER BY SCHEMA_NAME",
                        (),
                    )
                    .map_err(map_error)?;

                Ok(ScopeListing {
                    databases: rows.into_iter().map(|(name,)| name).collect(),
                    schemas: Vec::new(),
                })
            })
        })
    }

    fn describe_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
    ) -> AdapterFuture<'a, Result<TableDescription, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, default_database| {
                let database =
                    resolve_database(handle, default_database, object.database.as_deref())?;

                let (columns, primary_key_columns) =
                    mysql_table_shape(handle, &database, &object.name)?;

                // Indexes: `statistics` lists one row per index key part, so the
                // rows are grouped by index name in index-key order. Functional
                // key parts report a `NULL` column name; `COALESCE` keeps the
                // slot rather than dropping it from the width.
                let index_rows: Vec<(String, i64, String)> = handle
                    .exec(
                        "SELECT INDEX_NAME, NON_UNIQUE, COALESCE(COLUMN_NAME, '<expression>') \
                         FROM information_schema.statistics \
                         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
                        (database.as_str(), object.name.as_str()),
                    )
                    .map_err(map_error)?;
                let mut indexes: Vec<IndexInfo> = Vec::new();
                for (name, non_unique, column) in index_rows {
                    if let Some(last) = indexes.last_mut() {
                        if last.name == name {
                            last.columns.push(column);
                            continue;
                        }
                    }
                    let primary = name == "PRIMARY";
                    indexes.push(IndexInfo::new(name, vec![column], non_unique == 0, primary));
                }

                // Constraints: `table_constraints` joined to `key_column_usage`
                // supplies the constrained columns and, for foreign keys, the
                // referenced target. CHECK constraints contribute no key columns.
                let constraint_rows: Vec<(
                    String,
                    String,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                )> = handle
                    .exec(
                        "SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, \
                                kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, \
                                kcu.REFERENCED_COLUMN_NAME \
                         FROM information_schema.table_constraints tc \
                         LEFT JOIN information_schema.key_column_usage kcu \
                           ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
                          AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
                          AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA \
                          AND kcu.TABLE_NAME = tc.TABLE_NAME \
                         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? \
                         ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
                        (database.as_str(), object.name.as_str()),
                    )
                    .map_err(map_error)?;

                let mut constraints: Vec<ConstraintInfo> = Vec::new();
                for (name, constraint_type, column, ref_schema, ref_table, ref_column) in
                    constraint_rows
                {
                    let Some(kind) = mysql_constraint_kind(&constraint_type) else {
                        continue;
                    };
                    if let Some(last) = constraints.last_mut() {
                        if last.name == name {
                            if let Some(column) = column {
                                last.columns.push(column);
                            }
                            if let Some(ref_column) = ref_column {
                                last.referenced_columns.push(ref_column);
                            }
                            continue;
                        }
                    }
                    let mut constraint = match kind {
                        ConstraintKind::ForeignKey => ConstraintInfo::foreign_key(
                            name.clone(),
                            Vec::new(),
                            ref_schema.clone(),
                            ref_table.clone().unwrap_or_default(),
                            Vec::new(),
                        ),
                        other => ConstraintInfo::of_kind(name.clone(), other, Vec::new()),
                    };
                    if let Some(column) = column {
                        constraint.columns.push(column);
                    }
                    if let Some(ref_column) = ref_column {
                        constraint.referenced_columns.push(ref_column);
                    }
                    constraints.push(constraint);
                }

                Ok(TableDescription::new(columns, primary_key_columns)
                    .with_indexes(indexes)
                    .with_constraints(constraints))
            })
        })
    }

    fn fetch_table_page<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: TablePageRequest,
    ) -> AdapterFuture<'a, Result<TablePage, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                fetch_mysql_page(handle, database, request)
            })
        })
    }

    fn execute<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: QueryRequest,
    ) -> AdapterFuture<'a, Result<QueryResult, QueryError>> {
        Box::pin(async move {
            if request.sql.trim().is_empty() {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    "the SQL statement is empty",
                ));
            }

            self.with_connection(connection, |handle, _database| {
                Ok(run_statement(handle, &request))
            })
        })
    }

    fn apply_change<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: ChangeRequest,
    ) -> AdapterFuture<'a, Result<ChangeResult, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                apply_mysql_change(handle, database, request)
            })
        })
    }

    fn create_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        definition: &'a TableDefinition,
    ) -> AdapterFuture<'a, Result<TableDescription, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                create_mysql_table(handle, database, definition)
            })
        })
    }

    fn drop_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        cascade: bool,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                drop_mysql_table(handle, database, object, cascade)
            })
        })
    }

    fn add_column<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        column: &'a ColumnDefinition,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                add_mysql_column(handle, database, object, column)
            })
        })
    }

    fn rename_column<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        from: &'a str,
        to: &'a str,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                rename_mysql_column(handle, database, object, from, to)
            })
        })
    }

    fn drop_column<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        column: &'a str,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                drop_mysql_column(handle, database, object, column)
            })
        })
    }

    fn add_foreign_key<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        foreign_key: &'a ForeignKeyDefinition,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                add_mysql_foreign_key(handle, database, object, foreign_key)
            })
        })
    }

    fn drop_foreign_key<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        name: &'a str,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                drop_mysql_foreign_key(handle, database, object, name)
            })
        })
    }

    fn create_index<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        name: &'a str,
        columns: &'a [String],
        unique: bool,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                create_mysql_index(handle, database, object, name, columns, unique)
            })
        })
    }

    fn drop_index<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        name: &'a str,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                drop_mysql_index(handle, database, object, name)
            })
        })
    }

    fn count_table_rows<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
        filters: &'a [TableFilter],
    ) -> AdapterFuture<'a, Result<u64, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle, database| {
                count_mysql_rows(handle, database, object, filters)
            })
        })
    }

    fn cancel<'a>(
        &'a self,
        _connection: &'a ConnectionId,
        _operation: &'a OperationId,
    ) -> AdapterFuture<'a, Result<CancelOutcome, QueryError>> {
        Box::pin(async move {
            Err(unsupported_error(
                "the MySQL driver does not support query cancellation in this slice",
            ))
        })
    }

    fn begin_transaction<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<TransactionId, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let mut slot = slot
                .lock()
                .expect("MySQL connection state must not be poisoned");
            {
                if !matches!(slot.state, ConnectionState::Connected) {
                    return Err(connection_error(connection));
                }
                let Some(handle) = slot.handle.as_mut() else {
                    return Err(connection_error(connection));
                };
                handle
                    .query_drop("START TRANSACTION")
                    .map_err(map_error)?;
            }
            let sequence = self.next_transaction.fetch_add(1, Ordering::SeqCst) + 1;
            let id = TransactionId::new(format!("mysql-tx-{sequence}"));
            slot.open_transactions.insert(id.clone());
            Ok(id)
        })
    }

    fn commit<'a>(
        &'a self,
        connection: &'a ConnectionId,
        transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let mut slot = slot
                .lock()
                .expect("MySQL connection state must not be poisoned");
            if !slot.open_transactions.contains(transaction) {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!("transaction `{transaction}` is not open"),
                ));
            }
            {
                if !matches!(slot.state, ConnectionState::Connected) {
                    return Err(connection_error(connection));
                }
                let Some(handle) = slot.handle.as_mut() else {
                    return Err(connection_error(connection));
                };
                handle.query_drop("COMMIT").map_err(map_error)?;
            }
            slot.open_transactions.remove(transaction);
            Ok(())
        })
    }

    fn rollback<'a>(
        &'a self,
        connection: &'a ConnectionId,
        transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let mut slot = slot
                .lock()
                .expect("MySQL connection state must not be poisoned");
            if !slot.open_transactions.contains(transaction) {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!("transaction `{transaction}` is not open"),
                ));
            }
            {
                if !matches!(slot.state, ConnectionState::Connected) {
                    return Err(connection_error(connection));
                }
                let Some(handle) = slot.handle.as_mut() else {
                    return Err(connection_error(connection));
                };
                handle.query_drop("ROLLBACK").map_err(map_error)?;
            }
            slot.open_transactions.remove(transaction);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{
        build_opts, categorize_mysql, cell_from_value, cell_to_value, mysql_server, ssl_opts_for,
        MySqlAdapter,
    };
    use crate::database::{ConnectionId, ConnectionSecret, DatabaseAdapter};
    use crate::domain::connection::{ServerConnection, TlsMode};
    use crate::domain::{
        CellValue, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory, QueryRequest,
    };
    use mysql::Value;

    /// Minimal executor for the immediately-ready futures the adapter returns.
    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn server(tls: TlsMode) -> ServerConnection {
        ServerConnection {
            host: "db.example.com".to_string(),
            port: 3307,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls,
        }
    }

    #[test]
    fn engine_and_capabilities_report_only_the_implemented_slice() {
        let adapter = MySqlAdapter::new();

        assert_eq!(adapter.engine(), EngineId::MySql);
        assert_eq!(
            adapter.capabilities(),
            EngineCapabilities {
                transactions: true,
                ddl_transactions: false,
                savepoints: false,
                cancellation: false,
                schemas: false,
                multiple_databases: true,
                tls: true,
            }
        );
    }

    #[test]
    fn non_mysql_descriptors_are_rejected_before_connecting() {
        let descriptor = ConnectionDescriptor::Sqlite(
            crate::domain::connection::SqliteConnection {
                file_path: "C:/data/app.sqlite".to_string(),
            },
        );

        let error = mysql_server(&descriptor).expect_err("a SQLite descriptor must be rejected");
        assert_eq!(error.category, ErrorCategory::Configuration);

        let adapter = MySqlAdapter::new();
        let error = block_on(adapter.test_connection(&descriptor, None))
            .expect_err("the adapter must reject another engine before I/O");
        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn build_opts_translates_descriptor_fields() {
        let descriptor = server(TlsMode::Disabled);
        let opts = build_opts(&descriptor, None).expect("valid settings should build options");

        assert_eq!(opts.get_ip_or_hostname(), "db.example.com");
        assert_eq!(opts.get_tcp_port(), 3307);
        assert_eq!(opts.get_user(), Some("app_user"));
        assert_eq!(opts.get_db_name(), Some("app"));
        assert!(opts.get_ssl_opts().is_none());
        // The named-pipe preference must be off so the host/port are addressed.
        assert!(!opts.get_prefer_socket());
    }

    #[test]
    fn build_opts_forwards_a_secret_without_exposing_it_elsewhere() {
        let descriptor = server(TlsMode::Disabled);
        let secret = ConnectionSecret::new("test-only-value");
        let opts = build_opts(&descriptor, Some(&secret)).expect("options should build");

        assert!(opts.get_pass().is_some());
    }

    #[test]
    fn build_opts_rejects_blank_hosts_and_zero_ports() {
        let mut blank = server(TlsMode::Disabled);
        blank.host = "   ".to_string();
        assert_eq!(
            build_opts(&blank, None).expect_err("blank host must fail").category,
            ErrorCategory::Configuration
        );

        let mut zero_port = server(TlsMode::Disabled);
        zero_port.port = 0;
        assert_eq!(
            build_opts(&zero_port, None)
                .expect_err("zero port must fail")
                .category,
            ErrorCategory::Configuration
        );
    }

    #[test]
    fn tls_modes_select_driver_ssl_options() {
        assert!(ssl_opts_for(TlsMode::Disabled).is_none());

        let preferred = ssl_opts_for(TlsMode::Preferred).expect("preferred should request TLS");
        assert!(preferred.accept_invalid_certs());
        assert!(preferred.skip_domain_validation());

        let required = ssl_opts_for(TlsMode::Required).expect("required should request TLS");
        assert!(required.accept_invalid_certs());

        let verify_ca = ssl_opts_for(TlsMode::VerifyCa).expect("verify_ca should request TLS");
        assert!(!verify_ca.accept_invalid_certs());
        assert!(verify_ca.skip_domain_validation());

        let verify_full =
            ssl_opts_for(TlsMode::VerifyFull).expect("verify_full should request TLS");
        assert!(!verify_full.accept_invalid_certs());
        assert!(!verify_full.skip_domain_validation());
    }

    #[test]
    fn server_error_codes_map_to_normalized_categories() {
        let cases = [
            (1045, "28000", ErrorCategory::Authentication),
            (1142, "42000", ErrorCategory::Permission),
            (1290, "HY000", ErrorCategory::Permission),
            (1062, "23000", ErrorCategory::Constraint),
            (1213, "40001", ErrorCategory::Locking),
            (1064, "42000", ErrorCategory::Syntax),
            (1146, "42S02", ErrorCategory::Validation),
            (9999, "08001", ErrorCategory::Connection),
            (9999, "22007", ErrorCategory::Validation),
        ];

        for (code, state, expected) in cases {
            assert_eq!(categorize_mysql(code, state), expected, "code {code}");
        }
    }

    #[test]
    fn cell_values_convert_both_directions() {
        assert_eq!(cell_to_value(&CellValue::Null), Value::NULL);
        assert_eq!(cell_to_value(&CellValue::Boolean(true)), Value::Int(1));
        assert_eq!(cell_to_value(&CellValue::Integer(42)), Value::Int(42));
        assert_eq!(cell_to_value(&CellValue::Float(1.5)), Value::Double(1.5));
        assert_eq!(
            cell_to_value(&CellValue::Decimal("12.50".to_string())),
            Value::Bytes(b"12.50".to_vec())
        );

        assert_eq!(cell_from_value(Value::NULL, false), CellValue::Null);
        assert_eq!(cell_from_value(Value::Int(-3), false), CellValue::Integer(-3));
        assert_eq!(cell_from_value(Value::UInt(3), false), CellValue::Integer(3));
        assert_eq!(
            cell_from_value(Value::Bytes(b"hello".to_vec()), false),
            CellValue::Text("hello".to_string())
        );
        assert_eq!(
            cell_from_value(Value::Bytes(vec![0, 159, 146, 150]), true),
            CellValue::Bytes(vec![0, 159, 146, 150])
        );
        assert_eq!(
            cell_from_value(Value::UInt(u64::MAX), false),
            CellValue::Decimal(u64::MAX.to_string())
        );
        assert_eq!(
            cell_from_value(Value::Date(2024, 5, 6, 7, 8, 9, 0), false),
            CellValue::Text("2024-05-06 07:08:09".to_string())
        );
    }

    #[test]
    fn unknown_connections_are_connection_errors_without_a_server() {
        let adapter = MySqlAdapter::new();
        let unknown = ConnectionId::new("does-not-exist");

        assert_eq!(
            block_on(adapter.connection_state(&unknown))
                .expect_err("unknown state must fail")
                .category,
            ErrorCategory::Connection
        );
        assert_eq!(
            block_on(adapter.disconnect(&unknown))
                .expect_err("unknown disconnect must fail")
                .category,
            ErrorCategory::Connection
        );
        assert_eq!(
            block_on(adapter.execute(
                &unknown,
                QueryRequest::new("op", "SELECT 1"),
            ))
            .expect_err("unknown execute must fail")
            .category,
            ErrorCategory::Connection
        );
    }

    #[test]
    fn execute_rejects_blank_sql_before_touching_the_connection() {
        let adapter = MySqlAdapter::new();
        let unknown = ConnectionId::new("does-not-exist");

        let error = block_on(adapter.execute(&unknown, QueryRequest::new("op-blank", "   ")))
            .expect_err("blank SQL is a precondition failure");
        assert_eq!(error.category, ErrorCategory::Validation);
        assert_eq!(
            block_on(adapter.connection_state(&unknown))
                .expect_err("state remains unknown")
                .category,
            ErrorCategory::Connection
        );
    }

    #[test]
    fn a_fresh_adapter_is_disconnected_and_exposes_guarded_writes() {
        let adapter = MySqlAdapter::new();
        let unknown = ConnectionId::new("missing");

        // Guarded writes and paging are implemented; with an unknown token the
        // connection error still takes precedence for a live operation.
        assert!(
            adapter.capabilities().transactions,
            "explicit transactions are implemented"
        );
        assert_eq!(
            block_on(adapter.cancel(&unknown, &crate::domain::OperationId::new("op")))
                .expect_err("cancellation is unsupported")
                .category,
            ErrorCategory::Unsupported
        );
    }
}

/// Integration tests that only run when a disposable MySQL server is configured.
///
/// Set `DBTABLES_MYSQL_TEST_HOST` (and optionally `_PORT`, `_DATABASE`, `_USER`,
/// `_PASSWORD`, `_TLS`) to enable them. When the host is absent every test
/// returns early, so the default `cargo test` run needs no server. No test prints
/// a password.
#[cfg(test)]
mod integration_tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{mysql_has_column, mysql_qualified, render_mysql_column, MySqlAdapter};
    use crate::database::{
        ColumnDefinition, ConnectionId, ConnectionSecret, ConnectionState, DatabaseAdapter,
        ObjectScope,
    };
    use crate::domain::connection::{ServerConnection, TlsMode};
    use crate::domain::{
        ConnectionDescriptor, EngineId, ErrorCategory, OperationState, QueryRequest,
    };

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn env_value(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    /// Returns the configured descriptor and secret, or `None` to skip.
    fn configured() -> Option<(ConnectionDescriptor, Option<ConnectionSecret>)> {
        let host = env_value("DBTABLES_MYSQL_TEST_HOST")?;
        let port = env_value("DBTABLES_MYSQL_TEST_PORT")
            .and_then(|value| value.parse().ok())
            .unwrap_or(3306);
        let tls = match env_value("DBTABLES_MYSQL_TEST_TLS").as_deref() {
            Some("preferred") => TlsMode::Preferred,
            Some("required") => TlsMode::Required,
            Some("verify_ca") => TlsMode::VerifyCa,
            Some("verify_full") => TlsMode::VerifyFull,
            _ => TlsMode::Disabled,
        };
        let server = ServerConnection {
            host,
            port,
            database: env_value("DBTABLES_MYSQL_TEST_DATABASE"),
            username: env_value("DBTABLES_MYSQL_TEST_USER").unwrap_or_else(|| "root".to_string()),
            tls,
        };
        let secret = env_value("DBTABLES_MYSQL_TEST_PASSWORD").map(ConnectionSecret::new);
        Some((ConnectionDescriptor::MySql(server), secret))
    }

    #[test]
    fn connect_lists_metadata_and_runs_a_query() {
        let Some((descriptor, secret)) = configured() else {
            return;
        };
        let adapter = MySqlAdapter::new();

        let test = block_on(adapter.test_connection(&descriptor, secret.as_ref()))
            .expect("test connection should succeed");
        assert_eq!(test.engine, EngineId::MySql);

        let connection = block_on(adapter.connect(&descriptor, secret.as_ref()))
            .expect("connect should succeed");
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("state should resolve"),
            ConnectionState::Connected
        );

        let scopes = block_on(adapter.list_scopes(&connection)).expect("scopes should list");
        assert!(!scopes.databases.is_empty());

        let scope = if let Some(database) = descriptor.server().and_then(|s| s.database.clone()) {
            ObjectScope {
                database: Some(database),
                schema: None,
            }
        } else {
            ObjectScope {
                database: scopes.databases.first().cloned(),
                schema: None,
            }
        };
        let objects = block_on(adapter.list_objects(&connection, &scope))
            .expect("object listing should succeed");
        if let Some(first) = objects.first() {
            let description = block_on(adapter.describe_table(&connection, first))
                .expect("description should succeed");
            assert!(!description.columns.is_empty());
        }

        let selected = block_on(adapter.execute(
            &connection,
            QueryRequest::new("it-select", "SELECT 1 AS one"),
        ))
        .expect("select should return a result");
        assert_eq!(selected.state, OperationState::Succeeded);
        assert_eq!(selected.rows.len(), 1);

        let invalid = block_on(adapter.execute(
            &connection,
            QueryRequest::new("it-invalid", "SELECT FROM WHERE"),
        ))
        .expect("invalid SQL still produces a result");
        assert_eq!(invalid.state, OperationState::Failed);
        assert_eq!(
            invalid.error.expect("failure should carry an error").category,
            ErrorCategory::Syntax
        );

        block_on(adapter.disconnect(&connection)).expect("disconnect should succeed");
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("state should resolve"),
            ConnectionState::Disconnected
        );
    }

    #[test]
    fn bad_credentials_are_reported_as_authentication_failures() {
        let Some((descriptor, _secret)) = configured() else {
            return;
        };
        let adapter = MySqlAdapter::new();
        let wrong = ConnectionSecret::new("definitely-not-the-password");

        let error = block_on(adapter.test_connection(&descriptor, Some(&wrong)))
            .expect_err("bad credentials must fail");
        assert_eq!(error.category, ErrorCategory::Authentication);

        let unknown = ConnectionId::new("never-opened");
        assert_eq!(
            block_on(adapter.connection_state(&unknown))
                .expect_err("unknown connection must fail")
                .category,
            ErrorCategory::Connection
        );
    }

    #[test]
    fn render_mysql_column_quotes_names_and_rejects_unsafe_text() {
        let mut column = ColumnDefinition::new("n`ame", "VARCHAR(255)");
        column.nullable = false;
        column.default = Some("CURRENT_TIMESTAMP".to_string());
        assert_eq!(
            render_mysql_column(&column).expect("valid column"),
            "`n``ame` VARCHAR(255) NOT NULL DEFAULT CURRENT_TIMESTAMP"
        );

        let unsafe_default = ColumnDefinition {
            default: Some("0; DROP TABLE users".to_string()),
            ..ColumnDefinition::new("status", "INTEGER")
        };
        assert_eq!(
            render_mysql_column(&unsafe_default)
                .expect_err("unsafe default must fail")
                .category,
            ErrorCategory::Validation
        );

        let unsafe_type = ColumnDefinition::new("x", "INTEGER; DROP TABLE users");
        assert_eq!(
            render_mysql_column(&unsafe_type)
                .expect_err("unsafe type must fail")
                .category,
            ErrorCategory::Validation
        );
    }

    #[test]
    fn mysql_qualified_and_column_matching_are_exact_enough() {
        assert_eq!(mysql_qualified("app", "users"), "`app`.`users`");

        let columns = vec![crate::domain::ColumnInfo {
            name: "Id".to_string(),
            type_name: Some("INTEGER".to_string()),
            nullable: Some(false),
        }];
        assert!(mysql_has_column(&columns, "id"));
        assert!(!mysql_has_column(&columns, "name"));
    }
}
