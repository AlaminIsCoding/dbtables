//! Reusable cross-engine adapter contract suite (spec task T3).
//!
//! The same [`run_contract`] function runs against every configured engine, so
//! SQLite, MySQL, and PostgreSQL are held to one set of shared expectations
//! instead of three drifting test suites. Only the engine-specific details
//! (which scopes exist, which SQL reaches an object the test controls) are
//! parameters; the behavior assertions are identical.
//!
//! The suite covers the contract in `database::mod.rs`:
//!
//! - `test_connection` and `connect`, with the connection reporting `Connected`.
//! - `list_scopes` for engines that expose scopes, and an explicit
//!   `Unsupported` error for engines that do not.
//! - `list_objects` / `describe_table` metadata with at least one column.
//! - `execute` on a `SELECT`, returning normalized columns, rows, and duration.
//! - `execute` on a DML statement, confirming the normalized result metadata:
//!   either a confirmed write that reports its affected-row count, or a
//!   categorized terminal failure. Never a success without affected rows and
//!   never a fabricated count.
//! - `execute` on invalid SQL, returning a structured `Syntax` failure.
//! - `disconnect`, with the connection reporting `Disconnected`.
//!
//! **Capability differences are documented, not hidden.** SQLite exposes no
//! scopes and returns `Unsupported`; MySQL exposes databases/catalogs; PostgreSQL
//! exposes schemas and binds a connection to one database. The shipped adapters
//! implement guarded staged writes, so a DML statement may confirm a write with
//! an affected-row count on a controlled table; the structured-result contract
//! still holds either way.
//!
//! **Secrets stay out of test output.** Passwords are read only from environment
//! variables and are never printed, asserted on, or written to a fixture. When a
//! server engine is not configured the relevant test returns early, so the
//! default `cargo test` run needs no server and never needs a credential.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use dbtables_lib::database::{
    ConnectionSecret, ConnectionState, ConstraintKind, DatabaseAdapter, ObjectScope,
};
use dbtables_lib::database::{MySqlAdapter, PostgresAdapter, SqliteAdapter};
use dbtables_lib::domain::{
    CellValue, ConnectionDescriptor, EngineId, ErrorCategory, OperationState, QueryRequest,
    ServerConnection, SqliteConnection, TlsMode,
};

/// `SELECT` that every supported engine evaluates the same way.
const SELECT_SQL: &str = "SELECT 1 AS one";

/// Invalid SQL that every supported engine rejects while parsing.
const INVALID_SQL: &str = "SELECT FROM WHERE";

/// DML used when the test cannot assume any particular table exists.
const MISSING_TABLE_DML_SQL: &str = "INSERT INTO dbtables_contract_probe (id) VALUES (1)";

/// How an engine reports its database/schema scopes.
///
/// This is the one behavior that legitimately differs across engines; the
/// contract records the difference explicitly instead of papering over it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeExpectation {
    /// The engine exposes neither databases nor schemas (SQLite) and must
    /// return an `Unsupported` error rather than inventing a scope.
    Unsupported,
    /// The engine exposes databases/catalogs only (MySQL).
    Databases,
    /// The engine exposes named schemas only (PostgreSQL).
    Schemas,
}

/// One configured engine plus the engine-specific details the shared contract
/// runner needs.
pub struct EngineTarget {
    /// Engine the adapter serves.
    pub engine: EngineId,
    /// Adapter under test, addressed through the shared boundary.
    pub adapter: Box<dyn DatabaseAdapter>,
    /// Secret-free descriptor used to reach the engine.
    pub descriptor: ConnectionDescriptor,
    /// Credential resolved for the descriptor, when the engine needs one.
    pub secret: Option<ConnectionSecret>,
    /// How this engine reports scopes.
    pub scopes: ScopeExpectation,
    /// A base table the contract requires `list_objects` to contain.
    ///
    /// `Some` only when the test controls the schema (the SQLite fixture).
    /// Server engines leave it `None` because their contents are supplied by
    /// the user's disposable test database.
    pub known_table: Option<&'static str>,
    /// DML used for the result-metadata expectation.
    pub dml_sql: &'static str,
}

impl EngineTarget {
    fn secret(&self) -> Option<&ConnectionSecret> {
        self.secret.as_ref()
    }
}

/// A temporary SQLite database created for the contract run and removed after.
pub struct TempSqliteDatabase {
    path: PathBuf,
}

impl TempSqliteDatabase {
    /// Creates a fresh database with a small, known schema.
    pub fn create() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = format!(
            "dbtables-contract-{}-{}.sqlite",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(unique);
        // Start from a clean path so a leftover file cannot change the fixture.
        let _ = std::fs::remove_file(&path);

        let connection = rusqlite::Connection::open(&path).expect("contract fixture should open");
        connection
            .execute_batch(FIXTURE_SCHEMA)
            .expect("contract fixture schema should apply");
        drop(connection);

        Self { path }
    }

