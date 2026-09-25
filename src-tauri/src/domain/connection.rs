use serde::{Deserialize, Serialize};

use super::capabilities::EngineId;

/// Secret-free description of how to reach a database.
///
/// Descriptors carry only non-secret routing information (paths, host/port,
/// database/user names, TLS mode). Passwords and other secrets are resolved
/// from protected storage by the application and supplied to the adapter at
/// connect time; they must never be added to this type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "engine")]
pub enum ConnectionDescriptor {
    #[serde(rename = "sqlite")]
    Sqlite(SqliteConnection),
    #[serde(rename = "mysql")]
    MySql(ServerConnection),
    #[serde(rename = "postgres")]
    Postgres(ServerConnection),
}

impl ConnectionDescriptor {
    /// Engine this descriptor targets.
    pub const fn engine(&self) -> EngineId {
        match self {
            Self::Sqlite(_) => EngineId::Sqlite,
            Self::MySql(_) => EngineId::MySql,
            Self::Postgres(_) => EngineId::Postgres,
        }
    }

    /// Local file path when this is a SQLite descriptor.
    pub fn sqlite_file_path(&self) -> Option<&str> {
        match self {
            Self::Sqlite(connection) => Some(connection.file_path.as_str()),
            _ => None,
        }
    }

    /// Secret-free server connection settings for network engines.
    pub fn server(&self) -> Option<&ServerConnection> {
        match self {
            Self::MySql(connection) | Self::Postgres(connection) => Some(connection),
            Self::Sqlite(_) => None,
        }
    }
}

/// Connection settings for a local SQLite database file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteConnection {
    /// Path to the SQLite database file on the local machine.
    pub file_path: String,
}

/// Non-secret connection settings for MySQL/PostgreSQL servers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConnection {
    /// Server host name or IP address.
    pub host: String,
    /// Server port.
    pub port: u16,
    /// Optional default database to select after connecting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// Login role/user name. The password is never stored here.
    pub username: String,
    /// Requested TLS behavior for the connection.
    #[serde(default)]
    pub tls: TlsMode,
}

/// Requested TLS/SSL behavior. Values mirror common driver terminology.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TlsMode {
    /// Do not use TLS.
    #[default]
    Disabled,
    /// Use TLS when the server offers it.
    Preferred,
    /// Require TLS but do not verify the server certificate.
    Required,
    /// Require TLS and verify the certificate authority chain.
    VerifyCa,
    /// Require TLS and verify both the certificate chain and server identity.
    VerifyFull,
}

#[cfg(test)]
mod tests {
    use super::{ConnectionDescriptor, ServerConnection, SqliteConnection, TlsMode};
    use crate::domain::capabilities::EngineId;

    fn sample_server() -> ServerConnection {
        ServerConnection {
            host: "localhost".to_string(),
            port: 5432,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
        }
    }

    #[test]
    fn sqlite_descriptor_serializes_with_engine_tag() {
        let descriptor = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "C:/data/app.sqlite".to_string(),
        });

        let value = serde_json::to_value(&descriptor).expect("descriptor should serialize");

        assert_eq!(value["engine"], "sqlite");
        assert_eq!(value["filePath"], "C:/data/app.sqlite");
        assert_eq!(descriptor.engine(), EngineId::Sqlite);
        assert_eq!(descriptor.sqlite_file_path(), Some("C:/data/app.sqlite"));
        assert!(descriptor.server().is_none());
    }

    #[test]
    fn server_descriptors_serialize_without_secret_values() {
        let descriptor = ConnectionDescriptor::Postgres(sample_server());

        let value = serde_json::to_value(&descriptor).expect("descriptor should serialize");
        let serialized = value.to_string();

        assert_eq!(value["engine"], "postgres");
        assert_eq!(value["host"], "localhost");
        assert_eq!(value["port"], 5432);
        assert_eq!(value["database"], "app");
        assert_eq!(value["username"], "app_user");
        assert_eq!(value["tls"], "preferred");

        for forbidden in ["password", "passwd", "secret", "token", "credential"] {
            assert!(
                !serialized.to_lowercase().contains(forbidden),
                "descriptor serialization leaked `{forbidden}`",
            );
        }
    }

    #[test]
    fn descriptors_round_trip_through_serde() {
        let descriptors = [
            ConnectionDescriptor::Sqlite(SqliteConnection {
                file_path: "/tmp/app.sqlite".to_string(),
            }),
            ConnectionDescriptor::MySql(sample_server()),
            ConnectionDescriptor::Postgres(sample_server()),
        ];

        for descriptor in descriptors {
            let encoded = serde_json::to_string(&descriptor).expect("descriptor should serialize");
            let decoded: ConnectionDescriptor =
                serde_json::from_str(&encoded).expect("descriptor should deserialize");
            assert_eq!(decoded, descriptor);
        }
    }

    #[test]
    fn tls_modes_use_snake_case_wire_values() {
        let cases = [
            (TlsMode::Disabled, "disabled"),
            (TlsMode::Preferred, "preferred"),
            (TlsMode::Required, "required"),
            (TlsMode::VerifyCa, "verify_ca"),
            (TlsMode::VerifyFull, "verify_full"),
        ];

        for (mode, expected) in cases {
            assert_eq!(
                serde_json::to_value(mode).expect("tls mode should serialize"),
                serde_json::json!(expected)
            );
        }
    }
}
