//! Read-only SQLite adapter backed by `rusqlite`.
//!
//! This module implements the metadata and query half of the shared
//! [`DatabaseAdapter`] contract for local SQLite files:
//!
//! - Connect to an existing file, report its state, and disconnect.
//! - List base tables and views, excluding SQLite's internal `sqlite_*` objects.
//! - Describe an object's columns and primary key using table-valued pragmas.
//! - Execute a single SQL statement and return a normalized, capped result with
//!   column metadata, rows, affected-row count, duration, and structured errors.
//! - Fetch bounded, filtered, sorted pages of a table or view, reporting the
//!   primary key as a safe row identity when the object has one.
//!
//! Staged changes arrive in a later task and report
//! [`ErrorCategory::Unsupported`] until then, so no write path is exposed and
//! [`Self::capabilities`] reports only what the adapter can honor today.
//!
//! Design rules:
//!
//! - Connections are opened with `SQLITE_OPEN_READ_ONLY`. The adapter cannot
//!   create a database file or mutate an existing one, so any write statement a
//!   caller attempts fails at the driver with a normalized permission error.
//! - Parameters supplied with a request are bound as parameters; caller text is
//!   never concatenated into the statement.
//! - Driver-native [`rusqlite::Connection`] handles never leave this module.
//!   Callers receive opaque, serializable [`ConnectionId`] tokens.
//! - Object names are never interpolated into SQL. `describe_table` binds the
//!   name as a parameter to the `pragma_table_info` table-valued function, which
//!   avoids identifier-quoting mistakes and injection through object names.
//!
//! **Driver decision:** `rusqlite` with the `bundled` feature was chosen for the
//! initial SQLite slice because it provides a synchronous, connection-oriented
//! API that maps directly onto the adapter's per-connection model and needs no
//! async runtime to test. The bundled build makes the adapter independent of a
//! system SQLite library. Server engines can still evaluate SQLx when their
//! adapters are added.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::database::{
    build_table_page_query, effective_sort_order, effective_table_page_limit, quote_identifier,
    AdapterFuture, CancelOutcome, ChangeRequest, ChangeResult, ConnectionId, ConnectionSecret,
    ConnectionState, ConnectionTest, ConstraintInfo, DatabaseAdapter, IndexInfo, ObjectKind,
    ObjectRef, ObjectScope, ScopeListing, TableDescription, TablePage, TablePageRequest,
    TransactionId,
};
use crate::domain::{
    CellValue, ColumnInfo, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory,
    OperationId, QueryError, QueryRequest, QueryResult, Row,
};

/// Upper bound on rows the adapter returns for one statement.
///
/// The application applies its own (smaller) default cap; this ceiling keeps a
/// caller that bypasses the application from loading an unbounded result into
/// memory. Rows beyond the cap are skipped and the result is marked truncated.
const MAX_RESULT_ROWS: u32 = 10_000;

/// State and driver handle for one open connection.
struct ConnectionSlot {
    state: ConnectionState,
    handle: Option<Connection>,
}

/// SQLite adapter implementing the shared database boundary.
///
/// The adapter owns all [`rusqlite::Connection`] handles for its lifetime. Each
/// is addressed through an opaque [`ConnectionId`] so no driver object can cross
/// the Tauri IPC boundary.
pub struct SqliteAdapter {
    connections: Mutex<HashMap<ConnectionId, ConnectionSlot>>,
    next_connection: AtomicU64,
}

