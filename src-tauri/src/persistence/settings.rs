//! Versioned local-settings format and migrations.
//!
//! The settings file is a single JSON document so profile data can be migrated
//! as a unit. The [`SettingsDocument::version`] field names the format version;
//! [`migrate`] upgrades older documents to [`SETTINGS_FORMAT_VERSION`] and
//! refuses to touch a document written by a newer build.
//!
//! When the format changes, bump [`SETTINGS_FORMAT_VERSION`] and add a
//! migration arm for the previous version. Existing arms must not be edited, so
//! a document written by any released build keeps a working upgrade path.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::errors::{ErrorCategory, QueryError};
use crate::domain::{ConnectionDescriptor, ConnectionProfile, ProfileId};

/// Format version this build writes and understands.
pub const SETTINGS_FORMAT_VERSION: u32 = 1;

/// Complete local settings document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocument {
    /// Format version of this document.
    pub version: u32,
    /// Saved connection profiles, in display order.
    pub profiles: Vec<ConnectionProfile>,
}

impl SettingsDocument {
    /// Wraps profiles in the current format version.
    pub fn new(profiles: Vec<ConnectionProfile>) -> Self {
        Self {
            version: SETTINGS_FORMAT_VERSION,
            profiles,
        }
    }

    /// Creates an empty document in the current format version.
    pub fn empty() -> Self {
        Self::new(Vec::new())
    }

    /// Parses JSON text, applying any required migration.
    pub fn parse(text: &str) -> Result<Self, QueryError> {
        let raw: Value = serde_json::from_str(text)
            .map_err(|error| invalid_settings(format!("settings are not valid JSON: {error}")))?;
        migrate(raw)
    }

    /// Serializes the document as pretty-printed JSON with a trailing newline.
    pub fn to_json(&self) -> Result<String, QueryError> {
        let mut encoded = serde_json::to_string_pretty(self)
            .map_err(|error| invalid_settings(format!("could not encode settings: {error}")))?;
        encoded.push('\n');
        Ok(encoded)
    }
}

/// Upgrades an arbitrary settings value to the current format.
///
/// Version detection:
/// - A `version` number is used as-is.
/// - A missing `version` (or a bare array) is treated as legacy version `0`.
///
/// A value newer than this build is an error: silently downgrading it would
/// destroy settings a newer release wrote.
pub fn migrate(raw: Value) -> Result<SettingsDocument, QueryError> {
    let version = detect_version(&raw)?;

    if version > SETTINGS_FORMAT_VERSION {
        return Err(configuration_error(format!(
            "settings use format version {version}, but this build understands up to version \
             {SETTINGS_FORMAT_VERSION}; refusing to overwrite newer settings"
        )));
    }

    match version {
        0 => migrate_v0(raw),
        _ => serde_json::from_value::<SettingsDocument>(raw)
            .map_err(|error| invalid_settings(format!("settings do not match the current format: {error}"))),
    }
}

/// Reads the declared settings version, defaulting unversioned documents to 0.
fn detect_version(raw: &Value) -> Result<u32, QueryError> {
    match raw {
        Value::Object(map) => match map.get("version") {
            Some(Value::Number(number)) => {
                let value = number.as_u64().ok_or_else(|| {
                    configuration_error("the settings version must be a non-negative integer")
                })?;
                u32::try_from(value).map_err(|_| {
                    configuration_error("the settings version is larger than this build supports")
                })
            }
            Some(_) => Err(configuration_error(
                "the settings version must be a non-negative integer",
            )),
            None => Ok(0),
        },
        Value::Array(_) | Value::Null => Ok(0),
        _ => Err(configuration_error(
            "settings must be a JSON object or an array of profiles",
        )),
    }
}

/// Legacy profile shape that predates the `name` field.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyV0Profile {
    id: ProfileId,
    descriptor: ConnectionDescriptor,
}

/// Migrates an unversioned document (version 0) to version 1.
///
/// Version 0 predates profile display names. It accepted either
/// `{ "profiles": [ ... ] }` or a bare array of profiles. Each legacy profile
/// gains a name derived from its descriptor so nothing is lost.
fn migrate_v0(raw: Value) -> Result<SettingsDocument, QueryError> {
    let profiles_value = match raw {
        Value::Object(mut map) => map
            .remove("profiles")
            .unwrap_or_else(|| Value::Array(Vec::new())),
        Value::Array(items) => Value::Array(items),
        Value::Null => Value::Array(Vec::new()),
        _ => {
            return Err(configuration_error(
                "settings must be a JSON object or an array of profiles",
            ))
        }
    };

    let legacy: Vec<LegacyV0Profile> = serde_json::from_value(profiles_value).map_err(|error| {
        invalid_settings(format!("legacy settings have an unrecognized profile shape: {error}"))
    })?;

    let profiles = legacy
        .into_iter()
        .enumerate()
        .map(|(index, profile)| ConnectionProfile {
            id: profile.id,
            name: migrated_name(&profile.descriptor, index),
            descriptor: profile.descriptor,
        })
        .collect();

    Ok(SettingsDocument::new(profiles))
}

