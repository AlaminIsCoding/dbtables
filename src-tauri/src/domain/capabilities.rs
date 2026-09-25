use serde::{Deserialize, Serialize};

/// Stable identifier for a supported database engine.
///
/// Wire values are lower-case and must stay in sync with the frontend
/// `EngineId` union in `src/domain/index.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EngineId {
    #[serde(rename = "sqlite")]
    Sqlite,
    #[serde(rename = "mysql")]
    MySql,
    #[serde(rename = "postgres")]
    Postgres,
}

impl EngineId {
    /// Stable wire/diagnostic value for this engine.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::MySql => "mysql",
            Self::Postgres => "postgres",
        }
    }

    /// Normalized capabilities for the engine.
    ///
    /// These are the initial expected values used before an adapter reports its
    /// own capability set. Adapters remain the source of truth because driver
    /// configuration can change what is actually supported.
    pub const fn capabilities(self) -> EngineCapabilities {
        match self {
            Self::Sqlite => EngineCapabilities {
                transactions: true,
                ddl_transactions: true,
                savepoints: true,
                cancellation: false,
                schemas: false,
                multiple_databases: false,
                tls: false,
            },
            Self::MySql => EngineCapabilities {
                transactions: true,
                // MySQL performs an implicit commit around DDL statements.
                ddl_transactions: false,
                savepoints: true,
                cancellation: true,
                schemas: true,
                multiple_databases: true,
                tls: true,
            },
            Self::Postgres => EngineCapabilities {
                transactions: true,
                ddl_transactions: true,
                savepoints: true,
                cancellation: true,
                schemas: true,
                multiple_databases: false,
                tls: true,
            },
        }
    }
}

impl std::fmt::Display for EngineId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Explicit, serializable description of what an engine supports.
///
/// Capabilities are reported as simple booleans so the UI can disable or explain
/// workflows instead of assuming every engine behaves the same. A `false` value
/// means "not supported (or not confirmed by the driver)".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    /// Supports explicit `BEGIN`/`COMMIT`/`ROLLBACK` transactions.
    pub transactions: bool,
    /// DDL statements participate in transactions. Never assume this across engines.
    pub ddl_transactions: bool,
    /// Supports savepoints within an explicit transaction.
    pub savepoints: bool,
    /// A running operation can be cancelled through the driver.
    pub cancellation: bool,
    /// Exposes named schemas separately from databases/catalogs.
    pub schemas: bool,
    /// A single connection can address more than one database/catalog.
    pub multiple_databases: bool,
    /// TLS/SSL connections are supported by the shipped driver configuration.
    pub tls: bool,
}

#[cfg(test)]
mod tests {
    use super::{EngineCapabilities, EngineId};

    #[test]
    fn engine_ids_use_stable_wire_values() {
        let cases = [
            (EngineId::Sqlite, "sqlite"),
            (EngineId::MySql, "mysql"),
            (EngineId::Postgres, "postgres"),
        ];

        for (engine, expected) in cases {
            assert_eq!(engine.as_str(), expected);
            assert_eq!(engine.to_string(), expected);
            assert_eq!(
                serde_json::to_value(engine).expect("engine id should serialize"),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn engine_ids_round_trip_from_wire_values() {
        for value in ["sqlite", "mysql", "postgres"] {
            let engine: EngineId = serde_json::from_value(serde_json::json!(value))
                .expect("engine id should deserialize");
            assert_eq!(engine.as_str(), value);
        }
    }

    #[test]
    fn capabilities_expose_ddl_transaction_differences() {
        assert!(EngineId::Sqlite.capabilities().ddl_transactions);
        assert!(!EngineId::MySql.capabilities().ddl_transactions);
        assert!(EngineId::Postgres.capabilities().ddl_transactions);
    }

    #[test]
    fn capabilities_serialize_with_camel_case_fields() {
        let value = serde_json::to_value(EngineCapabilities::default())
            .expect("capabilities should serialize");

        assert_eq!(value["transactions"], false);
        assert_eq!(value["ddlTransactions"], false);
        assert_eq!(value["multipleDatabases"], false);
        assert_eq!(value["savepoints"], false);
        assert_eq!(value["cancellation"], false);
        assert_eq!(value["schemas"], false);
        assert_eq!(value["tls"], false);
    }
}
