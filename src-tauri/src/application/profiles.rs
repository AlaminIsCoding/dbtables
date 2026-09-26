//! Connection-profile use cases.
//!
//! Profile descriptors are persisted without credentials. Passwords are
//! resolved from the protected secret store only when testing or opening a
//! connection, and profile operations never return a stored password.

use std::sync::Arc;

use serde::Deserialize;

use crate::application::connections;
use crate::database::{ConnectionId, ConnectionSecret, ConnectionTest, DatabaseAdapter};
use crate::domain::{ConnectionDescriptor, ConnectionProfile, ProfileId, QueryError};
use crate::persistence::{
    apply_secret_edit, remove_profile, ProfileRepository, SecretRef, SecretStore,
};

/// Fields submitted by the frontend to create/edit/test a profile.
///
/// Password is intentionally not serializable or printable. It is write-only
/// IPC input and is immediately converted to `ConnectionSecret` at this
/// boundary.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileInput {
    /// Existing profile id for edits; omitted for a new profile.
    #[serde(default)]
    pub id: Option<ProfileId>,
    /// User-visible profile name.
    pub name: String,
    /// Secret-free database settings.
    pub descriptor: ConnectionDescriptor,
    /// Write-only password. Blank or omitted means preserve any saved secret.
    #[serde(default)]
    pub password: Option<String>,
}

/// Runtime dependencies for profile CRUD and secret resolution.
pub struct ProfileService {
    repository: Arc<dyn ProfileRepository>,
    secrets: Arc<dyn SecretStore>,
}

impl ProfileService {
    /// Creates a service backed by the supplied profile repository and secret
    /// store.
    pub fn new(
        repository: Arc<dyn ProfileRepository>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            repository,
            secrets,
        }
    }

    /// Lists secret-free saved profiles.
    pub fn list(&self) -> Result<Vec<ConnectionProfile>, QueryError> {
        self.repository.list()
    }

    /// Creates or updates a profile and, when supplied, stores its password in
    /// the protected credential store.
    pub fn save(
        &self,
        input: ConnectionProfileInput,
    ) -> Result<ConnectionProfile, QueryError> {
        let existing = match &input.id {
            Some(id) => Some(self.repository.get(id)?.ok_or_else(|| {
                crate::domain::QueryError::new(
                    crate::domain::ErrorCategory::Validation,
                    format!("profile `{id}` does not exist"),
                )
            })?),
            None => None,
        };
        let id = input
            .id
            .clone()
            .unwrap_or_else(ProfileId::generate);
        let profile = ConnectionProfile {
            id: id.clone(),
            name: input.name,
            descriptor: input.descriptor,
        };
        profile.validate()?;

        let reference = SecretRef::for_profile(&id);
        let new_profile_uses_secret =
            !matches!(&profile.descriptor, ConnectionDescriptor::Sqlite(_));
        let replacing_server_profile_with_sqlite = existing.as_ref().is_some_and(|previous| {
            !matches!(
                &previous.descriptor,
                ConnectionDescriptor::Sqlite(_)
            ) && !new_profile_uses_secret
        });
        let submitted_secret = if new_profile_uses_secret {
            input
                .password
                .filter(|value| !value.is_empty())
                .map(ConnectionSecret::new)
        } else {
            None
        };
        let update_secret = submitted_secret.is_some() || replacing_server_profile_with_sqlite;
        let previous_secret = if update_secret {
            self.secrets.get(&reference)?
        } else {
            None
        };

        let saved = match existing.as_ref() {
            Some(_) => self.repository.update(profile)?,
            None => self.repository.create(profile)?,
        };

        let secret_result = match submitted_secret.as_ref() {
            Some(submitted) => {
                apply_secret_edit(self.secrets.as_ref(), &reference, Some(submitted))
            }
            None if replacing_server_profile_with_sqlite => {
                self.secrets.delete(&reference).map(|_| ())
            }
            None => Ok(()),
        };
        if let Err(error) = secret_result {
            if update_secret {
                self.restore_profile(existing.clone(), &saved);
                if let Some(previous) = previous_secret.as_ref() {
                    let _ = self.secrets.set(&reference, previous);
                } else {
                    let _ = self.secrets.delete(&reference);
                }
            }
            return Err(error);
        }

        Ok(saved)
    }

    /// Deletes a profile and its stored credential, if present.
    pub fn delete(&self, id: &ProfileId) -> Result<bool, QueryError> {
        remove_profile(self.repository.as_ref(), self.secrets.as_ref(), id)
    }

    /// Tests submitted settings without retaining a connection.
    pub async fn test_connection(
        &self,
        adapter: &dyn DatabaseAdapter,
        input: &ConnectionProfileInput,
    ) -> Result<ConnectionTest, QueryError> {
        let secret = self.resolve_input_secret(input)?;
        connections::test_connection(adapter, &input.descriptor, secret.as_ref()).await
    }

    /// Opens a saved profile and returns its opaque connection token.
    pub async fn connect(
        &self,
        adapter: &dyn DatabaseAdapter,
        id: &ProfileId,
    ) -> Result<ConnectionId, QueryError> {
        let profile = self.repository.get(id)?.ok_or_else(|| {
            crate::domain::QueryError::new(
                crate::domain::ErrorCategory::Validation,
                format!("profile `{id}` does not exist"),
            )
        })?;
        let secret = if matches!(&profile.descriptor, ConnectionDescriptor::Sqlite(_)) {
            None
        } else {
            self.secrets.get(&SecretRef::for_profile(id))?
        };
        connections::connect(adapter, &profile.descriptor, secret.as_ref()).await
    }

    fn resolve_input_secret(
        &self,
        input: &ConnectionProfileInput,
    ) -> Result<Option<ConnectionSecret>, QueryError> {
        if matches!(&input.descriptor, ConnectionDescriptor::Sqlite(_)) {
            return Ok(None);
        }

        if let Some(password) = input.password.as_ref().filter(|value| !value.is_empty()) {
            return Ok(Some(ConnectionSecret::new(password.clone())));
        }

        match &input.id {
            Some(id) => self.secrets.get(&SecretRef::for_profile(id)),
            None => Ok(None),
        }
    }

    fn restore_profile(&self, previous: Option<ConnectionProfile>, saved: &ConnectionProfile) {
        if let Some(previous) = previous {
            let _ = self.repository.update(previous);
        } else {
            let _ = self.repository.delete(&saved.id);
        }
    }
}

