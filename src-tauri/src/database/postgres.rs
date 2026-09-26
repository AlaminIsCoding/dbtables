//! Read-only PostgreSQL adapter backed by `tokio-postgres`.
//!
//! This module implements the metadata and query half of the shared
//! [`DatabaseAdapter`] contract for PostgreSQL servers:
//!
//! - Test a server connection, open one, report state, and disconnect.
//! - List the schemas a connection exposes (PostgreSQL's scope model) and the
//!   base tables and views in a schema, describing their columns and primary
//!   key from `information_schema`.
//! - Execute a single SQL statement and return a normalized, capped result with
//!   column metadata, rows, affected-row count, duration, and structured errors.
//! - Fetch bounded, filtered, sorted pages of a table or view, reporting the
//!   primary key as a safe row identity when the object has one.
//!
//! Table paging is implemented; staged changes arrive in a later task and report
//! [`ErrorCategory::Unsupported`] until then, so no write path is exposed and
//! [`Self::capabilities`] reports only what the adapter can honor today.
//!
//! PostgreSQL semantics differ from MySQL in ways this adapter represents
//! rather than hides:
//!
//! - A connection is bound to a single database. `list_scopes` reports schemas
//!   and never databases, and asking an operation to address another database
//!   returns [`ErrorCategory::Unsupported`] with an explanation.
//! - Result objects carry `schema` but not `database`, matching the scope
//!   picker the UI can present for this engine.
//! - Parameters use the driver's native `$1`, `$2`, ... placeholders; the
//!   adapter never rewrites SQL text. Values are bound in text format so exact
//!   numerics and temporal values survive without a separate conversion crate.
//!
//! Design rules:
//!
//! - The session is switched to read-only after connecting with
//!   `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, so a statement
//!   issued through this connection cannot mutate the database. A rejected write
//!   fails at the server with a normalized permission error.
//! - Parameters supplied with a request are bound as parameters; caller text is
//!   never concatenated into the statement. Object/schema names are always bound
//!   values in `information_schema` predicates, never interpolated.
//! - Driver-native [`tokio_postgres::Client`] handles never leave this module.
//!   Callers receive opaque, serializable [`ConnectionId`] tokens.
//! - Credentials enter only through [`ConnectionSecret`] and are placed in the
//!   driver options; they are never added to errors, logs, or the connection id.
//!
//! **Driver decision:** the asynchronous `tokio-postgres` client is used instead
//! of the synchronous `postgres` crate or SQLx. The synchronous wrapper embeds a
//! private tokio runtime and panics when a blocking call is made from inside the
//! application's async command runtime, so it cannot back an async adapter.
//! SQLx would add a pool/query-macro layer the adapter does not need yet.
//! `tokio-postgres` maps directly onto the adapter's async boundary, streams
//! results so the row cap bounds memory, and takes TLS through `native-tls`
//! (SChannel on Windows), matching the MySQL adapter's provider.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt;
use std::fmt::Write as _;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::{BufMut, BytesMut};
use futures_util::TryStreamExt;
use postgres_types::{Format, FromSql, IsNull, ToSql, Type};
use tokio::sync::Mutex as AsyncMutex;
use tokio_postgres::config::SslMode;
use tokio_postgres::tls::{MakeTlsConnect, TlsConnect};
use tokio_postgres::{Client, Column, Config, NoTls, Socket};

use crate::database::{
    build_table_page_query, effective_sort_order, effective_table_page_limit, quote_identifier,
    AdapterFuture, CancelOutcome, ChangeRequest, ChangeResult, ConnectionId, ConnectionSecret,
    ConnectionState, ConnectionTest, ConstraintInfo, ConstraintKind, DatabaseAdapter, IndexInfo,
    ObjectKind, ObjectRef, ObjectScope, ScopeListing, TableDescription, TablePage,
    TablePageRequest, TransactionId,
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

/// Microseconds in one day, used when decoding `date`/`timestamp` values.
const MICROS_PER_DAY: i64 = 86_400_000_000;

/// Days from the Unix epoch (1970-01-01) to the PostgreSQL epoch (2000-01-01).
const POSTGRES_EPOCH_DAYS: i64 = 10_957;

/// State and driver handle for one open connection.
struct ConnectionSlot {
    state: ConnectionState,
    client: Option<Client>,
    /// Database the connection is bound to, as reported by the server.
    database: String,
    /// Default schema for the session's `search_path`, when one resolves.
    default_schema: Option<String>,
}

/// PostgreSQL adapter implementing the shared database boundary.
///
/// The adapter owns all [`tokio_postgres::Client`] handles for its lifetime.
/// Each is addressed through an opaque [`ConnectionId`] so no driver object can
/// cross the Tauri IPC boundary. Each connection has its own async lock, so a
/// long-running statement on one connection does not block another.
pub struct PostgresAdapter {
    connections: Mutex<HashMap<ConnectionId, Arc<AsyncMutex<ConnectionSlot>>>>,
    next_connection: AtomicU64,
}

impl Default for PostgresAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl PostgresAdapter {
    /// Creates an adapter with no open connections.
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(0),
        }
    }

    fn connection_map(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<ConnectionId, Arc<AsyncMutex<ConnectionSlot>>>> {
        self.connections
            .lock()
            .expect("PostgreSQL adapter connection state poisoned")
    }

    /// Resolves the per-connection slot or reports an unknown-token error.
    fn connection_slot(
        &self,
        connection: &ConnectionId,
    ) -> Result<Arc<AsyncMutex<ConnectionSlot>>, QueryError> {
        self.connection_map()
            .get(connection)
            .cloned()
            .ok_or_else(|| connection_error(connection))
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

/// Error for a request/field/value that failed validation.
fn validation_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Validation, message)
}

/// Borrows the open client for a connected slot or reports a connection error.
fn connected_client<'a>(
    slot: &'a ConnectionSlot,
    connection: &ConnectionId,
) -> Result<&'a Client, QueryError> {
    match (&slot.state, slot.client.as_ref()) {
        (ConnectionState::Connected, Some(client)) => Ok(client),
        _ => Err(connection_error(connection)),
    }
}

/// Extracts the server settings from a PostgreSQL descriptor.
fn postgres_server(descriptor: &ConnectionDescriptor) -> Result<&ServerConnection, QueryError> {
    match descriptor {
        ConnectionDescriptor::Postgres(server) => Ok(server),
        other => Err(configuration_error(format!(
            "the PostgreSQL adapter cannot serve a {} connection",
            other.engine()
        ))),
    }
}

/// Maps a requested TLS mode onto the driver's SSL negotiation mode.
///
/// The connector used at the same time decides certificate/hostname
/// verification; see [`tls_connector`].
fn ssl_mode_for(mode: TlsMode) -> SslMode {
    match mode {
        TlsMode::Disabled => SslMode::Disable,
        // Prefer attempts TLS and falls back to plaintext when the server
        // declines; Required and the verifying modes never fall back.
        TlsMode::Preferred => SslMode::Prefer,
        TlsMode::Required | TlsMode::VerifyCa | TlsMode::VerifyFull => SslMode::Require,
    }
}

/// Builds a `native-tls` connector with the requested verification behavior.
///
/// `verify_certificates` and `verify_hostname` follow the same intent as the
/// descriptor's [`TlsMode`]. The certificate chain is only checked when
/// `verify_certificates` is `true`; the host name is only checked when both
/// flags are `true` (checking a host name without a trusted chain is pointless).
fn tls_connector(
    verify_certificates: bool,
    verify_hostname: bool,
) -> Result<postgres_native_tls::MakeTlsConnector, QueryError> {
    let mut builder = native_tls::TlsConnector::builder();
    builder.danger_accept_invalid_certs(!verify_certificates);
    builder.danger_accept_invalid_hostnames(!verify_hostname);
    let connector = builder.build().map_err(|error| {
        configuration_error(format!(
            "the PostgreSQL TLS configuration is invalid: {error}"
        ))
    })?;
    Ok(postgres_native_tls::MakeTlsConnector::new(connector))
}