impl Default for SqliteAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl SqliteAdapter {
    /// Creates an adapter with no open connections.
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(0),
        }
    }

    fn connection_slots(&self) -> std::sync::MutexGuard<'_, HashMap<ConnectionId, ConnectionSlot>> {
        self.connections
            .lock()
            .expect("SQLite adapter connection state poisoned")
    }

    /// Runs `use_connection` against an open connection or reports a normalized
    /// connection error for an unknown/closed token.
    fn with_connection<T>(
        &self,
        connection: &ConnectionId,
        use_connection: impl FnOnce(&Connection) -> Result<T, QueryError>,
    ) -> Result<T, QueryError> {
        let slots = self.connection_slots();
        let slot = slots
            .get(connection)
            .ok_or_else(|| connection_error(connection))?;
        match (&slot.state, &slot.handle) {
            (ConnectionState::Connected, Some(handle)) => use_connection(handle),
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

/// Normalized category for a SQLite result code.
fn categorize(code: ErrorCode) -> ErrorCategory {
    match code {
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => ErrorCategory::Locking,
        ErrorCode::ConstraintViolation => ErrorCategory::Constraint,
        ErrorCode::PermissionDenied | ErrorCode::ReadOnly => ErrorCategory::Permission,
        ErrorCode::CannotOpen | ErrorCode::NotADatabase => ErrorCategory::Connection,
        ErrorCode::OperationInterrupted => ErrorCategory::Cancelled,
        // SQLITE_ERROR is the generic statement error (for example a missing
        // table or column); treat it as validation rather than internal.
        ErrorCode::Unknown => ErrorCategory::Validation,
        _ => ErrorCategory::Internal,
    }
}

/// Safe, user-facing summary for a SQLite result code.
///
/// The raw driver string is preserved separately in `engine_detail`; this text
/// stays generic so no file path or host detail is required to understand it.
fn safe_failure_message(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => {
            "the SQLite database is locked by another connection"
        }
        ErrorCode::ConstraintViolation => "a SQLite constraint was violated",
        ErrorCode::PermissionDenied | ErrorCode::ReadOnly => {
            "the SQLite database denied the operation"
        }
        ErrorCode::CannotOpen | ErrorCode::NotADatabase => {
            "the SQLite database file could not be opened"
        }
        ErrorCode::OperationInterrupted => "the SQLite operation was interrupted",
        ErrorCode::Unknown => "the SQLite statement could not be executed",
        _ => "the SQLite operation failed",
    }
}

/// Maps a driver error onto the normalized error model.
///
/// `engine_detail` carries the driver's own message for diagnostics; SQLite
/// connections carry no credentials, so there is no secret to redact here.
fn map_error(error: rusqlite::Error) -> QueryError {
    match error {
        rusqlite::Error::SqliteFailure(ffi_error, detail) => {
            let code = ffi_error.code;
            let mut mapped = QueryError::new(categorize(code), safe_failure_message(code))
                .with_code(ffi_error.extended_code.to_string());
            if let Some(detail) = detail {
                mapped = mapped.with_engine_detail(detail);
            }
            mapped
        }
        // SQLite reports a parse/prepare failure with the offending offset when
        // built against a modern SQLite, which the `bundled` feature provides.
        rusqlite::Error::SqlInputError {
            error,
            msg,
            offset,
            ..
        } => QueryError::new(ErrorCategory::Syntax, "the SQL statement has a syntax error")
            .with_code(error.extended_code.to_string())
            .with_engine_detail(format!("{msg} (at offset {offset})")),
        rusqlite::Error::InvalidQuery => QueryError::new(
            ErrorCategory::Validation,
            "the SQLite statement is not a valid read-only query",
        ),
        rusqlite::Error::MultipleStatement => QueryError::new(
            ErrorCategory::Validation,
            "run a single SQL statement at a time",
        ),
        rusqlite::Error::QueryReturnedNoRows => QueryError::new(
            ErrorCategory::Validation,
            "the SQLite query returned no rows",
        ),
        other => QueryError::new(ErrorCategory::Internal, "the SQLite operation failed")
            .with_engine_detail(other.to_string()),
    }
}

/// Extracts the file path from a SQLite descriptor or reports a mismatch.
fn sqlite_path(descriptor: &ConnectionDescriptor) -> Result<&str, QueryError> {
    descriptor.sqlite_file_path().ok_or_else(|| {
        configuration_error(format!(
            "the SQLite adapter cannot serve a {} connection",
            descriptor.engine()
        ))
    })
}

/// Opens a local SQLite database file read-only with a bounded busy timeout.
///
/// Opening read-only means a missing file is an error instead of being created,
/// and no statement issued through this connection can mutate the database.
fn open_read_only(path: &str) -> Result<Connection, QueryError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(configuration_error(
            "a SQLite database file path is required",
        ));
    }

    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(map_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(map_error)?;
    Ok(connection)
}

/// Binds normalized request parameters as SQLite values.
///
/// Values are passed to the driver as bound parameters; caller text is never
/// concatenated into the statement.
fn bind_parameters(parameters: &[CellValue]) -> Vec<Value> {
    parameters.iter().map(cell_to_value).collect()
}

/// Converts a normalized cell value into a bound SQLite value.
fn cell_to_value(value: &CellValue) -> Value {
    match value {
        CellValue::Null => Value::Null,
        // SQLite has no boolean type; store the conventional 0/1 integer.
        CellValue::Boolean(value) => Value::Integer(i64::from(*value)),
        CellValue::Integer(value) => Value::Integer(*value),
        CellValue::Float(value) => Value::Real(*value),
        // Exact numerics stay text so SQLite's numeric affinity can convert
        // them without the adapter losing precision first.
        CellValue::Decimal(value) => Value::Text(value.clone()),
        CellValue::Text(value) => Value::Text(value.clone()),
        CellValue::Bytes(value) => Value::Blob(value.clone()),
    }
}

