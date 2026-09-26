use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::capabilities::EngineId;
use super::errors::{ErrorCategory, QueryError};

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

    /// Returns a copy of this descriptor targeting `database`.
    ///
    /// Used to reconnect a server profile to a chosen database (PostgreSQL binds
    /// one connection to a single database). SQLite has a single fixed file, so
    /// a SQLite descriptor is returned unchanged.
    pub fn with_database(&self, database: impl Into<String>) -> Self {
        match self {
            Self::MySql(connection) => Self::MySql(ServerConnection {
                database: Some(database.into()),
                ..connection.clone()
            }),
            Self::Postgres(connection) => Self::Postgres(ServerConnection {
                database: Some(database.into()),
                ..connection.clone()
            }),
            Self::Sqlite(_) => self.clone(),
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

/// Maximum length of a profile display name, counted in Unicode scalar values.
pub const MAX_PROFILE_NAME_LENGTH: usize = 120;

/// Opaque, serializable identifier for a saved connection profile.
///
/// The identifier is also the reference under which the profile's password is
/// stored in protected storage; profile data carries the identifier only and
/// never the secret itself. Serialized as a plain string, matching the
/// connection and transaction identifier tokens.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(String);

impl ProfileId {
    /// Wraps an existing profile identifier.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Generates a new identifier that is unique within this process.
    ///
    /// Combines a monotonic counter with the current wall clock so profiles
    /// created within the same nanosecond still receive distinct identifiers.
    /// Identifiers only need to be unique within one user's local settings.
    pub fn generate() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        Self(format!("profile-{nanos}-{sequence}"))
    }

    /// Borrows the identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Validated, secret-free description of a saved connection profile.
///
/// A profile pairs a user-facing `name` with the non-secret
/// [`ConnectionDescriptor`] needed to reach a database. It never carries a
/// password: the profile's [`ProfileId`] is the reference used to resolve the
/// secret from protected storage at connect time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    /// Stable identifier, also the protected-storage secret reference.
    pub id: ProfileId,
    /// User-facing display name.
    pub name: String,
    /// Secret-free routing settings for the target database.
    pub descriptor: ConnectionDescriptor,
}

impl ConnectionProfile {
    /// Creates a profile with a freshly generated identifier.
    pub fn new(name: impl Into<String>, descriptor: ConnectionDescriptor) -> Self {
        Self {
            id: ProfileId::generate(),
            name: name.into(),
            descriptor,
        }
    }

    /// Validates the non-secret profile fields before a save.
    ///
    /// Returns [`ErrorCategory::Validation`] with a safe, actionable message.
    /// The message never contains a secret because a profile never holds one.
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.id.as_str().trim().is_empty() {
            return Err(validation_error("a profile must have a non-empty identifier"));
        }

        let name = self.name.trim();
        if name.is_empty() {
            return Err(validation_error("a profile name must not be empty"));
        }
        if name.chars().count() > MAX_PROFILE_NAME_LENGTH {
            return Err(validation_error(format!(
                "a profile name must be at most {MAX_PROFILE_NAME_LENGTH} characters"
            )));
        }

        match &self.descriptor {
            ConnectionDescriptor::Sqlite(connection) => {
                if connection.file_path.trim().is_empty() {
                    return Err(validation_error(
                        "a SQLite profile must reference a database file",
                    ));
                }
            }
            ConnectionDescriptor::MySql(server) | ConnectionDescriptor::Postgres(server) => {
                if server.host.trim().is_empty() {
                    return Err(validation_error("a server profile must have a host"));
                }
                if server.port == 0 {
                    return Err(validation_error(
                        "a server profile must have a port between 1 and 65535",
                    ));
                }
                if server.username.trim().is_empty() {
                    return Err(validation_error("a server profile must have a username"));
                }
                if let Some(database) = &server.database {
                    if database.trim().is_empty() {
                        return Err(validation_error(
                            "a server profile's database name must not be empty when present",
                        ));
                    }
                }
            }
        }

        Ok(())
    }
}