/// Builds driver configuration from a descriptor and its resolved secret.
///
/// The password is taken from [`ConnectionSecret`] and never added anywhere
/// else. Host/port are validated so a blank host fails before any I/O.
fn build_config(
    server: &ServerConnection,
    secret: Option<&ConnectionSecret>,
) -> Result<Config, QueryError> {
    let host = server.host.trim();
    if host.is_empty() {
        return Err(configuration_error("a PostgreSQL host is required"));
    }
    if server.port == 0 {
        return Err(configuration_error("a PostgreSQL port is required"));
    }

    let mut config = Config::new();
    config.host(host);
    config.port(server.port);
    config.user(server.username.as_str());
    if let Some(secret) = secret {
        if !secret.is_empty() {
            config.password(secret.expose());
        }
    }
    if let Some(database) = server
        .database
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        config.dbname(database);
    }
    config.application_name("dbtables");
    config.ssl_mode(ssl_mode_for(server.tls));
    config.connect_timeout(CONNECT_TIMEOUT);
    Ok(config)
}

/// Opens a connection and drives its protocol task on the caller's runtime.
///
/// The connection future must be polled for the client to make progress; it is
/// spawned onto the current runtime and the handle is dropped. A connection
/// that ends leaves later operations reporting a normalized connection error,
/// and is never retried automatically.
async fn connect_with_tls<T>(config: &Config, tls: T) -> Result<Client, QueryError>
where
    T: MakeTlsConnect<Socket> + Send + 'static,
    T::TlsConnect: Send,
    T::Stream: Send + 'static,
    <T::TlsConnect as TlsConnect<Socket>>::Future: Send,
{
    let (client, connection) = config.connect(tls).await.map_err(map_error)?;
    tokio::spawn(async move {
        // The failure is surfaced by the next operation; it is deliberately not
        // logged so no connection detail can reach a log sink.
        let _ = connection.await;
    });
    Ok(client)
}

/// Opens a read-only connection and captures its default scope.
///
/// `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` makes every
/// subsequent transaction (including autocommit statements) reject writes, so a
/// raw write statement fails at the server rather than mutating data.
async fn open_read_only(
    server: &ServerConnection,
    secret: Option<&ConnectionSecret>,
) -> Result<(Client, String, Option<String>), QueryError> {
    let config = build_config(server, secret)?;
    let client = match server.tls {
        TlsMode::Disabled => connect_with_tls(&config, NoTls).await?,
        TlsMode::Preferred | TlsMode::Required => {
            connect_with_tls(&config, tls_connector(false, false)?).await?
        }
        TlsMode::VerifyCa => connect_with_tls(&config, tls_connector(true, false)?).await?,
        TlsMode::VerifyFull => connect_with_tls(&config, tls_connector(true, true)?).await?,
    };

    client
        .batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        .await
        .map_err(map_error)?;

    let row = client
        .query_one("SELECT current_database(), current_schema()", &[])
        .await
        .map_err(map_error)?;
    let database: String = row.try_get(0).map_err(map_error)?;
    let default_schema: Option<String> = row.try_get(1).map_err(map_error)?;

    Ok((client, database, default_schema))
}

/// Confirms a requested database scope matches the connected database.
///
/// A PostgreSQL connection cannot address another database, so a mismatched
/// request is surfaced instead of silently ignored.
fn ensure_scope_database(current: &str, requested: Option<&str>) -> Result<(), QueryError> {
    if let Some(requested) = requested.map(str::trim).filter(|name| !name.is_empty()) {
        if requested != current {
            return Err(unsupported_error(format!(
                "a PostgreSQL connection is bound to database `{current}`; `{requested}` cannot be addressed on this connection"
            )));
        }
    }
    Ok(())
}

/// Resolves the schema for a metadata operation.
///
/// Preference order: the explicit request, then the session's default schema.
/// Reports a validation error when neither exists so the UI can ask for a
/// schema instead of guessing.
fn resolve_schema(
    default_schema: Option<&str>,
    requested: Option<&str>,
) -> Result<String, QueryError> {
    if let Some(schema) = requested.map(str::trim).filter(|name| !name.is_empty()) {
        return Ok(schema.to_string());
    }
    default_schema
        .map(str::to_string)
        .ok_or_else(|| validation_error("a PostgreSQL schema is required for this operation"))
}

/// Whole milliseconds elapsed since `started`, saturating instead of wrapping.
fn elapsed_millis(started: Instant) -> u64 {
    let millis = started.elapsed().as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

/// Normalized category for a PostgreSQL SQLSTATE code.
fn categorize_sqlstate(code: &str) -> ErrorCategory {
    // Bounded so a short/malformed code cannot panic on slicing.
    let class = &code[..code.len().min(2)];
    match code {
        // Writing through a read-only session; the adapter treats this as the
        // engine confirming the operation is not permitted.
        "25006" => ErrorCategory::Permission,
        // insufficient_privilege.
        "42501" => ErrorCategory::Permission,
        // syntax_error.
        "42601" => ErrorCategory::Syntax,
        // query_canceled.
        "57014" => ErrorCategory::Cancelled,
        // feature_not_supported.
        "0A000" => ErrorCategory::Unsupported,
        // too_many_connections.
        "53300" => ErrorCategory::Connection,
        _ => match class {
            "28" => ErrorCategory::Authentication,
            "23" => ErrorCategory::Constraint,
            "08" => ErrorCategory::Connection,
            "40" => ErrorCategory::Locking,
            "55" => ErrorCategory::Locking,
            "57" => ErrorCategory::Connection,
            "22" | "25" | "3D" | "3F" | "42" => ErrorCategory::Validation,
            _ => ErrorCategory::Internal,
        },
    }
}

/// Safe, user-facing summary for a normalized category.
///
/// The raw server message is preserved separately in `engine_detail`; this text
/// stays generic so it never needs to include a host, role, or credential.
fn safe_failure_message(category: ErrorCategory) -> &'static str {
    match category {
        ErrorCategory::Authentication => "the PostgreSQL server rejected the credentials",
        ErrorCategory::Permission => {
            "the PostgreSQL role does not have permission for this operation"
        }
        ErrorCategory::Configuration => "the PostgreSQL connection configuration is invalid",
        ErrorCategory::Syntax => "the SQL statement has a syntax error",
        ErrorCategory::Validation => "the PostgreSQL statement could not be executed",
        ErrorCategory::Constraint => "a PostgreSQL constraint was violated",
        ErrorCategory::Locking => "the PostgreSQL operation was blocked by a lock or deadlock",
        ErrorCategory::Timeout => "the PostgreSQL operation timed out",
        ErrorCategory::Cancelled => "the PostgreSQL operation was cancelled",
        ErrorCategory::Connection | ErrorCategory::Transport => {
            "the PostgreSQL server could not be reached"
        }
        ErrorCategory::Unsupported => "this PostgreSQL operation is not supported",
        _ => "the PostgreSQL operation failed",
    }
}

/// Maps a driver error onto the normalized error model.
///
/// `engine_detail` carries the driver's own message for diagnostics. The
/// password never appears in a driver message because it is only supplied
/// through [`Config::password`]; connection ids and engine messages are safe.
fn map_error(error: tokio_postgres::Error) -> QueryError {
    if let Some(db) = error.as_db_error() {
        let code = db.code().code();
        let category = categorize_sqlstate(code);
        return QueryError::new(category, safe_failure_message(category))
            .with_code(code)
            .with_engine_detail(db.message());
    }

    let category = categorize_driver_error(&error);
    QueryError::new(category, safe_failure_message(category))
        .with_engine_detail(driver_detail(&error))
}