/// Converts a driver value reference into a normalized cell value.
fn cell_from_value_ref(value: ValueRef<'_>) -> CellValue {
    match value {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(value) => CellValue::Integer(value),
        ValueRef::Real(value) => CellValue::Float(value),
        ValueRef::Text(bytes) => CellValue::Text(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => CellValue::Bytes(bytes.to_vec()),
    }
}

/// Whole milliseconds elapsed since `started`, saturating instead of wrapping.
fn elapsed_millis(started: Instant) -> u64 {
    let millis = started.elapsed().as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

/// Index metadata plus the declaration that produced it.
struct SqliteIndex {
    info: IndexInfo,
    /// `pragma_index_list.origin`: `c` (CREATE INDEX), `u` (UNIQUE constraint),
    /// or `pk` (PRIMARY KEY).
    origin: String,
}

/// Column names for a SQLite index, in `pragma_index_info` order.
///
/// `pragma_index_info` reports `NULL` for an expression key part; the adapter
/// keeps the slot with a documented placeholder so index width is preserved.
fn sqlite_index_columns(handle: &Connection, index: &str) -> Result<Vec<String>, QueryError> {
    let mut statement = handle
        .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
        .map_err(map_error)?;
    let rows = statement
        .query_map([index], |row| row.get::<_, Option<String>>(0))
        .map_err(map_error)?;

    let mut columns = Vec::new();
    for row in rows {
        let name = row.map_err(map_error)?;
        columns.push(name.unwrap_or_else(|| "<expression>".to_string()));
    }
    Ok(columns)
}

/// SQLite indexes for a table, including unique-constraint and primary-key
/// backing indexes. `pragma_index_list` accepts its table argument as a bound
/// value, so the object name is never interpolated into SQL.
fn sqlite_indexes(handle: &Connection, table: &str) -> Result<Vec<SqliteIndex>, QueryError> {
    let definitions: Vec<(String, i64, String)> = {
        let mut statement = handle
            .prepare("SELECT name, \"unique\", origin FROM pragma_index_list(?1) ORDER BY seq")
            .map_err(map_error)?;
        let rows = statement
            .query_map([table], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(map_error)?;
        let mut definitions = Vec::new();
        for row in rows {
            definitions.push(row.map_err(map_error)?);
        }
        definitions
    };

    let mut indexes = Vec::with_capacity(definitions.len());
    for (name, unique, origin) in definitions {
        let columns = sqlite_index_columns(handle, &name)?;
        indexes.push(SqliteIndex {
            info: IndexInfo::new(name, columns, unique != 0, origin == "pk"),
            origin,
        });
    }
    Ok(indexes)
}

/// SQLite foreign-key constraints, grouped from `pragma_foreign_key_list`.
///
/// SQLite does not name foreign keys and has no separate schema namespace, so
/// the adapter generates a deterministic label and reports no referenced
/// schema. `to` is `NULL` when the key targets the parent's implicit primary
/// key; that slot is preserved as an empty string rather than guessed.
fn sqlite_foreign_keys(
    handle: &Connection,
    table: &str,
) -> Result<Vec<ConstraintInfo>, QueryError> {
    let rows: Vec<(i64, String, String, Option<String>)> = {
        let mut statement = handle
            .prepare(
                "SELECT id, \"table\", \"from\", \"to\" \
                 FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
            )
            .map_err(map_error)?;
        let mapped = statement
            .query_map([table], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(map_error)?;
        let mut rows = Vec::new();
        for row in mapped {
            rows.push(row.map_err(map_error)?);
        }
        rows
    };

    let mut constraints = Vec::new();
    let mut current: Option<(i64, String, Vec<String>, Vec<String>)> = None;
    for (id, referenced_table, from, to) in rows {
        let referenced_column = to.unwrap_or_default();
        match &mut current {
            Some((current_id, _, columns, referenced_columns)) if *current_id == id => {
                columns.push(from);
                referenced_columns.push(referenced_column);
            }
            _ => {
                if let Some((_, table_name, columns, referenced_columns)) = current.take() {
                    constraints.push(build_sqlite_foreign_key(
                        table,
                        table_name,
                        columns,
                        referenced_columns,
                    ));
                }
                current = Some((id, referenced_table, vec![from], vec![referenced_column]));
            }
        }
    }
    if let Some((_, table_name, columns, referenced_columns)) = current {
        constraints.push(build_sqlite_foreign_key(
            table,
            table_name,
            columns,
            referenced_columns,
        ));
    }
    Ok(constraints)
}

/// Builds a foreign-key constraint with SQLite's synthetic, deterministic name.
fn build_sqlite_foreign_key(
    table: &str,
    referenced_table: String,
    columns: Vec<String>,
    referenced_columns: Vec<String>,
) -> ConstraintInfo {
    let name = format!("{}_{}_fkey", table, columns.join("_"));
    ConstraintInfo::foreign_key(name, columns, None, referenced_table, referenced_columns)
}

/// Executes one statement on an open handle and normalizes the outcome.
///
/// Completed outcomes (including a failed preparation or step) come back as a
/// [`QueryResult`] so the caller can render the state and error. The wrapper
/// always reports a duration, even for failures.
fn run_statement(handle: &Connection, request: &QueryRequest) -> QueryResult {
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
/// Errors here are statement-level failures (bad SQL, a read-only write, a
/// missing table) and are mapped onto the normalized error model. Connection
/// errors never reach this function because the caller resolves the handle
/// first.
fn execute_statement(
    handle: &Connection,
    request: &QueryRequest,
) -> Result<QueryResult, QueryError> {
    let mut statement = handle.prepare(&request.sql).map_err(map_error)?;
    let parameters = bind_parameters(&request.parameters);
    let cap = request
        .max_rows
        .unwrap_or(MAX_RESULT_ROWS)
        .min(MAX_RESULT_ROWS) as usize;

    // A statement with no result columns is a non-row command (for example an
    // INSERT or DDL). The read-only connection rejects any mutation, but a
    // plain statement such as a PRAGMA still reports its affected-row count.
    if statement.column_count() == 0 {
        let affected = statement
            .execute(rusqlite::params_from_iter(parameters.iter()))
            .map_err(map_error)?;
        let mut result = QueryResult::succeeded(request.operation_id.clone());
        result.affected_rows = Some(affected as u64);
        return Ok(result);
    }

    let columns: Vec<ColumnInfo> = statement
        .column_names()
        .into_iter()
        .map(ColumnInfo::named)
        .collect();

    let mut rows: Vec<Row> = Vec::new();
    let mut truncated = false;
    let mut cursor = statement
        .query(rusqlite::params_from_iter(parameters.iter()))
        .map_err(map_error)?;

    while let Some(row) = cursor.next().map_err(map_error)? {
        if rows.len() >= cap {
            truncated = true;
            break;
        }

        let mut cells = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            cells.push(cell_from_value_ref(row.get_ref(index).map_err(map_error)?));
        }
        rows.push(cells);
    }

    let mut result = QueryResult::succeeded(request.operation_id.clone());
    result.columns = columns;
    result.rows = rows;
    result.truncated = truncated;
    Ok(result)
}

/// Reads a SQLite object's columns and primary key in ordinal/key order.
///
/// `pragma_table_info` accepts its table argument as a bound value, so the
/// object name is never concatenated into SQL. A missing table or view is a
/// validation error; a view reports columns with no primary key.
fn sqlite_table_shape(
    handle: &Connection,
    object: &ObjectRef,
) -> Result<(Vec<ColumnInfo>, Vec<String>), QueryError> {
    let exists: i64 = handle
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE name = ?1 AND type IN ('table', 'view')",
            [&object.name],
            |row| row.get(0),
        )
        .map_err(map_error)?;

    if exists == 0 {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!(
                "`{}` is not a table or view in this SQLite database",
                object.name
            ),
        ));
    }

    let mut statement = handle
        .prepare(
            "SELECT name, type, \"notnull\", pk \
             FROM pragma_table_info(?1) ORDER BY cid",
        )
        .map_err(map_error)?;

    let rows = statement
        .query_map([&object.name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(map_error)?;

    let mut columns = Vec::new();
    let mut primary_key: Vec<(i64, String)> = Vec::new();
    for row in rows {
        let (name, type_name, not_null, pk) = row.map_err(map_error)?;
        let type_name = if type_name.trim().is_empty() {
            None
        } else {
            Some(type_name)
        };
        columns.push(ColumnInfo {
            name: name.clone(),
            type_name,
            nullable: Some(not_null == 0),
        });
        if pk > 0 {
            primary_key.push((pk, name));
        }
    }
    primary_key.sort_by_key(|(position, _)| *position);
    let primary_key_columns: Vec<String> =
        primary_key.into_iter().map(|(_, name)| name).collect();

    Ok((columns, primary_key_columns))
}

/// Fetches one bounded, filtered, sorted page from a SQLite table or view.
///
/// The projection is the object's known columns, filters/sorts are validated
/// against them, and comparison values are bound as parameters. The primary key
/// (when present) is appended to the ordering as a deterministic tie-breaker and
/// reported as `row_identity`; an empty identity honestly signals that rows
/// cannot be targeted safely.
fn fetch_sqlite_page(
    handle: &Connection,
    request: TablePageRequest,
) -> Result<TablePage, QueryError> {
    let limit = effective_table_page_limit(request.limit)?;
    let (columns, row_identity) = sqlite_table_shape(handle, &request.object)?;
    let order = effective_sort_order(&request.sort, &row_identity);
    let from = quote_identifier(&request.object.name);

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
        quote_identifier,
    )?;

    // Fetch one extra row to learn whether another page exists without a
    // separate COUNT, which could scan the whole relation.
    let mut statement = handle.prepare(&sql).map_err(map_error)?;
    let parameters = bind_parameters(&values);
    let mut cursor = statement
        .query(rusqlite::params_from_iter(parameters.iter()))
        .map_err(map_error)?;

    let mut rows: Vec<Row> = Vec::new();
    let mut truncated = false;
    while let Some(row) = cursor.next().map_err(map_error)? {
        if rows.len() >= limit as usize {
            truncated = true;
            break;
        }
        let mut cells = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            cells.push(cell_from_value_ref(row.get_ref(index).map_err(map_error)?));
        }
        rows.push(cells);
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

impl DatabaseAdapter for SqliteAdapter {
    fn engine(&self) -> EngineId {
        EngineId::Sqlite
    }

    fn capabilities(&self) -> EngineCapabilities {
        // This slice implements connect/disconnect, metadata inspection, and
        // read-only SQL execution. Transaction, cancellation, and multi-scope
        // flags stay `false` so the UI never advertises behavior the adapter
        // cannot honor yet.
        EngineCapabilities::default()
    }

    fn test_connection<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        _secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionTest, QueryError>> {
        Box::pin(async move {
            let path = sqlite_path(descriptor)?;
            // Open and immediately release the handle; `test_connection` must
            // not retain a connection.
            drop(open_read_only(path)?);

            Ok(ConnectionTest {
                engine: EngineId::Sqlite,
                server_version: Some(rusqlite::version().to_string()),
            })
        })
    }

    fn connect<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        _secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionId, QueryError>> {
        Box::pin(async move {
            let path = sqlite_path(descriptor)?;
            let handle = open_read_only(path)?;

            let sequence = self.next_connection.fetch_add(1, Ordering::SeqCst) + 1;
            let connection = ConnectionId::new(format!("sqlite-{sequence}"));

            self.connection_slots().insert(
                connection.clone(),
                ConnectionSlot {
                    state: ConnectionState::Connected,
                    handle: Some(handle),
                },
            );

            Ok(connection)
        })
    }

    fn disconnect<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            let mut slots = self.connection_slots();
            let slot = slots
                .get_mut(connection)
                .ok_or_else(|| connection_error(connection))?;
            slot.state = ConnectionState::Disconnected;
            slot.handle = None;
            Ok(())
        })
    }

    fn connection_state<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ConnectionState, QueryError>> {
        Box::pin(async move {
            self.connection_slots()
                .get(connection)
                .map(|slot| slot.state)
                .ok_or_else(|| connection_error(connection))
        })
    }

    fn list_objects<'a>(
        &'a self,
        connection: &'a ConnectionId,
        _scope: &'a ObjectScope,
    ) -> AdapterFuture<'a, Result<Vec<ObjectRef>, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle| {
                // SQLite has neither a database/catalog nor a schema scope, so
                // the scope argument is intentionally ignored.
                let mut statement = handle
                    .prepare(
                        "SELECT name, type FROM sqlite_master \
                         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                         ORDER BY name COLLATE NOCASE, name",
                    )
                    .map_err(map_error)?;

                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(map_error)?;

                let mut objects = Vec::new();
                for row in rows {
                    let (name, kind) = row.map_err(map_error)?;
                    let kind = match kind.as_str() {
                        "table" => ObjectKind::Table,
                        "view" => ObjectKind::View,
                        _ => continue,
                    };
                    objects.push(ObjectRef {
                        database: None,
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
            self.with_connection(connection, |_| {
                Err(unsupported_error(
                    "SQLite does not expose database or schema scopes",
                ))
            })
        })
    }

    fn describe_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
    ) -> AdapterFuture<'a, Result<TableDescription, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |handle| {
                let (columns, primary_key_columns) = sqlite_table_shape(handle, object)?;

                // Indexes and constraints are reported as inspected lists, never
                // as an empty success: SQLite always exposes `pragma_index_list`
                // and `pragma_foreign_key_list`, even when the object has none.
                let discovered = sqlite_indexes(handle, &object.name)?;
                let indexes: Vec<IndexInfo> =
                    discovered.iter().map(|index| index.info.clone()).collect();

                let mut constraints = sqlite_foreign_keys(handle, &object.name)?;
                if !primary_key_columns.is_empty() {
                    // SQLite only lists a backing index when the primary key is
                    // not the rowid alias; otherwise synthesize a stable label.
                    let name = discovered
                        .iter()
                        .find(|index| index.origin == "pk")
                        .map(|index| index.info.name.clone())
                        .unwrap_or_else(|| format!("{}_pkey", object.name));
                    constraints.push(ConstraintInfo::primary_key(
                        name,
                        primary_key_columns.clone(),
                    ));
                }
                for index in discovered.iter().filter(|index| index.origin == "u") {
                    constraints.push(ConstraintInfo::unique(
                        index.info.name.clone(),
                        index.info.columns.clone(),
                    ));
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
            self.with_connection(connection, |handle| fetch_sqlite_page(handle, request))
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

            self.with_connection(connection, |handle| Ok(run_statement(handle, &request)))
        })
    }

    fn apply_change<'a>(
        &'a self,
        connection: &'a ConnectionId,
        _request: ChangeRequest,
    ) -> AdapterFuture<'a, Result<ChangeResult, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |_| {
                Err(unsupported_error(
                    "this connection is read-only and does not support data changes",
                ))
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
                "the SQLite driver does not support query cancellation",
            ))
        })
    }

    fn begin_transaction<'a>(
        &'a self,
        _connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<TransactionId, QueryError>> {
        Box::pin(async move {
            Err(unsupported_error(
                "explicit transactions are not implemented for SQLite in this slice",
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
                "explicit transactions are not implemented for SQLite in this slice",
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
                "explicit transactions are not implemented for SQLite in this slice",
            ))
        })
    }
}