/// Builds a profile input for tests and callers that already hold a descriptor.
pub fn profile_input(
    id: Option<ProfileId>,
    name: impl Into<String>,
    descriptor: ConnectionDescriptor,
    password: Option<String>,
) -> ConnectionProfileInput {
    ConnectionProfileInput {
        id,
        name: name.into(),
        descriptor,
        password,
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll, Waker};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{profile_input, ConnectionProfileInput, ProfileService};
    use crate::database::{DatabaseAdapter, SqliteAdapter};
    use crate::domain::{
        ConnectionDescriptor, ServerConnection, SqliteConnection, TlsMode,
    };
    use crate::persistence::{
        FileProfileRepository, InMemorySecretStore, ProfileRepository, SecretRef, SecretStore,
    };

    struct TestProfileService {
        service: ProfileService,
        repository: Arc<FileProfileRepository>,
        secrets: Arc<InMemorySecretStore>,
        settings_path: PathBuf,
    }

    impl TestProfileService {
        fn new() -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let directory = std::env::temp_dir().join(format!(
                "dbtables-profile-service-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir_all(&directory).expect("test directory should be created");
            let settings_path = directory.join("settings.json");
            let repository = Arc::new(FileProfileRepository::new(&settings_path));
            let secrets = Arc::new(InMemorySecretStore::new());
            let service = ProfileService::new(repository.clone(), secrets.clone());
            Self {
                service,
                repository,
                secrets,
                settings_path,
            }
        }

        fn sqlite_profile(name: &str, file_path: &str) -> ConnectionProfileInput {
            profile_input(
                None,
                name,
                ConnectionDescriptor::Sqlite(SqliteConnection {
                    file_path: file_path.to_string(),
                }),
                None,
            )
        }

        fn server_profile(name: &str, password: Option<&str>) -> ConnectionProfileInput {
            profile_input(
                None,
                name,
                ConnectionDescriptor::MySql(ServerConnection {
                    host: "localhost".to_string(),
                    port: 3306,
                    database: Some("app".to_string()),
                    username: "app_user".to_string(),
                    tls: TlsMode::Disabled,
                }),
                password.map(str::to_string),
            )
        }
    }

    impl Drop for TestProfileService {
        fn drop(&mut self) {
            if let Some(directory) = self.settings_path.parent() {
                let _ = std::fs::remove_dir_all(directory);
            }
        }
    }

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

    #[test]
    fn saving_a_sqlite_profile_lists_it_without_storing_a_secret_in_settings() {
        let harness = TestProfileService::new();
        let mut input = TestProfileService::sqlite_profile("Local DB", "C:/db/app.sqlite");
        input.password = Some("not-used-for-sqlite".to_string());
        let saved = harness
            .service
            .save(input)
            .expect("save should succeed");

        assert_eq!(
            harness.service.list().expect("list should work"),
            vec![saved.clone()]
        );
        let settings = std::fs::read_to_string(&harness.settings_path)
            .expect("settings file should be present");
        assert!(!settings.to_lowercase().contains("password"));
        assert!(!harness
            .secrets
            .contains(&SecretRef::for_profile(&saved.id))
            .expect("secret lookup should work"));
    }

    #[test]
    fn blank_password_edits_preserve_the_saved_secret_and_nonempty_edits_replace_it() {
        let harness = TestProfileService::new();
        let saved = harness
            .service
            .save(TestProfileService::server_profile(
                "Server DB",
                Some("first-secret"),
            ))
            .expect("initial save should work");
        let reference = SecretRef::for_profile(&saved.id);

        let blank_update = profile_input(
            Some(saved.id.clone()),
            "Renamed DB",
            saved.descriptor.clone(),
            Some(String::new()),
        );
        harness
            .service
            .save(blank_update)
            .expect("blank edit should save without clearing the secret");
        assert_eq!(
            harness
                .secrets
                .get(&reference)
                .expect("secret lookup should work")
                .expect("secret should remain")
                .expose(),
            "first-secret"
        );

        let replacement = profile_input(
            Some(saved.id.clone()),
            "Renamed DB",
            saved.descriptor,
            Some("second-secret".to_string()),
        );
        harness
            .service
            .save(replacement)
            .expect("replacement secret should save");
        assert_eq!(
            harness
                .secrets
                .get(&reference)
                .expect("secret lookup should work")
                .expect("secret should remain")
                .expose(),
            "second-secret"
        );
    }

    #[test]
    fn delete_profile_removes_its_secret() {
        let harness = TestProfileService::new();
        let saved = harness
            .service
            .save(TestProfileService::server_profile(
                "Server DB",
                Some("secret"),
            ))
            .expect("save should work");
        let reference = SecretRef::for_profile(&saved.id);

        assert!(harness.service.delete(&saved.id).expect("delete should work"));
        assert!(!harness.secrets.contains(&reference).expect("contains works"));
        assert!(harness.repository.list().expect("list should work").is_empty());
    }

    #[test]
    fn sqlite_profile_can_be_tested_and_connected_through_the_profile_service() {
        let harness = TestProfileService::new();
        let database_path = harness
            .settings_path
            .parent()
            .expect("test directory")
            .join("fixture.sqlite");
        let database = Connection::open(&database_path).expect("fixture database should open");
        database
            .execute_batch("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);")
            .expect("fixture table should be created");
        drop(database);

        let profile = harness
            .service
            .save(TestProfileService::sqlite_profile(
                "Fixture",
                database_path.to_str().expect("path should be UTF-8"),
            ))
            .expect("profile save should work");
        let adapter = SqliteAdapter::new();
        let test_input = profile_input(
            Some(profile.id.clone()),
            profile.name.clone(),
            profile.descriptor.clone(),
            None,
        );
        let tested = block_on(harness.service.test_connection(&adapter, &test_input))
            .expect("SQLite profile test should succeed");
        assert_eq!(tested.engine, crate::domain::EngineId::Sqlite);

        let connection = block_on(harness.service.connect(&adapter, &profile.id))
            .expect("saved SQLite profile should connect");
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("connection state"),
            crate::database::ConnectionState::Connected
        );
        block_on(adapter.disconnect(&connection)).expect("connection should disconnect");
    }

    #[test]
    fn unsaved_input_password_is_used_for_testing_but_never_saved() {
        let harness = TestProfileService::new();
        let input = profile_input(
            None,
            "Local DB",
            ConnectionDescriptor::Sqlite(SqliteConnection {
                file_path: "C:/db/app.sqlite".to_string(),
            }),
            Some("write-only".to_string()),
        );
        let serialized_descriptor = serde_json::to_string(&input.descriptor)
            .expect("secret-free descriptor should serialize");
        assert!(!serialized_descriptor.contains("write-only"));

        let result = block_on(harness.service.test_connection(&SqliteAdapter::new(), &input));
        assert!(result.is_err(), "a missing SQLite file should fail to test");
        assert!(harness.service.list().expect("list should work").is_empty());
    }
}