/// Normalized category for a driver-level (non-server) error.
///
/// The driver's error kinds are private, so a downcastable cause is inspected
/// first and its stable display text is used only as a fallback.
fn categorize_driver_error(error: &tokio_postgres::Error) -> ErrorCategory {
    if error.is_closed() {
        return ErrorCategory::Connection;
    }

    if let Some(io) = error
        .source()
        .and_then(|source| source.downcast_ref::<std::io::Error>())
    {
        return match io.kind() {
            std::io::ErrorKind::TimedOut => ErrorCategory::Timeout,
            _ => ErrorCategory::Connection,
        };
    }

    if error
        .source()
        .and_then(|source| source.downcast_ref::<native_tls::Error>())
        .is_some()
    {
        return ErrorCategory::Connection;
    }

    let text = error.to_string();
    if text.contains("authentication") {
        ErrorCategory::Authentication
    } else if text.contains("timeout") {
        ErrorCategory::Timeout
    } else if text.contains("invalid configuration") || text.contains("invalid connection string") {
        ErrorCategory::Configuration
    } else if text.contains("parameter") {
        ErrorCategory::Validation
    } else if text.contains("TLS") || text.contains("connection") || text.contains("server") {
        ErrorCategory::Connection
    } else {
        ErrorCategory::Internal
    }
}

/// Driver diagnostics for a non-server error, including its cause when present.
fn driver_detail(error: &tokio_postgres::Error) -> String {
    match error.source() {
        Some(source) => format!("{error}: {source}"),
        None => error.to_string(),
    }
}

/// Normalized column metadata for a PostgreSQL result column.
///
/// PostgreSQL reports a type per expression but not its nullability, so
/// `nullable` stays `None` rather than being guessed.
fn column_info(column: &Column) -> ColumnInfo {
    ColumnInfo {
        name: column.name().to_string(),
        type_name: Some(column.type_().name().to_string()),
        nullable: None,
    }
}

/// Maps an `information_schema.table_constraints.constraint_type` onto a kind.
fn postgres_constraint_kind(constraint_type: &str) -> Option<ConstraintKind> {
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

/// Executes one statement on an open client and normalizes the outcome.
///
/// Completed outcomes (including a failed preparation or step) come back as a
/// [`QueryResult`] so the caller can render the state and error. The wrapper
/// always reports a duration, even for failures.
async fn run_statement(client: &Client, request: &QueryRequest) -> QueryResult {
    let started = Instant::now();
    let mut result = match execute_statement(client, request).await {
        Ok(result) => result,
        Err(error) => QueryResult::failed(request.operation_id.clone(), error),
    };
    result.duration_ms = Some(elapsed_millis(started));
    result
}

/// Prepares and runs a single statement, returning a successful normalized result.
///
/// A statement with no result columns reports its affected-row count; a row
/// statement streams rows and stops at the cap. Caller text is never
/// concatenated into the statement.
async fn execute_statement(
    client: &Client,
    request: &QueryRequest,
) -> Result<QueryResult, QueryError> {
    let cap = request
        .max_rows
        .unwrap_or(MAX_RESULT_ROWS)
        .min(MAX_RESULT_ROWS) as usize;

    let statement = client.prepare(&request.sql).await.map_err(map_error)?;

    let parameters: Vec<PgParameter> = request
        .parameters
        .iter()
        .cloned()
        .map(PgParameter)
        .collect();
    let parameter_refs: Vec<&(dyn ToSql + Sync)> = parameters
        .iter()
        .map(|parameter| parameter as &(dyn ToSql + Sync))
        .collect();

    if statement.columns().is_empty() {
        let affected = client
            .execute(&statement, &parameter_refs)
            .await
            .map_err(map_error)?;
        let mut result = QueryResult::succeeded(request.operation_id.clone());
        result.affected_rows = Some(affected);
        return Ok(result);
    }

    let columns: Vec<ColumnInfo> = statement.columns().iter().map(column_info).collect();

    let mut rows: Vec<Row> = Vec::new();
    let mut truncated = false;
    let mut stream = std::pin::pin!(client
        .query_raw(&statement, parameter_refs.iter().copied())
        .await
        .map_err(map_error)?);
    while let Some(row) = stream.try_next().await.map_err(map_error)? {
        if rows.len() >= cap {
            truncated = true;
            break;
        }
        rows.push(row_to_cells(&row)?);
    }

    let mut normalized = QueryResult::succeeded(request.operation_id.clone());
    normalized.columns = columns;
    normalized.rows = rows;
    normalized.truncated = truncated;
    Ok(normalized)
}

/// Converts one driver row into normalized cells.
fn row_to_cells(row: &tokio_postgres::Row) -> Result<Row, QueryError> {
    let mut cells = Vec::with_capacity(row.len());
    for index in 0..row.len() {
        let value: Option<PgCellValue> = row.try_get(index).map_err(map_error)?;
        cells.push(value.map(|cell| cell.0).unwrap_or(CellValue::Null));
    }
    Ok(cells)
}

/// A bound query parameter encoded in PostgreSQL's text format.
///
/// Every value is sent as text so exact numerics and temporal text survive
/// without a conversion crate, and the server's input functions coerce the
/// value to whatever type it inferred for the placeholder. Debug output is
/// redacted so driver debug logging cannot persist parameter values.
struct PgParameter(CellValue);

impl fmt::Debug for PgParameter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PgParameter([redacted])")
    }
}

impl ToSql for PgParameter {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn StdError + Sync + Send>> {
        match &self.0 {
            CellValue::Null => Ok(IsNull::Yes),
            value => {
                out.put_slice(cell_text(value).as_bytes());
                Ok(IsNull::No)
            }
        }
    }