    /// Descriptor pointing the SQLite adapter at this fixture.
    pub fn descriptor(&self) -> ConnectionDescriptor {
        ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: self.path.to_string_lossy().into_owned(),
        })
    }
}

impl Drop for TempSqliteDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The SQLite fixture schema.
///
/// `contract_audit` uses `AUTOINCREMENT` so SQLite creates its internal
/// `sqlite_sequence` table, which object listing must hide; the expected table
/// below is what the contract requires to be listed.
const FIXTURE_SCHEMA: &str = "
    CREATE TABLE contract_teams (
        id INTEGER PRIMARY KEY NOT NULL
    );
    CREATE TABLE contract_users (
        id INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        team_id INTEGER REFERENCES contract_teams(id)
    );
    CREATE INDEX contract_users_name_idx ON contract_users(name);
    CREATE TABLE contract_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL
    );
    CREATE VIEW contract_active_users AS
        SELECT id, name FROM contract_users WHERE name IS NOT NULL;
    INSERT INTO contract_users (id, name, email) VALUES (1, 'alice', 'alice@example.com'), (2, 'bob', NULL);
";

/// Builds the always-available SQLite target.
///
/// The caller keeps `fixture` alive for the duration of the run; the database
/// file is removed when the fixture drops.
pub fn sqlite_target(fixture: &TempSqliteDatabase) -> EngineTarget {
    EngineTarget {
        engine: EngineId::Sqlite,
        adapter: Box::new(SqliteAdapter::new()),
        descriptor: fixture.descriptor(),
        secret: None,
        scopes: ScopeExpectation::Unsupported,
        known_table: Some("contract_users"),
        dml_sql: "INSERT INTO contract_users (id, name) VALUES (9001, 'contract')",
    }
}

/// Builds the MySQL target when `DBTABLES_MYSQL_TEST_HOST` is set, else `None`.
///
/// Reads the same variables as the adapter's own integration tests:
/// `_HOST` (required), `_PORT`, `_DATABASE`, `_USER`, `_PASSWORD`, `_TLS`.
pub fn mysql_target() -> Option<EngineTarget> {
    let host = env_value("DBTABLES_MYSQL_TEST_HOST")?;
    let port = env_value("DBTABLES_MYSQL_TEST_PORT")
        .and_then(|value| value.parse().ok())
        .unwrap_or(3306);
    let server = ServerConnection {
        host,
        port,
        database: env_value("DBTABLES_MYSQL_TEST_DATABASE"),
        username: env_value("DBTABLES_MYSQL_TEST_USER").unwrap_or_else(|| "root".to_string()),
        tls: tls_from_env("DBTABLES_MYSQL_TEST_TLS"),
    };
    let secret = env_value("DBTABLES_MYSQL_TEST_PASSWORD").map(ConnectionSecret::new);

    Some(EngineTarget {
        engine: EngineId::MySql,
        adapter: Box::new(MySqlAdapter::new()),
        descriptor: ConnectionDescriptor::MySql(server),
        secret,
        scopes: ScopeExpectation::Databases,
        known_table: None,
        dml_sql: MISSING_TABLE_DML_SQL,
    })
}

/// Builds the PostgreSQL target when `DBTABLES_POSTGRES_TEST_HOST` is set.
///
/// Reads the same variables as the adapter's own integration tests:
/// `_HOST` (required), `_PORT`, `_DATABASE`, `_USER`, `_PASSWORD`, `_TLS`.
pub fn postgres_target() -> Option<EngineTarget> {
    let host = env_value("DBTABLES_POSTGRES_TEST_HOST")?;
    let port = env_value("DBTABLES_POSTGRES_TEST_PORT")
        .and_then(|value| value.parse().ok())
        .unwrap_or(5432);
    let server = ServerConnection {
        host,
        port,
        database: env_value("DBTABLES_POSTGRES_TEST_DATABASE"),
        username: env_value("DBTABLES_POSTGRES_TEST_USER")
            .unwrap_or_else(|| "postgres".to_string()),
        tls: tls_from_env("DBTABLES_POSTGRES_TEST_TLS"),
    };
    let secret = env_value("DBTABLES_POSTGRES_TEST_PASSWORD").map(ConnectionSecret::new);

    Some(EngineTarget {
        engine: EngineId::Postgres,
        adapter: Box::new(PostgresAdapter::new()),
        descriptor: ConnectionDescriptor::Postgres(server),
        secret,
        scopes: ScopeExpectation::Schemas,
        known_table: None,
        dml_sql: MISSING_TABLE_DML_SQL,
    })
}