/// Builds a validation-category [`QueryError`] with a safe message.
fn validation_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Validation, message)
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectionDescriptor, ConnectionProfile, ProfileId, ServerConnection, SqliteConnection,
        TlsMode, MAX_PROFILE_NAME_LENGTH,
    };
    use crate::domain::capabilities::EngineId;
    use crate::domain::errors::ErrorCategory;

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

    #[test]
    fn with_database_overrides_server_descriptors_and_leaves_sqlite_unchanged() {
        let postgres = ConnectionDescriptor::Postgres(sample_server());
        let overridden = postgres.with_database("analytics");
        assert_eq!(
            overridden.server().and_then(|server| server.database.as_deref()),
            Some("analytics")
        );
        // Other fields are preserved.
        assert_eq!(overridden.server().map(|server| server.port), Some(5432));

        let mysql = ConnectionDescriptor::MySql(sample_server());
        assert_eq!(
            mysql
                .with_database("reporting")
                .server()
                .and_then(|server| server.database.as_deref()),
            Some("reporting")
        );

        let sqlite = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "C:/data/app.sqlite".to_string(),
        });
        assert_eq!(sqlite.with_database("ignored"), sqlite);
    }

    fn sqlite_profile(name: &str) -> ConnectionProfile {
        ConnectionProfile::new(
            name,
            ConnectionDescriptor::Sqlite(SqliteConnection {
                file_path: "C:/data/app.sqlite".to_string(),
            }),
        )
    }

    fn postgres_profile(name: &str) -> ConnectionProfile {
        ConnectionProfile::new(name, ConnectionDescriptor::Postgres(sample_server()))
    }

    #[test]
    fn profile_ids_are_unique_non_empty_strings() {
        let first = ProfileId::generate();
        let second = ProfileId::generate();

        assert!(!first.as_str().trim().is_empty());
        assert_ne!(first, second);
        assert_eq!(
            serde_json::to_value(&first).expect("profile id should serialize"),
            serde_json::json!(first.as_str())
        );
    }

    #[test]
    fn validate_accepts_sqlite_and_server_profiles() {
        sqlite_profile("Local app").validate().expect("SQLite profile");
        postgres_profile("Reporting").validate().expect("server profile");
    }

    #[test]
    fn validate_rejects_an_empty_profile_identifier() {
        let mut profile = sqlite_profile("Local app");
        profile.id = ProfileId::new("  ");

        let error = profile.validate().expect_err("empty id must fail");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn validate_rejects_an_empty_or_overlong_name() {
        let empty = sqlite_profile("   ");
        assert_eq!(
            empty.validate().expect_err("empty name must fail").category,
            ErrorCategory::Validation
        );

        let overlong = sqlite_profile(&"n".repeat(MAX_PROFILE_NAME_LENGTH + 1));
        assert_eq!(
            overlong
                .validate()
                .expect_err("overlong name must fail")
                .category,
            ErrorCategory::Validation
        );
    }

    #[test]
    fn validate_rejects_missing_sqlite_path() {
        let mut profile = sqlite_profile("Local app");
        profile.descriptor = ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "  ".to_string(),
        });

        assert_eq!(
            profile
                .validate()
                .expect_err("blank path must fail")
                .category,
            ErrorCategory::Validation
        );
    }

    #[test]
    fn validate_rejects_invalid_server_fields() {
        for (host, port, username, database) in [
            ("", 5432, "app_user", Some("app".to_string())),
            ("localhost", 0, "app_user", Some("app".to_string())),
            ("localhost", 5432, "  ", Some("app".to_string())),
            ("localhost", 5432, "app_user", Some("  ".to_string())),
        ] {
            let profile = ConnectionProfile::new(
                "Reporting",
                ConnectionDescriptor::Postgres(ServerConnection {
                    host: host.to_string(),
                    port,
                    database,
                    username: username.to_string(),
                    tls: TlsMode::Preferred,
                }),
            );

            assert_eq!(
                profile
                    .validate()
                    .expect_err("invalid server settings must fail")
                    .category,
                ErrorCategory::Validation
            );
        }
    }

    #[test]
    fn profile_round_trips_through_serde_without_secrets() {
        let profile = postgres_profile("Reporting");

        let encoded = serde_json::to_string(&profile).expect("profile should serialize");
        let decoded: ConnectionProfile =
            serde_json::from_str(&encoded).expect("profile should deserialize");

        assert_eq!(decoded, profile);
        assert_eq!(
            serde_json::to_value(&profile).expect("profile should serialize")["descriptor"]["engine"],
            "postgres"
        );
        for forbidden in ["password", "passwd", "secret", "token", "credential"] {
            assert!(
                !encoded.to_lowercase().contains(forbidden),
                "profile serialization leaked `{forbidden}`",
            );
        }
    }
}