    fn accepts(_ty: &Type) -> bool {
        // The server decides the placeholder's type; any value serializes as
        // text and is coerced by that type's input function.
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    postgres_types::to_sql_checked!();
}

/// Text representation of a cell value for parameter binding.
fn cell_text(value: &CellValue) -> String {
    match value {
        CellValue::Null => String::new(),
        CellValue::Boolean(value) => {
            if *value {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        CellValue::Integer(value) => value.to_string(),
        CellValue::Float(value) => format_float(*value),
        CellValue::Decimal(value) => value.clone(),
        CellValue::Text(value) => value.clone(),
        CellValue::Bytes(value) => bytea_text(value),
    }
}

/// Formats a float so non-finite values match PostgreSQL's input spellings.
fn format_float(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value == f64::INFINITY {
        "Infinity".to_string()
    } else if value == f64::NEG_INFINITY {
        "-Infinity".to_string()
    } else {
        value.to_string()
    }
}

/// Encodes bytes as PostgreSQL's `bytea` hex text format.
fn bytea_text(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("\\x");
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

/// A decoded result cell that accepts every PostgreSQL type.
struct PgCellValue(CellValue);

impl<'a> FromSql<'a> for PgCellValue {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        let value = match *ty {
            Type::BOOL => CellValue::Boolean(bool::from_sql(ty, raw)?),
            Type::INT2 => CellValue::Integer(i64::from(i16::from_sql(ty, raw)?)),
            Type::INT4 => CellValue::Integer(i64::from(i32::from_sql(ty, raw)?)),
            Type::INT8 => CellValue::Integer(i64::from_sql(ty, raw)?),
            Type::FLOAT4 => CellValue::Float(f64::from(f32::from_sql(ty, raw)?)),
            Type::FLOAT8 => CellValue::Float(f64::from_sql(ty, raw)?),
            Type::OID => CellValue::Integer(i64::from(u32::from_sql(ty, raw)?)),
            Type::NUMERIC => CellValue::Decimal(decode_numeric(raw)?),
            Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::CHAR | Type::UNKNOWN => {
                CellValue::Text(decode_text(raw))
            }
            Type::BYTEA => CellValue::Bytes(Vec::<u8>::from_sql(ty, raw)?),
            Type::DATE => CellValue::Text(format_date(raw)?),
            Type::TIME => CellValue::Text(format_time(read_i64(raw)?, false)),
            Type::TIMESTAMP => CellValue::Text(format_timestamp(read_i64(raw)?, false)),
            Type::TIMESTAMPTZ => CellValue::Text(format_timestamp(read_i64(raw)?, true)),
            Type::INTERVAL => CellValue::Text(format_interval(raw)?),
            Type::UUID => CellValue::Text(format_uuid(raw)?),
            Type::JSON => CellValue::Text(decode_text(raw)),
            Type::JSONB => CellValue::Text(decode_jsonb(raw)?),
            Type::INET => CellValue::Text(IpAddr::from_sql(ty, raw)?.to_string()),
            ref other => fallback_cell(other, raw),
        };
        Ok(PgCellValue(value))
    }

    fn accepts(_ty: &Type) -> bool {
        // Every type is accepted; the decoder chooses a representation and
        // falls back to text/bytes rather than failing the whole result.
        true
    }
}

/// Decodes a UTF-8 text value, replacing invalid sequences rather than failing.
fn decode_text(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).into_owned()
}

/// Renders an unknown/custom type honestly: UTF-8 labels as text (enums), and
/// anything else as its raw bytes instead of a fabricated value.
fn fallback_cell(ty: &Type, raw: &[u8]) -> CellValue {
    let _ = ty;
    match std::str::from_utf8(raw) {
        Ok(text) => CellValue::Text(text.to_string()),
        Err(_) => CellValue::Bytes(raw.to_vec()),
    }
}

/// Builds a boxed conversion error carrying a safe message.
fn invalid_value(message: impl Into<String>) -> Box<dyn StdError + Sync + Send> {
    message.into().into()
}

/// Reads a big-endian `int2` from a binary value.
fn read_i16(raw: &[u8]) -> Result<i16, Box<dyn StdError + Sync + Send>> {
    match raw {
        [first, second] => Ok(i16::from_be_bytes([*first, *second])),
        _ => Err(invalid_value("a PostgreSQL 16-bit value is truncated")),
    }
}

/// Reads a big-endian `int4` from a binary value.
fn read_i32(raw: &[u8]) -> Result<i32, Box<dyn StdError + Sync + Send>> {
    match raw {
        [a, b, c, d] => Ok(i32::from_be_bytes([*a, *b, *c, *d])),
        _ => Err(invalid_value("a PostgreSQL 32-bit value is truncated")),
    }
}

/// Reads a big-endian `int8` from a binary value.
fn read_i64(raw: &[u8]) -> Result<i64, Box<dyn StdError + Sync + Send>> {
    match raw {
        [a, b, c, d, e, f, g, h] => Ok(i64::from_be_bytes([*a, *b, *c, *d, *e, *f, *g, *h])),
        _ => Err(invalid_value("a PostgreSQL 64-bit value is truncated")),
    }
}

/// Decodes a numeric value exactly into its decimal text representation.
///
/// The binary format stores base-10000 digits with a weight and a display
/// scale; rebuilding the decimal string keeps arbitrary precision instead of
/// rounding through a fixed-width float.
fn decode_numeric(raw: &[u8]) -> Result<String, Box<dyn StdError + Sync + Send>> {
    if raw.len() < 8 {
        return Err(invalid_value("a numeric value is truncated"));
    }

    let ndigits = read_i16(&raw[0..2])?;
    let weight = read_i16(&raw[2..4])?;
    let sign = read_i16(&raw[4..6])? as u16;
    let dscale = read_i16(&raw[6..8])?;

    match sign {
        0xC000 => return Ok("NaN".to_string()),
        0xD000 => return Ok("Infinity".to_string()),
        0xF000 => return Ok("-Infinity".to_string()),
        _ => {}
    }

    let negative = sign == 0x4000;
    let ndigits = usize::try_from(ndigits.max(0)).unwrap_or(0);
    let dscale = usize::try_from(dscale.max(0)).unwrap_or(0);

    let mut digits = Vec::with_capacity(ndigits);
    for index in 0..ndigits {
        let start = 8 + index * 2;
        let bytes = raw
            .get(start..start + 2)
            .ok_or_else(|| invalid_value("a numeric value is truncated"))?;
        digits.push(i32::from(read_i16(bytes)?));
    }

    let weight = i32::from(weight);
    let is_zero = digits.iter().all(|digit| *digit == 0);

    // Integer groups are the base-10000 digits with exponent `weight..=0`,
    // most significant first; missing digits are zero groups.
    let mut integer_groups = Vec::new();
    if weight >= 0 {
        for exponent in (0..=weight).rev() {
            integer_groups.push(digit_at(&digits, weight - exponent));
        }
    }

    // Fractional groups cover the first `ceil(dscale / 4)` exponents below zero.
    let fractional_count = dscale.div_ceil(4);
    let mut fractional_groups = Vec::with_capacity(fractional_count);
    for step in 1..=fractional_count as i32 {
        fractional_groups.push(digit_at(&digits, weight + step));
    }

    let mut text = String::new();
    if negative && !is_zero {
        text.push('-');
    }

    if integer_groups.is_empty() {
        text.push('0');
    } else {
        for (position, group) in integer_groups.iter().enumerate() {
            if position == 0 {
                let _ = write!(text, "{group}");
            } else {
                let _ = write!(text, "{group:04}");
            }
        }
    }

    if dscale > 0 {
        let mut fractional = String::with_capacity(fractional_count * 4);
        for group in &fractional_groups {
            let _ = write!(fractional, "{group:04}");
        }
        fractional.truncate(dscale);
        while fractional.len() < dscale {
            fractional.push('0');
        }
        text.push('.');
        text.push_str(&fractional);
    }

    Ok(text)
}

/// Returns the declared digit at `index`, or zero when the position is empty.
fn digit_at(digits: &[i32], index: i32) -> i32 {
    if index < 0 {
        return 0;
    }
    digits.get(index as usize).copied().unwrap_or(0)
}

/// Formats a `date` value (days since 2000-01-01) as `YYYY-MM-DD`.
fn format_date(raw: &[u8]) -> Result<String, Box<dyn StdError + Sync + Send>> {
    let days = i64::from(read_i32(raw)?);
    let (year, month, day) = civil_from_days(days + POSTGRES_EPOCH_DAYS);
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

/// Formats microseconds as `HH:MM:SS[.ffffff]`.
fn format_time(micros: i64, include_sign: bool) -> String {
    let negative = micros < 0;
    let micros = micros.unsigned_abs();
    let total_seconds = micros / 1_000_000;
    let fraction = micros % 1_000_000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds / 60) % 60;
    let seconds = total_seconds % 60;

    let mut text = String::new();
    if include_sign && negative {
        text.push('-');
    }
    let _ = write!(text, "{hours:02}:{minutes:02}:{seconds:02}");
    if fraction > 0 {
        let _ = write!(text, ".{fraction:06}");
    }
    text
}

/// Formats a `timestamp`/`timestamptz` value (microseconds since 2000-01-01).
///
/// `timestamptz` binary values are UTC, so the rendered text is annotated with
/// `+00` rather than being shifted by an unknown session time zone.
fn format_timestamp(micros: i64, with_time_zone: bool) -> String {
    let days = micros.div_euclid(MICROS_PER_DAY);
    let time_micros = micros.rem_euclid(MICROS_PER_DAY);
    let (year, month, day) = civil_from_days(days + POSTGRES_EPOCH_DAYS);

    let mut text = format!(
        "{year:04}-{month:02}-{day:02} {}",
        format_time(time_micros, false)
    );
    if with_time_zone {
        text.push_str("+00");
    }
    text
}

/// Formats an `interval` value (microseconds, days, months) as readable text.
fn format_interval(raw: &[u8]) -> Result<String, Box<dyn StdError + Sync + Send>> {
    if raw.len() < 16 {
        return Err(invalid_value("an interval value is truncated"));
    }
    let micros = read_i64(&raw[0..8])?;
    let days = read_i32(&raw[8..12])?;
    let months = read_i32(&raw[12..16])?;

    let years = months / 12;
    let remaining_months = months % 12;
    let mut parts: Vec<String> = Vec::new();
    if years != 0 {
        parts.push(format!(
            "{years} year{}",
            if years.abs() == 1 { "" } else { "s" }
        ));
    }
    if remaining_months != 0 {
        parts.push(format!(
            "{remaining_months} mon{}",
            if remaining_months.abs() == 1 { "" } else { "s" }
        ));
    }
    if days != 0 {
        parts.push(format!(
            "{days} day{}",
            if days.abs() == 1 { "" } else { "s" }
        ));
    }
    if micros != 0 || parts.is_empty() {
        parts.push(format_time(micros, true));
    }
    Ok(parts.join(" "))
}

/// Formats a UUID value as its canonical hyphenated lower-case hex string.
fn format_uuid(raw: &[u8]) -> Result<String, Box<dyn StdError + Sync + Send>> {
    if raw.len() != 16 {
        return Err(invalid_value("a uuid value has an unexpected length"));
    }
    let mut text = String::with_capacity(36);
    for (index, byte) in raw.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            text.push('-');
        }
        let _ = write!(text, "{byte:02x}");
    }
    Ok(text)
}