/// Runs the shared contract against one configured engine.
pub fn run_contract(target: &EngineTarget) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("contract test runtime should build");
    runtime.block_on(run_contract_async(target));
}

/// The shared expectations, independent of which engine is under test.
async fn run_contract_async(target: &EngineTarget) {
    let engine = target.engine;
    let adapter = target.adapter.as_ref();
    let descriptor = &target.descriptor;

    // Connect, and prove the connection is usable before inspecting anything.
    let tested = adapter
        .test_connection(descriptor, target.secret())
        .await
        .expect("test_connection should succeed for a configured engine");
    assert_eq!(
        tested.engine, engine,
        "{engine}: test_connection must report the target engine",
    );

    let connection = adapter
        .connect(descriptor, target.secret())
        .await
        .expect("connect should succeed for a configured engine");
    assert_eq!(
        adapter
            .connection_state(&connection)
            .await
            .expect("connection state should resolve"),
        ConnectionState::Connected,
        "{engine}: a fresh connection must report Connected",
    );

    // Scopes: engines that have none must say so explicitly.
    let scope = match target.scopes {
        ScopeExpectation::Unsupported => {
            let error = adapter
                .list_scopes(&connection)
                .await
                .expect_err("this engine exposes no database/schema scopes");
            assert_eq!(
                error.category,
                ErrorCategory::Unsupported,
                "{engine}: missing scopes must be surfaced as Unsupported",
            );
            ObjectScope::default()
        }
        ScopeExpectation::Databases => {
            let listing = adapter
                .list_scopes(&connection)
                .await
                .expect("databases should list for this engine");
            assert!(
                !listing.databases.is_empty(),
                "{engine}: at least one database must be listed",
            );
            assert!(
                listing.schemas.is_empty(),
                "{engine}: this engine must not also report schemas",
            );
            ObjectScope {
                database: target
                    .descriptor
                    .server()
                    .and_then(|server| server.database.clone())
                    .or_else(|| listing.databases.first().cloned()),
                schema: None,
            }
        }
        ScopeExpectation::Schemas => {
            let listing = adapter
                .list_scopes(&connection)
                .await
                .expect("schemas should list for this engine");
            assert!(
                !listing.schemas.is_empty(),
                "{engine}: at least one schema must be listed",
            );
            assert!(
                listing.databases.is_empty(),
                "{engine}: this engine must not also report databases",
            );
            ObjectScope::default()
        }
    };

    // Metadata: every listed object can be described with at least one column,
    // and the detail call reports inspected index/constraint lists (Some) rather
    // than silently omitting a category the adapter cannot provide.
    let objects = adapter
        .list_objects(&connection, &scope)
        .await
        .expect("object listing should succeed");
    if let Some(known) = target.known_table {
        assert!(
            objects.iter().any(|object| object.name == known),
            "{engine}: expected table `{known}` to be listed",
        );
    }
    if let Some(first) = objects.first() {
        let description = adapter
            .describe_table(&connection, first)
            .await
            .expect("describing a listed object should succeed");
        assert!(
            !description.columns.is_empty(),
            "{engine}: a described object must report at least one column",
        );
        assert!(
            description.indexes.is_some(),
            "{engine}: index metadata must be inspected (Some), not omitted as unsupported",
        );
        assert!(
            description.constraints.is_some(),
            "{engine}: constraint metadata must be inspected (Some), not omitted as unsupported",
        );
        for constraint in description.constraints.as_deref().unwrap_or_default() {
            if constraint.kind == ConstraintKind::ForeignKey {
                assert!(
                    constraint.referenced_table.is_some(),
                    "{engine}: a reported foreign key must name its referenced table",
                );
                assert!(
                    !constraint.columns.is_empty(),
                    "{engine}: a reported foreign key must name its constrained columns",
                );
            }
        }
    }

    // A controlled fixture proves index/constraint discovery has real content,
    // not just an empty inspected list.
    if let Some(known) = target.known_table {
        let known_object = objects
            .iter()
            .find(|object| object.name == known)
            .expect("the controlled table must be listed before describing it");
        let description = adapter
            .describe_table(&connection, known_object)
            .await
            .expect("describing the controlled table should succeed");
        assert!(
            description
                .indexes
                .as_deref()
                .is_some_and(|indexes| !indexes.is_empty()),
            "{engine}: the controlled table must report at least one index",
        );
        assert!(
            description
                .constraints
                .as_deref()
                .is_some_and(|constraints| !constraints.is_empty()),
            "{engine}: the controlled table must report at least one constraint",
        );
    }

    // SELECT: normalized column/row metadata plus a duration.
    let select = adapter
        .execute(
            &connection,
            QueryRequest::new("contract-select", SELECT_SQL),
        )
        .await
        .expect("a valid SELECT should produce a normalized result");
    assert_eq!(
        select.operation_id.as_str(),
        "contract-select",
        "{engine}: the operation id must be echoed",
    );
    assert_eq!(
        select.state,
        OperationState::Succeeded,
        "{engine}: a valid SELECT must succeed",
    );
    assert_eq!(
        select.columns.len(),
        1,
        "{engine}: `{SELECT_SQL}` must report exactly one column",
    );
    assert_eq!(
        select.columns[0].name, "one",
        "{engine}: the SELECT column label must be preserved",
    );
    assert_eq!(
        select.rows.len(),
        1,
        "{engine}: `{SELECT_SQL}` must return exactly one row",
    );
    assert!(
        select.rows[0].len() == 1 && is_numeric_one(&select.rows[0][0]),
        "{engine}: the SELECT value must normalize to the numeric value 1, got {:?}",
        select.rows[0],
    );
    assert!(
        select.duration_ms.is_some(),
        "{engine}: a completed SELECT must report a duration",
    );
    assert!(
        !select.truncated,
        "{engine}: a single-row SELECT must not be reported as truncated",
    );

    // DML-result metadata: a write either succeeds with a confirmed affected-row
    // count or comes back as a categorized terminal failure — never a success
    // without affected rows and never a fabricated count.
    let dml = adapter
        .execute(
            &connection,
            QueryRequest::new("contract-dml", target.dml_sql),
        )
        .await
        .expect("a DML statement should still produce a normalized result");
    assert!(
        dml.state.is_terminal(),
        "{engine}: a DML result must be terminal",
    );
    assert!(
        dml.duration_ms.is_some(),
        "{engine}: a completed DML result must report a duration",
    );
    if dml.state.is_success() {
        assert!(
            dml.affected_rows.is_some(),
            "{engine}: a confirmed write must report its affected-row count",
        );
        assert!(
            dml.error.is_none(),
            "{engine}: a confirmed write must not carry an error",
        );
    } else {
        assert!(
            dml.affected_rows.is_none(),
            "{engine}: a rejected write must not fabricate affected rows",
        );
        let dml_error = dml
            .error
            .expect("a rejected write must carry a normalized error");
        assert!(
            matches!(
                dml_error.category,
                ErrorCategory::Permission
                    | ErrorCategory::Validation
                    | ErrorCategory::Unsupported
                    | ErrorCategory::Constraint
                    | ErrorCategory::Locking
            ),
            "{engine}: a rejected write must be categorized, not hidden (got {})",
            dml_error.category,
        );
    }

    // Invalid query: a structured syntax failure, not a panic or a silent success.
    let invalid = adapter
        .execute(
            &connection,
            QueryRequest::new("contract-invalid", INVALID_SQL),
        )
        .await
        .expect("invalid SQL should still produce a normalized result");
    assert_eq!(
        invalid.state,
        OperationState::Failed,
        "{engine}: `{INVALID_SQL}` must fail",
    );
    let invalid_error = invalid
        .error
        .expect("an invalid statement must carry a normalized error");
    assert_eq!(
        invalid_error.category,
        ErrorCategory::Syntax,
        "{engine}: invalid SQL must be categorized as Syntax",
    );

    // Disconnect and confirm the handle is no longer usable.
    adapter
        .disconnect(&connection)
        .await
        .expect("disconnect should succeed");
    assert_eq!(
        adapter
            .connection_state(&connection)
            .await
            .expect("connection state should resolve"),
        ConnectionState::Disconnected,
        "{engine}: a disconnected handle must report Disconnected",
    );
}

/// Whether a normalized cell preserves the numeric value `1`.
///
/// Engines report `SELECT 1` through different type mappings (SQLite/MySQL as
/// an integer, some PostgreSQL type choices as exact decimal text), so the
/// contract accepts the exact numeric representations instead of assuming one.
fn is_numeric_one(cell: &CellValue) -> bool {
    match cell {
        CellValue::Integer(1) => true,
        CellValue::Decimal(text) | CellValue::Text(text) => text.trim() == "1",
        _ => false,
    }
}

/// Reads a non-empty environment variable, or `None` when unset/blank.
fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Maps a `_TLS` environment value onto a [`TlsMode`], defaulting to disabled.
fn tls_from_env(name: &str) -> TlsMode {
    match env_value(name).as_deref() {
        Some("preferred") => TlsMode::Preferred,
        Some("required") => TlsMode::Required,
        Some("verify_ca") => TlsMode::VerifyCa,
        Some("verify_full") => TlsMode::VerifyFull,
        _ => TlsMode::Disabled,
    }
}