#[cfg(test)]
mod fixture_tests {
    use std::future::Future;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::task::{Context, Poll, Waker};

    use rusqlite::Connection;

    use super::SqliteAdapter;
    use crate::database::{
        ChangeRequest, ConnectionId, ConnectionState, ConstraintKind, DatabaseAdapter,
        FilterOperator, ObjectKind, ObjectRef, ObjectScope, PendingChange, RowKey, SortDirection,
        SortKey, TableFilter, TablePageRequest, TransactionId, MAX_TABLE_PAGE_ROWS,
    };
    use crate::domain::connection::{ServerConnection, SqliteConnection, TlsMode};
    use crate::domain::{
        CellValue, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory, OperationId,
        OperationState, QueryRequest,
    };

    /// Minimal executor for the immediately-ready futures the adapter returns.
    ///
    /// `rusqlite` is synchronous, so every adapter future completes on the first
    /// poll and no async runtime or reactor is required.
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

    /// Schema used by every fixture database.
    ///
    /// `audit_log` uses `AUTOINCREMENT` so SQLite creates its internal
    /// `sqlite_sequence` table, which object listing must hide.
    const FIXTURE_SCHEMA: &str = "
        CREATE TABLE teams (
            id INTEGER PRIMARY KEY NOT NULL
        );
        CREATE TABLE users (
            id INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            email TEXT UNIQUE,
            balance NUMERIC,
            team_id INTEGER REFERENCES teams(id)
        );
        CREATE INDEX users_name_idx ON users(name);
        CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL
        );
        CREATE VIEW active_users AS
            SELECT id, name FROM users WHERE name IS NOT NULL;
        INSERT INTO teams (id) VALUES (1);
        INSERT INTO users (id, name, email, balance, team_id) VALUES
            (1, 'alice', 'alice@example.com', 10.50, 1),
            (2, 'bob', NULL, 20.00, NULL),
            (3, 'carol', 'carol@example.com', NULL, NULL);
    ";

    /// A freshly created SQLite file removed when the test ends.
    struct TempDatabase {
        path: PathBuf,
    }

    impl TempDatabase {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let unique = format!(
                "dbtables-sqlite-fixture-{}-{}.sqlite",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            );
            let path = std::env::temp_dir().join(unique);
            let _ = std::fs::remove_file(&path);

            let connection = Connection::open(&path).expect("fixture database should open");
            connection
                .execute_batch(FIXTURE_SCHEMA)
                .expect("fixture schema should be created");
            drop(connection);

            Self { path }
        }

        fn descriptor(&self) -> ConnectionDescriptor {
            ConnectionDescriptor::Sqlite(SqliteConnection {
                file_path: self.path.to_string_lossy().into_owned(),
            })
        }
    }

    impl Drop for TempDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn unique_missing_path() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "dbtables-missing-{}-{}.sqlite",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn connected(adapter: &SqliteAdapter, fixture: &TempDatabase) -> ConnectionId {
        block_on(adapter.connect(&fixture.descriptor(), None)).expect("connect should succeed")
    }

    fn users_object() -> ObjectRef {
        ObjectRef {
            database: None,
            schema: None,
            name: "users".to_string(),
            kind: ObjectKind::Table,
        }
    }

    #[test]
    fn connect_and_disconnect_report_connection_state() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();

        assert_eq!(adapter.engine(), EngineId::Sqlite);
        let connection = connected(&adapter, &fixture);
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("state should resolve"),
            ConnectionState::Connected
        );

        block_on(adapter.disconnect(&connection)).expect("disconnect should succeed");
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("state should resolve"),
            ConnectionState::Disconnected
        );
    }

    #[test]
    fn test_connection_reports_sqlite_version_without_retaining_a_handle() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();

        let test = block_on(adapter.test_connection(&fixture.descriptor(), None))
            .expect("test connection should succeed");

        assert_eq!(test.engine, EngineId::Sqlite);
        let version = test.server_version.expect("SQLite should report a version");
        assert!(
            version.starts_with('3'),
            "unexpected SQLite version `{version}`"
        );
    }

    #[test]
    fn list_objects_returns_tables_and_views_but_not_internal_objects() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let objects = block_on(adapter.list_objects(&connection, &ObjectScope::default()))
            .expect("listing should succeed");

        let names: Vec<&str> = objects.iter().map(|object| object.name.as_str()).collect();
        assert_eq!(names, ["active_users", "audit_log", "teams", "users"]);

        let users = objects
            .iter()
            .find(|object| object.name == "users")
            .expect("users table should be listed");
        assert_eq!(users.kind, ObjectKind::Table);
        assert!(users.database.is_none(), "SQLite has no database scope");
        assert!(users.schema.is_none(), "SQLite has no schema scope");

        let view = objects
            .iter()
            .find(|object| object.name == "active_users")
            .expect("view should be listed");
        assert_eq!(view.kind, ObjectKind::View);

        assert!(
            !objects
                .iter()
                .any(|object| object.name.starts_with("sqlite_")),
            "internal SQLite objects must not be listed"
        );
    }

    #[test]
    fn describe_table_reports_columns_types_nullability_and_primary_key() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let description = block_on(adapter.describe_table(&connection, &users_object()))
            .expect("description should succeed");

        let names: Vec<&str> = description
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect();
        assert_eq!(names, ["id", "name", "email", "balance", "team_id"]);

        assert_eq!(description.columns[0].type_name.as_deref(), Some("INTEGER"));
        assert_eq!(description.columns[0].nullable, Some(false));
        assert_eq!(description.columns[1].nullable, Some(false));
        assert_eq!(description.columns[2].nullable, Some(true));
        assert_eq!(description.primary_key_columns, ["id"]);
    }

    #[test]
    fn describe_table_reports_indexes_and_constraints() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let description = block_on(adapter.describe_table(&connection, &users_object()))
            .expect("description should succeed");

        let indexes = description
            .indexes
            .expect("SQLite must report index metadata for a table");
        let name_index = indexes
            .iter()
            .find(|index| index.name == "users_name_idx")
            .expect("the named index should be listed");
        assert_eq!(name_index.columns, ["name"]);
        assert!(!name_index.unique);
        assert!(!name_index.primary);

        let unique_index = indexes
            .iter()
            .find(|index| index.unique && !index.primary)
            .expect("the UNIQUE column should have a backing index");
        assert_eq!(unique_index.columns, ["email"]);

        let constraints = description
            .constraints
            .expect("SQLite must report constraint metadata for a table");
        let primary = constraints
            .iter()
            .find(|constraint| constraint.kind == ConstraintKind::PrimaryKey)
            .expect("the primary key should be reported as a constraint");
        assert_eq!(primary.columns, ["id"]);

        let unique = constraints
            .iter()
            .find(|constraint| constraint.kind == ConstraintKind::Unique)
            .expect("the UNIQUE column should be reported as a constraint");
        assert_eq!(unique.columns, ["email"]);

        let foreign = constraints
            .iter()
            .find(|constraint| constraint.kind == ConstraintKind::ForeignKey)
            .expect("the foreign key should be reported as a constraint");
        assert_eq!(foreign.columns, ["team_id"]);
        assert_eq!(foreign.referenced_table.as_deref(), Some("teams"));
        assert_eq!(foreign.referenced_columns, ["id"]);
        assert!(
            foreign.name.contains("team_id"),
            "an unnamed SQLite foreign key still needs a stable label"
        );
    }

    #[test]
    fn describe_view_reports_columns_without_a_primary_key() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let view = ObjectRef {
            database: None,
            schema: None,
            name: "active_users".to_string(),
            kind: ObjectKind::View,
        };
        let description = block_on(adapter.describe_table(&connection, &view))
            .expect("view description should succeed");

        let names: Vec<&str> = description
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect();
        assert_eq!(names, ["id", "name"]);
        assert!(
            description.primary_key_columns.is_empty(),
            "a view has no stable primary key"
        );
        assert_eq!(
            description.indexes,
            Some(Vec::new()),
            "an inspected view reports no indexes rather than unsupported metadata"
        );
        assert_eq!(
            description.constraints,
            Some(Vec::new()),
            "an inspected view reports no constraints rather than unsupported metadata"
        );
    }

    #[test]
    fn describing_an_unknown_object_is_a_validation_error() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let missing = ObjectRef {
            database: None,
            schema: None,
            name: "does_not_exist".to_string(),
            kind: ObjectKind::Table,
        };
        let error = block_on(adapter.describe_table(&connection, &missing))
            .expect_err("an unknown object must fail");

        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn missing_file_is_a_connection_error_and_is_not_created() {
        let adapter = SqliteAdapter::new();
        let path = unique_missing_path();
        let descriptor = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: path.to_string_lossy().into_owned(),
        });

        let error = block_on(adapter.test_connection(&descriptor, None))
            .expect_err("a missing file must not open read-only");
        assert_eq!(error.category, ErrorCategory::Connection);
        assert!(
            !path.exists(),
            "the adapter must not create a database file"
        );
    }

    #[test]
    fn blank_path_is_a_configuration_error() {
        let adapter = SqliteAdapter::new();
        let descriptor = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "   ".to_string(),
        });

        let error = block_on(adapter.test_connection(&descriptor, None))
            .expect_err("a blank path must be rejected");
        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn a_non_sqlite_descriptor_is_rejected_before_touching_a_file() {
        let adapter = SqliteAdapter::new();
        let descriptor = ConnectionDescriptor::Postgres(ServerConnection {
            host: "localhost".to_string(),
            port: 5432,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
        });

        let error = block_on(adapter.test_connection(&descriptor, None))
            .expect_err("a mismatched descriptor must fail");
        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn unknown_connections_are_connection_errors() {
        let adapter = SqliteAdapter::new();
        let unknown = ConnectionId::new("does-not-exist");

        assert_eq!(
            block_on(adapter.connection_state(&unknown))
                .expect_err("unknown state must fail")
                .category,
            ErrorCategory::Connection
        );
        assert_eq!(
            block_on(adapter.list_objects(&unknown, &ObjectScope::default()))
                .expect_err("unknown listing must fail")
                .category,
            ErrorCategory::Connection
        );
        assert_eq!(
            block_on(adapter.disconnect(&unknown))
                .expect_err("unknown disconnect must fail")
                .category,
            ErrorCategory::Connection
        );
    }

    #[test]
    fn capabilities_expose_only_the_implemented_slice() {
        let adapter = SqliteAdapter::new();
        assert_eq!(adapter.capabilities(), EngineCapabilities::default());
    }

    #[test]
    fn read_only_slice_exposes_reads_but_not_writes() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let select = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-select", "SELECT * FROM users"),
        ))
        .expect("SQL execution is implemented for the read-only slice");
        assert_eq!(select.state, crate::domain::OperationState::Succeeded);

        let change = PendingChange::insert(vec![RowKey::new("id", CellValue::Integer(99))]);
        let apply = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-1", users_object(), change),
        ))
        .expect_err("a read-only connection must not apply changes");
        assert_eq!(apply.category, ErrorCategory::Unsupported);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-1", users_object(), 10),
        ))
        .expect("table browsing is implemented for the read-only slice");
        assert_eq!(page.row_identity, ["id"]);
        assert_eq!(page.rows.len(), 3);

        let cancelled = block_on(adapter.cancel(&connection, &OperationId::new("op-select")))
            .expect_err("SQLite cancellation is unsupported");
        assert_eq!(cancelled.category, ErrorCategory::Unsupported);
    }

    #[test]
    fn fetch_table_page_pages_deterministically_with_a_row_identity() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let first = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-1", users_object(), 2).with_sort(vec![SortKey {
                column: "name".to_string(),
                direction: SortDirection::Descending,
            }]),
        ))
        .expect("first page should succeed");

        assert_eq!(first.operation_id.as_str(), "page-1");
        let columns: Vec<&str> = first.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(columns, ["id", "name", "email", "balance", "team_id"]);
        assert_eq!(first.row_identity, ["id"]);
        assert_eq!(first.limit, 2);
        assert_eq!(first.offset, 0);
        assert_eq!(first.rows.len(), 2);
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(first.rows[0][1], CellValue::Text("carol".to_string()));
        assert_eq!(first.rows[1][1], CellValue::Text("bob".to_string()));

        let second = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-2", users_object(), 2)
                .with_offset(2)
                .with_sort(vec![SortKey {
                    column: "name".to_string(),
                    direction: SortDirection::Descending,
                }]),
        ))
        .expect("second page should succeed");

        assert_eq!(second.offset, 2);
        assert_eq!(second.rows.len(), 1);
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        assert_eq!(second.rows[0][1], CellValue::Text("alice".to_string()));
    }

    #[test]
    fn fetch_table_page_binds_filters_and_rejects_unknown_identifiers() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("filter-1", users_object(), 10).with_filters(vec![
                TableFilter {
                    column: "name".to_string(),
                    operator: FilterOperator::Like,
                    values: vec![CellValue::Text("a%".to_string())],
                },
                TableFilter {
                    column: "balance".to_string(),
                    operator: FilterOperator::GreaterThan,
                    values: vec![CellValue::Integer(10)],
                },
            ]),
        ))
        .expect("valid filters should succeed");

        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0][1], CellValue::Text("alice".to_string()));

        let filter_error = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("filter-2", users_object(), 10).with_filters(vec![
                TableFilter {
                    column: "name = 'alice'".to_string(),
                    operator: FilterOperator::Equal,
                    values: vec![CellValue::Text("alice".to_string())],
                },
            ]),
        ))
        .expect_err("an unknown filter column must be rejected");
        assert_eq!(filter_error.category, ErrorCategory::Validation);

        let sort_error = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("sort-1", users_object(), 10).with_sort(vec![SortKey {
                column: "id); DROP TABLE users; --".to_string(),
                direction: SortDirection::Ascending,
            }]),
        ))
        .expect_err("an unknown sort column must be rejected");
        assert_eq!(sort_error.category, ErrorCategory::Validation);
    }

    #[test]
    fn fetch_table_page_reports_no_identity_for_a_view() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let view = ObjectRef {
            database: None,
            schema: None,
            name: "active_users".to_string(),
            kind: ObjectKind::View,
        };
        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("view-page", view, 10),
        ))
        .expect("paging a view should succeed");

        assert_eq!(page.rows.len(), 3);
        assert!(
            page.row_identity.is_empty(),
            "a view has no safe row identity and must say so"
        );
        assert!(!page.has_row_identity());
    }

    #[test]
    fn fetch_table_page_rejects_zero_and_clamps_large_limits() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let zero = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-zero", users_object(), 0),
        ))
        .expect_err("a zero page size must be rejected");
        assert_eq!(zero.category, ErrorCategory::Validation);

        let clamped = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-clamped", users_object(), MAX_TABLE_PAGE_ROWS + 5),
        ))
        .expect("an oversized limit should be clamped, not rejected");
        assert_eq!(clamped.limit, MAX_TABLE_PAGE_ROWS);
    }

    #[test]
    fn execute_returns_normalized_columns_rows_and_duration() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-select", "SELECT id, name FROM users ORDER BY id"),
        ))
        .expect("select should return a result");

        assert_eq!(result.state, OperationState::Succeeded);
        let names: Vec<&str> = result
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect();
        assert_eq!(names, ["id", "name"]);
        assert_eq!(result.rows.len(), 3);
        assert_eq!(result.rows[0][0], CellValue::Integer(1));
        assert_eq!(result.rows[1][0], CellValue::Integer(2));
        assert!(!result.truncated);
        assert!(result.duration_ms.is_some());
    }

    #[test]
    fn execute_returns_an_empty_succeeded_result_for_a_query_with_no_rows() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-empty", "SELECT id, name FROM users WHERE 0"),
        ))
        .expect("an empty select should return a result");

        assert_eq!(result.state, OperationState::Succeeded);
        assert_eq!(result.columns.len(), 2);
        assert!(result.rows.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn execute_maps_syntax_errors_to_failed_results() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-bad", "SELECT FROM WHERE"),
        ))
        .expect("invalid SQL still produces a result");

        assert_eq!(result.state, OperationState::Failed);
        assert!(!result.state.is_success());
        let error = result.error.expect("failed result should carry an error");
        assert_eq!(error.category, ErrorCategory::Syntax);
    }

    #[test]
    fn execute_maps_a_missing_table_to_a_validation_error() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-missing", "SELECT * FROM does_not_exist"),
        ))
        .expect("a missing table still produces a result");

        assert_eq!(result.state, OperationState::Failed);
        let error = result.error.expect("failed result should carry an error");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn execute_caps_rows_and_marks_the_result_truncated() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-cap", "SELECT id FROM users ORDER BY id").with_max_rows(2),
        ))
        .expect("capped select should return a result");

        assert_eq!(result.state, OperationState::Succeeded);
        assert_eq!(result.rows.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn execute_binds_parameters_and_normalizes_scalar_values() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let bound = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-param", "SELECT name FROM users WHERE id = ?")
                .with_parameters(vec![CellValue::Integer(2)]),
        ))
        .expect("a bound select should return a result");
        assert_eq!(
            bound.rows,
            vec![vec![CellValue::Text("bob".to_string())]]
        );

        let scalars = block_on(adapter.execute(
            &connection,
            QueryRequest::new(
                "op-scalars",
                "SELECT NULL AS missing, x'0102' AS data, 1 AS one, 1.5 AS real",
            ),
        ))
        .expect("scalar select should return a result");
        assert_eq!(scalars.rows.len(), 1);
        assert_eq!(scalars.rows[0][0], CellValue::Null);
        assert_eq!(scalars.rows[0][1], CellValue::Bytes(vec![1, 2]));
        assert_eq!(scalars.rows[0][2], CellValue::Integer(1));
        assert_eq!(scalars.rows[0][3], CellValue::Float(1.5));
    }

    #[test]
    fn execute_rejects_multiple_statements() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-many", "SELECT 1; SELECT 2"),
        ))
        .expect("multiple statements still produce a result");

        assert_eq!(result.state, OperationState::Failed);
        let error = result.error.expect("failed result should carry an error");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn execute_rejects_blank_sql_before_touching_the_connection() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let error = block_on(adapter.execute(&connection, QueryRequest::new("op-blank", "   ")))
            .expect_err("blank SQL is a precondition failure");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn execute_blocks_writes_on_a_read_only_connection() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new(
                "op-write",
                "INSERT INTO users (id, name) VALUES (100, 'mallory')",
            ),
        ))
        .expect("a rejected write still produces a result");

        assert_eq!(result.state, OperationState::Failed);
        assert!(!result.state.is_success());
        let error = result.error.expect("failed result should carry an error");
        assert_eq!(error.category, ErrorCategory::Permission);
    }

    #[test]
    fn execute_on_an_unknown_connection_is_a_connection_error() {
        let adapter = SqliteAdapter::new();
        let unknown = ConnectionId::new("does-not-exist");

        let error = block_on(adapter.execute(&unknown, QueryRequest::new("op", "SELECT 1")))
            .expect_err("an unknown connection must not execute");
        assert_eq!(error.category, ErrorCategory::Connection);
    }

    #[test]
    fn explicit_transactions_are_reported_unsupported() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let begin = block_on(adapter.begin_transaction(&connection))
            .expect_err("transactions are not implemented in this slice");
        assert_eq!(begin.category, ErrorCategory::Unsupported);

        let transaction = TransactionId::new("tx-1");
        assert_eq!(
            block_on(adapter.commit(&connection, &transaction))
                .expect_err("commit is not implemented in this slice")
                .category,
            ErrorCategory::Unsupported
        );
        assert_eq!(
            block_on(adapter.rollback(&connection, &transaction))
                .expect_err("rollback is not implemented in this slice")
                .category,
            ErrorCategory::Unsupported
        );
    }
}