/// Strips `jsonb`'s version byte and decodes the remaining JSON text.
fn decode_jsonb(raw: &[u8]) -> Result<String, Box<dyn StdError + Sync + Send>> {
    match raw.split_first() {
        Some((1, text)) => Ok(decode_text(text)),
        _ => Err(invalid_value("a jsonb value has an unexpected version")),
    }
}

/// Converts days since the Unix epoch into a proleptic Gregorian date.
///
/// Based on Howard Hinnant's `civil_from_days`, valid for the full `i64` range.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month as u32, day as u32)
}

/// Reads a PostgreSQL object's columns and primary key in ordinal/key order.
///
/// The schema and table names are bound values in the `information_schema`
/// predicates, never interpolated. A missing table or view is a validation
/// error; a view reports columns with no primary key.
async fn postgres_table_shape(
    client: &Client,
    schema: &str,
    object_name: &str,
) -> Result<(Vec<ColumnInfo>, Vec<String>), QueryError> {
    let rows = client
        .query(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
            &[&schema, &object_name],
        )
        .await
        .map_err(map_error)?;

    if rows.is_empty() {
        return Err(validation_error(format!(
            "`{object_name}` is not a table or view in this PostgreSQL schema"
        )));
    }

    let mut columns = Vec::with_capacity(rows.len());
    for row in &rows {
        let name: String = row.try_get(0).map_err(map_error)?;
        let data_type: String = row.try_get(1).map_err(map_error)?;
        let is_nullable: String = row.try_get(2).map_err(map_error)?;
        let nullable = match is_nullable.as_str() {
            "YES" => Some(true),
            "NO" => Some(false),
            _ => None,
        };
        columns.push(ColumnInfo {
            name,
            type_name: Some(data_type),
            nullable,
        });
    }

    let keys = client
        .query(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON kcu.constraint_name = tc.constraint_name \
              AND kcu.constraint_schema = tc.constraint_schema \
              AND kcu.table_schema = tc.table_schema \
              AND kcu.table_name = tc.table_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_schema = $1 AND tc.table_name = $2 \
             ORDER BY kcu.ordinal_position",
            &[&schema, &object_name],
        )
        .await
        .map_err(map_error)?;

    let mut primary_key_columns = Vec::with_capacity(keys.len());
    for row in &keys {
        let name: String = row.try_get(0).map_err(map_error)?;
        primary_key_columns.push(name);
    }

    Ok((columns, primary_key_columns))
}

