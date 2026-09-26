//! Cross-engine adapter contract suite (spec task T3).
//!
//! This binary is a thin driver over the reusable harness in [`contract`]. Each
//! engine is an independent test so a failure names the engine that broke the
//! shared expectations. SQLite always runs against a temporary fixture; MySQL
//! and PostgreSQL run only when their test-server environment variables are set.
//! See `tests/README.md` for the configuration and the documented capability
//! differences.

mod contract;

use dbtables_lib::database::testing::FakeAdapter;
use dbtables_lib::database::{DatabaseAdapter, MySqlAdapter, PostgresAdapter, SqliteAdapter};
use dbtables_lib::domain::{
    ConnectionDescriptor, EngineCapabilities, EngineId, OperationState, QueryRequest,
    SqliteConnection,
};

/// SQLite always satisfies the shared contract using a controlled fixture.
#[test]
fn sqlite_satisfies_the_shared_adapter_contract() {
    let fixture = contract::TempSqliteDatabase::create();
    let target = contract::sqlite_target(&fixture);
    contract::run_contract(&target);
}

/// MySQL satisfies the shared contract when a disposable server is configured.
///
/// Set `DBTABLES_MYSQL_TEST_HOST` (and the optional connection variables) to run
/// it; otherwise this test returns early and needs no server or credential.
#[test]
fn mysql_satisfies_the_shared_adapter_contract_when_configured() {
    let Some(target) = contract::mysql_target() else {
        return;
    };
    contract::run_contract(&target);
}

/// PostgreSQL satisfies the shared contract when a disposable server is configured.
///
/// Set `DBTABLES_POSTGRES_TEST_HOST` (and the optional connection variables) to
/// run it; otherwise this test returns early.
#[test]
fn postgres_satisfies_the_shared_adapter_contract_when_configured() {
    let Some(target) = contract::postgres_target() else {
        return;
    };
    contract::run_contract(&target);
}

/// The writable slice's capability differences are explicit, not silent.
///
/// `EngineId::capabilities()` records the long-term intent; these are the
/// capabilities the shipped adapters actually honor today. Any change here is a
/// deliberate contract change, so the test pins the exact sets.
#[test]
fn writable_slice_capabilities_are_explicit() {
    assert_eq!(
        SqliteAdapter::new().capabilities(),
        EngineCapabilities {
            transactions: true,
            ddl_transactions: true,
            savepoints: false,
            cancellation: false,
            schemas: false,
            multiple_databases: false,
            tls: false,
        },
        "SQLite exposes guarded writes and transactions",
    );

    assert_eq!(
        MySqlAdapter::new().capabilities(),
        EngineCapabilities {
            transactions: true,
            ddl_transactions: false,
            savepoints: false,
            cancellation: false,
            schemas: false,
            multiple_databases: true,
            tls: true,
        },
        "MySQL exposes databases (not schemas) over TLS-capable connections",
    );

    assert_eq!(
        PostgresAdapter::new().capabilities(),
        EngineCapabilities {
            transactions: true,
            ddl_transactions: true,
            savepoints: false,
            cancellation: false,
            schemas: true,
            multiple_databases: false,
            tls: true,
        },
        "PostgreSQL exposes schemas over a single-database connection",
    );
}

/// A successful DML result carries affected-row and duration metadata.
///
/// The deterministic fake models a writable engine, so this pins the positive
/// result *shape*. The real adapters are covered by the shared contract, where a
/// confirmed write must also report affected rows and a rejected write must be a
/// categorized terminal failure.
#[test]
fn successful_dml_result_reports_affected_rows_and_duration() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("contract test runtime should build");

    runtime.block_on(async {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let descriptor = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "C:/data/contract.sqlite".to_string(),
        });
        let connection = adapter
            .connect(&descriptor, None)
            .await
            .expect("fake connect should succeed");

        let result = adapter
            .execute(
                &connection,
                QueryRequest::new(
                    "contract-dml-success",
                    "INSERT INTO contract_users (id, name) VALUES (9001, 'contract')",
                ),
            )
            .await
            .expect("a DML statement should produce a normalized result");

        assert_eq!(result.state, OperationState::Succeeded);
        assert_eq!(
            result.affected_rows,
            Some(1),
            "a confirmed DML result must report its affected-row count",
        );
        assert!(
            result.duration_ms.is_some(),
            "a confirmed DML result must report a duration",
        );
        assert!(
            result.error.is_none(),
            "a confirmed DML result must not carry an error",
        );
    });
}