/// Derives a readable name for a profile that never had one.
fn migrated_name(descriptor: &ConnectionDescriptor, index: usize) -> String {
    let derived = match descriptor {
        ConnectionDescriptor::Sqlite(connection) => Path::new(&connection.file_path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_owned)
            .unwrap_or_else(|| "SQLite database".to_string()),
        ConnectionDescriptor::MySql(server) | ConnectionDescriptor::Postgres(server) => {
            match server.database.as_deref() {
                Some(database) if !database.trim().is_empty() => {
                    format!("{database} ({})", server.host)
                }
                _ => server.host.clone(),
            }
        }
    };

    if derived.trim().is_empty() {
        format!("Profile {}", index + 1)
    } else {
        derived
    }
}

/// Builds a validation-category error for malformed settings.
fn invalid_settings(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Validation, message)
}

/// Builds a configuration-category error for incompatible settings.
fn configuration_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Configuration, message)
}

#[cfg(test)]
mod tests {
    use super::{migrate, SettingsDocument, SETTINGS_FORMAT_VERSION};
    use crate::domain::{ConnectionDescriptor, ConnectionProfile, ProfileId};
    use crate::domain::errors::ErrorCategory;
    use serde_json::json;

    fn profile_json(id: &str, engine: &str) -> serde_json::Value {
        match engine {
            "sqlite" => json!({
                "id": id,
                "name": "Local app",
                "descriptor": { "engine": "sqlite", "filePath": "C:/data/app.sqlite" },
            }),
            _ => json!({
                "id": id,
                "name": "Reporting",
                "descriptor": {
                    "engine": engine,
                    "host": "db.example.com",
                    "port": 5432,
                    "database": "app",
                    "username": "app_user",
                    "tls": "preferred",
                },
            }),
        }
    }

    #[test]
    fn current_document_round_trips() {
        let profile = ConnectionProfile {
            id: ProfileId::new("profile-1"),
            name: "Reporting".to_string(),
            descriptor: ConnectionDescriptor::Postgres(crate::domain::ServerConnection {
                host: "db.example.com".to_string(),
                port: 5432,
                database: Some("app".to_string()),
                username: "app_user".to_string(),
                tls: crate::domain::TlsMode::Preferred,
            }),
        };
        let document = SettingsDocument::new(vec![profile.clone()]);

        let encoded = document.to_json().expect("document should encode");
        assert!(encoded.ends_with('\n'));
        let decoded = SettingsDocument::parse(&encoded).expect("document should parse");

        assert_eq!(decoded.version, SETTINGS_FORMAT_VERSION);
        assert_eq!(decoded.profiles, vec![profile]);
    }

    #[test]
    fn unversioned_object_migrates_and_gains_names() {
        let raw = json!({
            "profiles": [
                { "id": "legacy-1", "descriptor": { "engine": "sqlite", "filePath": "/tmp/reporting.sqlite" } },
                { "id": "legacy-2", "descriptor": { "engine": "mysql", "host": "db.example.com", "port": 3306, "database": "sales", "username": "app_user", "tls": "disabled" } },
            ],
        });

        let document = migrate(raw).expect("legacy settings should migrate");

        assert_eq!(document.version, SETTINGS_FORMAT_VERSION);
        assert_eq!(document.profiles.len(), 2);
        assert_eq!(document.profiles[0].name, "reporting");
        assert_eq!(document.profiles[1].name, "sales (db.example.com)");
        assert_eq!(document.profiles[0].id, ProfileId::new("legacy-1"));
    }

    #[test]
    fn bare_legacy_array_migrates() {
        let raw = json!([profile_json("legacy-1", "postgres")]);

        let document = migrate(raw).expect("bare array should migrate");

        assert_eq!(document.version, SETTINGS_FORMAT_VERSION);
        // Version-0 profiles did not carry `name`; the extra field is ignored.
        assert_eq!(document.profiles.len(), 1);
        assert_eq!(document.profiles[0].id, ProfileId::new("legacy-1"));
        assert_eq!(document.profiles[0].name, "app (db.example.com)");
    }

    #[test]
    fn newer_format_versions_are_rejected_without_being_read() {
        let raw = json!({ "version": SETTINGS_FORMAT_VERSION + 1, "profiles": [] });

        let error = migrate(raw).expect_err("a newer format must be refused");
        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn unrecognized_shapes_and_versions_are_rejected() {
        assert_eq!(
            migrate(json!("not settings"))
                .expect_err("a scalar is not settings")
                .category,
            ErrorCategory::Configuration
        );
        assert_eq!(
            migrate(json!({ "version": "one", "profiles": [] }))
                .expect_err("a string version is invalid")
                .category,
            ErrorCategory::Configuration
        );
        assert_eq!(
            migrate(json!({ "version": 1, "profiles": [{ "id": "x" }] }))
                .expect_err("a profile without a descriptor is invalid")
                .category,
            ErrorCategory::Validation
        );
    }

    #[test]
    fn settings_encoding_contains_no_secret_fields() {
        let document = SettingsDocument::new(vec![ConnectionProfile {
            id: ProfileId::new("profile-1"),
            name: "Reporting".to_string(),
            descriptor: ConnectionDescriptor::Postgres(crate::domain::ServerConnection {
                host: "db.example.com".to_string(),
                port: 5432,
                database: Some("app".to_string()),
                username: "app_user".to_string(),
                tls: crate::domain::TlsMode::Preferred,
            }),
        }]);

        let encoded = document.to_json().expect("document should encode");
        for forbidden in ["password", "passwd", "secret", "token", "credential"] {
            assert!(
                !encoded.to_lowercase().contains(forbidden),
                "settings encoding leaked `{forbidden}`",
            );
        }
    }
}