/// Fetches one bounded, filtered, sorted page from a PostgreSQL table or view.
///
/// The table reference is qualified with the resolved schema and quoted with
/// ANSI double quotes. Filters/sorts are validated against the object's columns
/// and bound as `$n` parameters in text format. The primary key, when present,
/// is appended to the ordering and reported as `row_identity`.
async fn fetch_postgres_page(
    client: &Client,
    default_schema: Option<&str>,
    request: TablePageRequest,
) -> Result<TablePage, QueryError> {
    let limit = effective_table_page_limit(request.limit)?;
    let schema = resolve_schema(default_schema, request.object.schema.as_deref())?;
    let (columns, row_identity) =
        postgres_table_shape(client, &schema, &request.object.name).await?;
    let order = effective_sort_order(&request.sort, &row_identity);
    let from = format!(
        "{}.{}",
        quote_identifier(&schema),
        quote_identifier(&request.object.name)
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
        |position| format!("${position}"),
        quote_identifier,
    )?;

    // Fetch one extra row to learn whether another page exists without a
    // separate COUNT, which could scan the whole relation.
    let statement = client.prepare(&sql).await.map_err(map_error)?;
    let parameters: Vec<PgParameter> = values.into_iter().map(PgParameter).collect();
    let parameter_refs: Vec<&(dyn ToSql + Sync)> = parameters
        .iter()
        .map(|parameter| parameter as &(dyn ToSql + Sync))
        .collect();

    let mut rows: Vec<Row> = Vec::new();
    let mut truncated = false;
    let mut stream = std::pin::pin!(client
        .query_raw(&statement, parameter_refs.iter().copied())
        .await
        .map_err(map_error)?);
    while let Some(row) = stream.try_next().await.map_err(map_error)? {
        if rows.len() >= limit as usize {
            truncated = true;
            break;
        }
        rows.push(row_to_cells(&row)?);
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

impl DatabaseAdapter for PostgresAdapter {
    fn engine(&self) -> EngineId {
        EngineId::Postgres
    }

    fn capabilities(&self) -> EngineCapabilities {
        // This slice implements connect/disconnect, metadata inspection, and
        // read-only SQL execution over TLS-capable connections. Transaction,
        // cancellation, and staged-change flags stay `false` so the UI never
        // advertises behavior the adapter cannot honor yet. PostgreSQL exposes
        // named schemas but binds a connection to one database.
        EngineCapabilities {
            transactions: false,
            ddl_transactions: false,
            savepoints: false,
            cancellation: false,
            schemas: true,
            multiple_databases: false,
            tls: true,
        }
    }

    fn test_connection<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionTest, QueryError>> {
        Box::pin(async move {
            let server = postgres_server(descriptor)?;
            let (client, _database, _schema) = open_read_only(server, secret).await?;
            let row = client
                .query_one("SHOW server_version", &[])
                .await
                .map_err(map_error)?;
            let version: Option<String> = row.try_get(0).map_err(map_error)?;
            // The client is dropped here; `test_connection` must not retain it.
            drop(client);
            Ok(ConnectionTest {
                engine: EngineId::Postgres,
                server_version: version,
            })
        })
    }

    fn connect<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionId, QueryError>> {
        Box::pin(async move {
            let server = postgres_server(descriptor)?;
            let (client, database, default_schema) = open_read_only(server, secret).await?;

            let sequence = self.next_connection.fetch_add(1, Ordering::SeqCst) + 1;
            let connection = ConnectionId::new(format!("postgres-{sequence}"));

            self.connection_map().insert(
                connection.clone(),
                Arc::new(AsyncMutex::new(ConnectionSlot {
                    state: ConnectionState::Connected,
                    client: Some(client),
                    database,
                    default_schema,
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
            let mut slot = slot.lock().await;
            slot.state = ConnectionState::Disconnected;
            slot.client = None;
            Ok(())
        })
    }

    fn connection_state<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ConnectionState, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let slot = slot.lock().await;
            Ok(slot.state)
        })
    }

    fn list_objects<'a>(
        &'a self,
        connection: &'a ConnectionId,
        scope: &'a ObjectScope,
    ) -> AdapterFuture<'a, Result<Vec<ObjectRef>, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let guard = slot.lock().await;
            let client = connected_client(&guard, connection)?;

            ensure_scope_database(&guard.database, scope.database.as_deref())?;
            let schema = resolve_schema(guard.default_schema.as_deref(), scope.schema.as_deref())?;

            let rows = client
                .query(
                    "SELECT table_name, table_type FROM information_schema.tables \
                     WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'VIEW') \
                     ORDER BY table_name",
                    &[&schema],
                )
                .await
                .map_err(map_error)?;

            let mut objects = Vec::with_capacity(rows.len());
            for row in &rows {
                let name: String = row.try_get(0).map_err(map_error)?;
                let table_type: String = row.try_get(1).map_err(map_error)?;
                let kind = if table_type.eq_ignore_ascii_case("VIEW") {
                    ObjectKind::View
                } else {
                    ObjectKind::Table
                };
                objects.push(ObjectRef {
                    database: None,
                    schema: Some(schema.clone()),
                    name,
                    kind,
                });
            }
            Ok(objects)
        })
    }

    fn list_scopes<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ScopeListing, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let guard = slot.lock().await;
            let client = connected_client(&guard, connection)?;

            // PostgreSQL exposes schemas, not alternate databases, on one
            // connection; the database field stays empty.
            let rows = client
                .query(
                    "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
                    &[],
                )
                .await
                .map_err(map_error)?;

            let mut schemas = Vec::with_capacity(rows.len());
            for row in &rows {
                let name: String = row.try_get(0).map_err(map_error)?;
                schemas.push(name);
            }

            Ok(ScopeListing {
                databases: Vec::new(),
                schemas,
            })
        })
    }

    fn describe_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
    ) -> AdapterFuture<'a, Result<TableDescription, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let guard = slot.lock().await;
            let client = connected_client(&guard, connection)?;

            ensure_scope_database(&guard.database, object.database.as_deref())?;
            let schema = resolve_schema(guard.default_schema.as_deref(), object.schema.as_deref())?;

            let (columns, primary_key_columns) =
                postgres_table_shape(client, &schema, &object.name).await?;

            // Indexes: `pg_index` carries uniqueness/primary flags; iterating the
            // index's column positions and asking `pg_get_indexdef` for each one
            // yields the key column (or its expression) without parsing DDL.
            let index_rows = client
                .query(
                    "SELECT idx.relname::text, i.indisunique, i.indisprimary, \
                            pg_get_indexdef(i.indexrelid, cols.n, true) \
                     FROM pg_index i \
                     JOIN pg_class idx ON idx.oid = i.indexrelid \
                     JOIN pg_class tbl ON tbl.oid = i.indrelid \
                     JOIN pg_namespace ns ON ns.oid = tbl.relnamespace \
                     CROSS JOIN LATERAL generate_series(1, i.indnatts) AS cols(n) \
                     WHERE ns.nspname = $1 AND tbl.relname = $2 \
                     ORDER BY idx.relname, cols.n",
                    &[&schema, &object.name],
                )
                .await
                .map_err(map_error)?;

            let mut indexes: Vec<IndexInfo> = Vec::new();
            for row in &index_rows {
                let name: String = row.try_get(0).map_err(map_error)?;
                let unique: bool = row.try_get(1).map_err(map_error)?;
                let primary: bool = row.try_get(2).map_err(map_error)?;
                let column: String = row.try_get(3).map_err(map_error)?;
                if let Some(last) = indexes.last_mut() {
                    if last.name == name {
                        last.columns.push(column);
                        continue;
                    }
                }
                indexes.push(IndexInfo::new(name, vec![column], unique, primary));
            }

            // Constraints: `table_constraints` joined to `key_column_usage`
            // supplies columns and foreign-key targets; `check_constraints`
            // supplies the check clause. Each is reported with its normalized
            // kind rather than flattened into one opaque list.
            let constraint_rows = client
                .query(
                    "SELECT tc.constraint_name::text, tc.constraint_type::text, \
                            kcu.column_name::text, kcu.referenced_table_schema::text, \
                            kcu.referenced_table_name::text, kcu.referenced_column_name::text, \
                            cc.check_clause::text \
                     FROM information_schema.table_constraints tc \
                     LEFT JOIN information_schema.key_column_usage kcu \
                       ON kcu.constraint_schema = tc.constraint_schema \
                      AND kcu.constraint_name = tc.constraint_name \
                      AND kcu.table_schema = tc.table_schema \
                      AND kcu.table_name = tc.table_name \
                     LEFT JOIN information_schema.check_constraints cc \
                       ON cc.constraint_schema = tc.constraint_schema \
                      AND cc.constraint_name = tc.constraint_name \
                     WHERE tc.table_schema = $1 AND tc.table_name = $2 \
                     ORDER BY tc.constraint_name, kcu.ordinal_position",
                    &[&schema, &object.name],
                )
                .await
                .map_err(map_error)?;

            let mut constraints: Vec<ConstraintInfo> = Vec::new();
            for row in &constraint_rows {
                let name: String = row.try_get(0).map_err(map_error)?;
                let constraint_type: String = row.try_get(1).map_err(map_error)?;
                let Some(kind) = postgres_constraint_kind(&constraint_type) else {
                    continue;
                };
                let column: Option<String> = row.try_get(2).map_err(map_error)?;
                let referenced_schema: Option<String> = row.try_get(3).map_err(map_error)?;
                let referenced_table: Option<String> = row.try_get(4).map_err(map_error)?;
                let referenced_column: Option<String> = row.try_get(5).map_err(map_error)?;
                let check_clause: Option<String> = row.try_get(6).map_err(map_error)?;

                if let Some(last) = constraints.last_mut() {
                    if last.name == name {
                        if let Some(column) = column {
                            last.columns.push(column);
                        }
                        if let Some(referenced_column) = referenced_column {
                            last.referenced_columns.push(referenced_column);
                        }
                        continue;
                    }
                }

                let mut constraint = match kind {
                    ConstraintKind::ForeignKey => ConstraintInfo::foreign_key(
                        name.clone(),
                        Vec::new(),
                        referenced_schema.clone(),
                        referenced_table.clone().unwrap_or_default(),
                        Vec::new(),
                    ),
                    ConstraintKind::Check => match check_clause.clone() {
                        Some(clause) => ConstraintInfo::check(name.clone(), clause),
                        None => ConstraintInfo::of_kind(name.clone(), kind, Vec::new()),
                    },
                    other => ConstraintInfo::of_kind(name.clone(), other, Vec::new()),
                };
                if let Some(column) = column {
                    constraint.columns.push(column);
                }
                if let Some(referenced_column) = referenced_column {
                    constraint.referenced_columns.push(referenced_column);
                }
                constraints.push(constraint);
            }

            Ok(TableDescription::new(columns, primary_key_columns)
                .with_indexes(indexes)
                .with_constraints(constraints))
        })
    }

    fn fetch_table_page<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: TablePageRequest,
    ) -> AdapterFuture<'a, Result<TablePage, QueryError>> {
        Box::pin(async move {
            let slot = self.connection_slot(connection)?;
            let guard = slot.lock().await;
            let client = connected_client(&guard, connection)?;

            ensure_scope_database(&guard.database, request.object.database.as_deref())?;
            fetch_postgres_page(client, guard.default_schema.as_deref(), request).await
        })
    }

    fn execute<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: QueryRequest,
    ) -> AdapterFuture<'a, Result<QueryResult, QueryError>> {
        Box::pin(async move {
            if request.sql.trim().is_empty() {
                return Err(validation_error("the SQL statement is empty"));
            }

            let slot = self.connection_slot(connection)?;
            let guard = slot.lock().await;
            let client = connected_client(&guard, connection)?;
            Ok(run_statement(client, &request).await)
        })
    }

    fn apply_change<'a>(
        &'a self,
        connection: &'a ConnectionId,
        _request: ChangeRequest,
    ) -> AdapterFuture<'a, Result<ChangeResult, QueryError>> {
        Box::pin(async move {
            let _ = self.connection_slot(connection)?;
            Err(unsupported_error(
                "this connection is read-only and does not support data changes",
            ))
        })
    }

    fn cancel<'a>(
        &'a self,
        _connection: &'a ConnectionId,
        _operation: &'a OperationId,
    ) -> AdapterFuture<'a, Result<CancelOutcome, QueryError>> {
        Box::pin(async move {
            Err(unsupported_error(
                "query cancellation is not implemented for PostgreSQL in this slice",
            ))
        })
    }

    fn begin_transaction<'a>(
        &'a self,
        _connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<TransactionId, QueryError>> {
        Box::pin(async move {
            Err(unsupported_error(
                "explicit transactions are not implemented for PostgreSQL in this slice",
            ))
        })
    }

    fn commit<'a>(
        &'a self,
        _connection: &'a ConnectionId,
        _transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            Err(unsupported_error(
                "explicit transactions are not implemented for PostgreSQL in this slice",
            ))
        })
    }

    fn rollback<'a>(
        &'a self,
        _connection: &'a ConnectionId,
        _transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            Err(unsupported_error(
                "explicit transactions are not implemented for PostgreSQL in this slice",
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use bytes::BytesMut;
    use postgres_types::{Format, IsNull, ToSql, Type};

    use super::{
        build_config, categorize_sqlstate, cell_text, civil_from_days, decode_jsonb,
        decode_numeric, format_date, format_interval, format_time, format_timestamp, format_uuid,
        postgres_server, ssl_mode_for, tls_connector, PgParameter, PostgresAdapter,
    };
    use crate::database::{ConnectionId, ConnectionSecret, DatabaseAdapter};
    use crate::domain::connection::{ServerConnection, TlsMode};
    use crate::domain::{
        CellValue, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory, QueryRequest,
    };
    use tokio_postgres::config::SslMode;

    /// Minimal executor for the immediately-ready futures the adapter returns
    /// for validation/unknown-connection paths.
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
            port: 5433,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls,
        }
    }

    /// Builds a numeric binary value from its base-10000 digits.
    fn numeric_raw(ndigits: i16, weight: i16, sign: u16, dscale: i16, digits: &[i16]) -> Vec<u8> {
        let mut raw = Vec::with_capacity(8 + digits.len() * 2);
        raw.extend_from_slice(&ndigits.to_be_bytes());
        raw.extend_from_slice(&weight.to_be_bytes());
        raw.extend_from_slice(&sign.to_be_bytes());
        raw.extend_from_slice(&dscale.to_be_bytes());
        for digit in digits {
            raw.extend_from_slice(&digit.to_be_bytes());
        }
        raw
    }

    #[test]
    fn engine_and_capabilities_report_only_the_implemented_slice() {
        let adapter = PostgresAdapter::new();

        assert_eq!(adapter.engine(), EngineId::Postgres);
        assert_eq!(
            adapter.capabilities(),
            EngineCapabilities {
                transactions: false,
                ddl_transactions: false,
                savepoints: false,
                cancellation: false,
                schemas: true,
                multiple_databases: false,
                tls: true,
            }
        );
    }

    #[test]
    fn non_postgres_descriptors_are_rejected_before_connecting() {
        let descriptor =
            ConnectionDescriptor::Sqlite(crate::domain::connection::SqliteConnection {
                file_path: "C:/data/app.sqlite".to_string(),
            });

        let error = postgres_server(&descriptor).expect_err("a SQLite descriptor must be rejected");
        assert_eq!(error.category, ErrorCategory::Configuration);

        let adapter = PostgresAdapter::new();
        let error = block_on(adapter.test_connection(&descriptor, None))
            .expect_err("the adapter must reject another engine before I/O");
        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn build_config_translates_descriptor_fields() {
        let descriptor = server(TlsMode::Disabled);
        let config = build_config(&descriptor, None).expect("valid settings should build options");

        assert_eq!(config.get_user(), Some("app_user"));
        assert_eq!(config.get_dbname(), Some("app"));
        assert_eq!(config.get_application_name(), Some("dbtables"));
        assert_eq!(config.get_ports(), [5433]);
        assert_eq!(config.get_hosts().len(), 1);
        assert_eq!(
            config.get_connect_timeout().copied(),
            Some(super::CONNECT_TIMEOUT)
        );
        assert!(matches!(config.get_ssl_mode(), SslMode::Disable));
    }

    #[test]
    fn build_config_forwards_a_secret_without_exposing_it_elsewhere() {
        let descriptor = server(TlsMode::Disabled);
        let secret = ConnectionSecret::new("test-only-value");
        let config =
            build_config(&descriptor, Some(&secret)).expect("valid settings should build options");

        assert_eq!(config.get_password(), Some(b"test-only-value".as_slice()));
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("test-only-value"));
    }

    #[test]
    fn build_config_rejects_blank_hosts_and_zero_ports() {
        let mut blank = server(TlsMode::Disabled);
        blank.host = "   ".to_string();
        assert_eq!(
            build_config(&blank, None)
                .expect_err("blank host must fail")
                .category,
            ErrorCategory::Configuration
        );

        let mut zero_port = server(TlsMode::Disabled);
        zero_port.port = 0;
        assert_eq!(
            build_config(&zero_port, None)
                .expect_err("zero port must fail")
                .category,
            ErrorCategory::Configuration
        );
    }

    #[test]
    fn tls_modes_select_ssl_modes() {
        assert!(matches!(ssl_mode_for(TlsMode::Disabled), SslMode::Disable));
        assert!(matches!(ssl_mode_for(TlsMode::Preferred), SslMode::Prefer));
        assert!(matches!(ssl_mode_for(TlsMode::Required), SslMode::Require));
        assert!(matches!(ssl_mode_for(TlsMode::VerifyCa), SslMode::Require));
        assert!(matches!(
            ssl_mode_for(TlsMode::VerifyFull),
            SslMode::Require
        ));
    }

    #[test]
    fn tls_connectors_build_for_every_verifying_mode() {
        for (verify_certificates, verify_hostname) in [(false, false), (true, false), (true, true)]
        {
            tls_connector(verify_certificates, verify_hostname)
                .expect("a native-tls connector should build");
        }
    }

    #[test]
    fn server_error_codes_map_to_normalized_categories() {
        let cases = [
            ("28P01", ErrorCategory::Authentication),
            ("28000", ErrorCategory::Authentication),
            ("42501", ErrorCategory::Permission),
            ("25006", ErrorCategory::Permission),
            ("23505", ErrorCategory::Constraint),
            ("40001", ErrorCategory::Locking),
            ("55P03", ErrorCategory::Locking),
            ("42601", ErrorCategory::Syntax),
            ("42P01", ErrorCategory::Validation),
            ("3D000", ErrorCategory::Validation),
            ("22P02", ErrorCategory::Validation),
            ("57014", ErrorCategory::Cancelled),
            ("0A000", ErrorCategory::Unsupported),
            ("53300", ErrorCategory::Connection),
            ("XX000", ErrorCategory::Internal),
        ];

        for (code, expected) in cases {
            assert_eq!(categorize_sqlstate(code), expected, "code {code}");
        }
    }

    #[test]
    fn pg_parameters_serialize_as_text_and_redact_debug_output() {
        let cases = [
            (CellValue::Boolean(true), "true"),
            (CellValue::Integer(-7), "-7"),
            (CellValue::Float(1.5), "1.5"),
            (CellValue::Decimal("12.500".to_string()), "12.500"),
            (CellValue::Text("alice".to_string()), "alice"),
            (CellValue::Bytes(vec![0x01, 0xff]), "\\x01ff"),
        ];

        for (value, expected) in cases {
            let parameter = PgParameter(value);
            let mut out = BytesMut::new();
            let state = parameter
                .to_sql(&Type::TEXT, &mut out)
                .expect("text serialization should not fail");
            assert!(matches!(state, IsNull::No));
            assert_eq!(out.as_ref(), expected.as_bytes(), "value {expected}");
            assert!(matches!(parameter.encode_format(&Type::TEXT), Format::Text));
        }

        let null = PgParameter(CellValue::Null);
        let mut out = BytesMut::new();
        assert!(matches!(
            null.to_sql(&Type::TEXT, &mut out)
                .expect("null should serialize"),
            IsNull::Yes
        ));
        assert!(out.is_empty());
        assert!(!format!("{null:?}").contains("null"));
        assert!(!cell_text(&CellValue::Text("secret".to_string())).is_empty());
    }

    #[test]
    fn numeric_values_decode_to_exact_decimal_text() {
        // 2000-01-01 00:00:00 is micros 0.
        assert_eq!(format_timestamp(0, false), "2000-01-01 00:00:00");
        assert_eq!(format_timestamp(0, true), "2000-01-01 00:00:00+00");
        assert_eq!(format_timestamp(1_000_000, false), "2000-01-01 00:00:01");

        // 12345.678 => digits [1, 2345, 6780], weight 1, scale 3.
        assert_eq!(
            decode_numeric(&numeric_raw(3, 1, 0x0000, 3, &[1, 2345, 6780])).unwrap(),
            "12345.678"
        );
        // 0.001 => digits [10], weight -1, scale 3.
        assert_eq!(
            decode_numeric(&numeric_raw(1, -1, 0x0000, 3, &[10])).unwrap(),
            "0.001"
        );
        // -12.5 => digits [12, 5000], weight 0, scale 1.
        assert_eq!(
            decode_numeric(&numeric_raw(2, 0, 0x4000, 1, &[12, 5000])).unwrap(),
            "-12.5"
        );
        // Zero with two decimal places.
        assert_eq!(
            decode_numeric(&numeric_raw(0, 0, 0x0000, 2, &[])).unwrap(),
            "0.00"
        );
        assert_eq!(
            decode_numeric(&numeric_raw(0, 0, 0xC000, 0, &[])).unwrap(),
            "NaN"
        );
    }

    #[test]
    fn temporal_and_structured_values_format_as_text() {
        assert_eq!(format_date(&0i32.to_be_bytes()).unwrap(), "2000-01-01");
        assert_eq!(format_date(&(-1i32).to_be_bytes()).unwrap(), "1999-12-31");

        let micros = ((7 * 3600 + 8 * 60 + 9) as i64) * 1_000_000 + 123_456;
        assert_eq!(format_time(micros, false), "07:08:09.123456");

        let mut interval = Vec::new();
        interval.extend_from_slice(&(3_661_000_000i64).to_be_bytes());
        interval.extend_from_slice(&2i32.to_be_bytes());
        interval.extend_from_slice(&14i32.to_be_bytes());
        assert_eq!(
            format_interval(&interval).unwrap(),
            "1 year 2 mons 2 days 01:01:01"
        );

        let uuid = [
            0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
            0x77, 0x88,
        ];
        assert_eq!(
            format_uuid(&uuid).unwrap(),
            "12345678-9abc-def0-1122-334455667788"
        );

        assert_eq!(decode_jsonb(b"\x01{\"a\":1}").unwrap(), "{\"a\":1}");
    }

    #[test]
    fn civil_dates_convert_around_the_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn unknown_connections_are_connection_errors_without_a_server() {
        let adapter = PostgresAdapter::new();
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
            block_on(adapter.execute(&unknown, QueryRequest::new("op", "SELECT 1")))
                .expect_err("unknown execute must fail")
                .category,
            ErrorCategory::Connection
        );
    }

    #[test]
    fn execute_rejects_blank_sql_before_touching_the_connection() {
        let adapter = PostgresAdapter::new();
        let unknown = ConnectionId::new("does-not-exist");

        let error = block_on(adapter.execute(&unknown, QueryRequest::new("op-blank", "   ")))
            .expect_err("blank SQL is a precondition failure");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn a_fresh_adapter_is_disconnected_and_unsupported_for_writes() {
        let adapter = PostgresAdapter::new();
        let unknown = ConnectionId::new("missing");

        assert!(!adapter.capabilities().transactions);
        assert_eq!(
            block_on(adapter.cancel(&unknown, &crate::domain::OperationId::new("op")))
                .expect_err("cancellation is unsupported")
                .category,
            ErrorCategory::Unsupported
        );
    }
}

