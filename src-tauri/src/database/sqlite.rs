//! Read-only SQLite adapter backed by `rusqlite`.
//!
//! This module implements the metadata half of the shared
//! [`DatabaseAdapter`] contract for local SQLite files:
//!
//! - Connect to an existing file, report its state, and disconnect.
//! - List base tables and views, excluding SQLite's internal `sqlite_*` objects.
//! - Describe an object's columns and primary key using table-valued pragmas.
//!
//! The read-only SQLite slice deliberately implements only these operations.
//! SQL execution, table paging, and staged changes arrive in later tasks and
//! report [`ErrorCategory::Unsupported`] until then, so no write path is exposed
//! and [`Self::capabilities`] reports only what the adapter can honor today.
//!
//! Design rules:
//!
//! - Connections are opened with `SQLITE_OPEN_READ_ONLY`. The adapter cannot
//!   create a database file or mutate an existing one.
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
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::database::{
    AdapterFuture, CancelOutcome, ChangeRequest, ChangeResult, ConnectionId, ConnectionSecret,
    ConnectionState, ConnectionTest, DatabaseAdapter, ObjectKind, ObjectRef, ObjectScope,
    ScopeListing, TableDescription, TablePage, TablePageRequest, TransactionId,
};
use crate::domain::{
    ColumnInfo, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory, OperationId,
    QueryError, QueryRequest, QueryResult,
};

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
        rusqlite::Error::InvalidQuery => QueryError::new(
            ErrorCategory::Validation,
            "the SQLite statement is not a valid read-only query",
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

impl DatabaseAdapter for SqliteAdapter {
    fn engine(&self) -> EngineId {
        EngineId::Sqlite
    }

    fn capabilities(&self) -> EngineCapabilities {
        // This slice implements connect/disconnect and metadata inspection only.
        // Reporting every other operation as unsupported keeps the capability
        // flags honest rather than advertising behavior the adapter lacks.
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

                // `pragma_table_info` accepts its table argument as a bound
                // value, so the object name is never concatenated into SQL.
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

                Ok(TableDescription {
                    columns,
                    primary_key_columns: primary_key.into_iter().map(|(_, name)| name).collect(),
                })
            })
        })
    }

    fn fetch_table_page<'a>(
        &'a self,
        connection: &'a ConnectionId,
        _request: TablePageRequest,
    ) -> AdapterFuture<'a, Result<TablePage, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |_| {
                Err(unsupported_error(
                    "table data browsing is not implemented in this slice",
                ))
            })
        })
    }

    fn execute<'a>(
        &'a self,
        connection: &'a ConnectionId,
        _request: QueryRequest,
    ) -> AdapterFuture<'a, Result<QueryResult, QueryError>> {
        Box::pin(async move {
            self.with_connection(connection, |_| {
                Err(unsupported_error(
                    "SQL execution is not implemented in this slice",
                ))
            })
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
        ChangeRequest, ConnectionId, ConnectionState, DatabaseAdapter, ObjectKind, ObjectRef,
        ObjectScope, PendingChange, RowKey, TablePageRequest, TransactionId,
    };
    use crate::domain::connection::{ServerConnection, SqliteConnection, TlsMode};
    use crate::domain::{
        CellValue, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory, OperationId,
        QueryRequest,
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
        CREATE TABLE users (
            id INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            email TEXT,
            balance NUMERIC
        );
        CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL
        );
        CREATE VIEW active_users AS
            SELECT id, name FROM users WHERE name IS NOT NULL;
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
        assert_eq!(names, ["active_users", "audit_log", "users"]);

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
        assert_eq!(names, ["id", "name", "email", "balance"]);

        assert_eq!(description.columns[0].type_name.as_deref(), Some("INTEGER"));
        assert_eq!(description.columns[0].nullable, Some(false));
        assert_eq!(description.columns[1].nullable, Some(false));
        assert_eq!(description.columns[2].nullable, Some(true));
        assert_eq!(description.primary_key_columns, ["id"]);
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
    fn read_only_slice_does_not_expose_sql_or_writes() {
        let fixture = TempDatabase::new();
        let adapter = SqliteAdapter::new();
        let connection = connected(&adapter, &fixture);

        let execute = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-select", "SELECT * FROM users"),
        ))
        .expect_err("SQL execution belongs to a later slice");
        assert_eq!(execute.category, ErrorCategory::Unsupported);

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
        .expect_err("table browsing belongs to a later slice");
        assert_eq!(page.category, ErrorCategory::Unsupported);

        let cancelled = block_on(adapter.cancel(&connection, &OperationId::new("op-select")))
            .expect_err("SQLite cancellation is unsupported");
        assert_eq!(cancelled.category, ErrorCategory::Unsupported);
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