/// Integration tests that only run when a disposable PostgreSQL server is configured.
///
/// Set `DBTABLES_POSTGRES_TEST_HOST` (and optionally `_PORT`, `_DATABASE`,
/// `_USER`, `_PASSWORD`, `_TLS`) to enable them. When the host is absent every
/// test returns early, so the default `cargo test` run needs no server. No test
/// prints a password.
#[cfg(test)]
mod integration_tests {
    use super::PostgresAdapter;
    use crate::database::{
        ConnectionId, ConnectionSecret, ConnectionState, DatabaseAdapter, ObjectScope,
    };
    use crate::domain::connection::{ServerConnection, TlsMode};
    use crate::domain::{
        ConnectionDescriptor, EngineId, ErrorCategory, OperationState, QueryRequest,
    };

    /// A current-thread runtime that drives the adapter's connection task.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a test runtime should build")
    }

    fn env_value(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    /// Returns the configured descriptor and secret, or `None` to skip.
    fn configured() -> Option<(ConnectionDescriptor, Option<ConnectionSecret>)> {
        let host = env_value("DBTABLES_POSTGRES_TEST_HOST")?;
        let port = env_value("DBTABLES_POSTGRES_TEST_PORT")
            .and_then(|value| value.parse().ok())
            .unwrap_or(5432);
        let tls = match env_value("DBTABLES_POSTGRES_TEST_TLS").as_deref() {
            Some("preferred") => TlsMode::Preferred,
            Some("required") => TlsMode::Required,
            Some("verify_ca") => TlsMode::VerifyCa,
            Some("verify_full") => TlsMode::VerifyFull,
            _ => TlsMode::Disabled,
        };
        let server = ServerConnection {
            host,
            port,
            database: env_value("DBTABLES_POSTGRES_TEST_DATABASE"),
            username: env_value("DBTABLES_POSTGRES_TEST_USER")
                .unwrap_or_else(|| "postgres".to_string()),
            tls,
        };
        let secret = env_value("DBTABLES_POSTGRES_TEST_PASSWORD").map(ConnectionSecret::new);
        Some((ConnectionDescriptor::Postgres(server), secret))
    }

    #[test]
    fn connect_lists_metadata_and_runs_a_query() {
        let Some((descriptor, secret)) = configured() else {
            return;
        };
        let runtime = runtime();
        runtime.block_on(async {
            let adapter = PostgresAdapter::new();

            let test = adapter
                .test_connection(&descriptor, secret.as_ref())
                .await
                .expect("test connection should succeed");
            assert_eq!(test.engine, EngineId::Postgres);

            let connection = adapter
                .connect(&descriptor, secret.as_ref())
                .await
                .expect("connect should succeed");
            assert_eq!(
                adapter
                    .connection_state(&connection)
                    .await
                    .expect("state should resolve"),
                ConnectionState::Connected
            );

            let scopes = adapter
                .list_scopes(&connection)
                .await
                .expect("schemas should list");
            assert!(!scopes.schemas.is_empty());

            let objects = adapter
                .list_objects(&connection, &ObjectScope::default())
                .await
                .expect("object listing should succeed");
            if let Some(first) = objects.first() {
                let description = adapter
                    .describe_table(&connection, first)
                    .await
                    .expect("description should succeed");
                assert!(!description.columns.is_empty());
            }

            let selected = adapter
                .execute(
                    &connection,
                    QueryRequest::new("it-select", "SELECT 1 AS one"),
                )
                .await
                .expect("select should return a result");
            assert_eq!(selected.state, OperationState::Succeeded);
            assert_eq!(selected.rows.len(), 1);

            let invalid = adapter
                .execute(
                    &connection,
                    QueryRequest::new("it-invalid", "SELECT FROM WHERE"),
                )
                .await
                .expect("invalid SQL still produces a result");
            assert_eq!(invalid.state, OperationState::Failed);
            assert_eq!(
                invalid
                    .error
                    .expect("failure should carry an error")
                    .category,
                ErrorCategory::Syntax
            );

            adapter
                .disconnect(&connection)
                .await
                .expect("disconnect should succeed");
            assert_eq!(
                adapter
                    .connection_state(&connection)
                    .await
                    .expect("state should resolve"),
                ConnectionState::Disconnected
            );
        });
    }

    #[test]
    fn bad_credentials_are_reported_as_authentication_failures() {
        let Some((descriptor, _secret)) = configured() else {
            return;
        };
        let runtime = runtime();
        runtime.block_on(async {
            let adapter = PostgresAdapter::new();
            let wrong = ConnectionSecret::new("definitely-not-the-password");

            let error = adapter
                .test_connection(&descriptor, Some(&wrong))
                .await
                .expect_err("bad credentials must fail");
            assert_eq!(error.category, ErrorCategory::Authentication);

            let unknown = ConnectionId::new("never-opened");
            assert_eq!(
                adapter
                    .connection_state(&unknown)
                    .await
                    .expect_err("unknown connection must fail")
                    .category,
                ErrorCategory::Connection
            );
        });
    }
}
