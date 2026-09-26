//! Local persistence for non-secret connection profiles.
//!
//! [`FileProfileRepository`] stores validated profiles as a versioned JSON
//! settings file. It writes atomically (write a sibling temp file, then replace)
//! so an interrupted save cannot truncate the existing profiles.
//!
//! Profiles never contain passwords. The secret for a profile is stored
//! separately through [`crate::persistence::secrets`] and is keyed by the
//! profile identifier, so a profile edit can never overwrite or expose it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::errors::{ErrorCategory, QueryError};
use crate::domain::{ConnectionProfile, ProfileId};

use super::secrets::{SecretRef, SecretStore};
use super::settings::SettingsDocument;

/// CRUD boundary for saved, non-secret connection profiles.
///
/// Implementations must validate a profile before persisting it and must keep
/// writes atomic with respect to other operations on the same store.
pub trait ProfileRepository: Send + Sync {
    /// Returns every saved profile in display order.
    fn list(&self) -> Result<Vec<ConnectionProfile>, QueryError>;

    /// Returns the profile with `id`, or `None` when it does not exist.
    fn get(&self, id: &ProfileId) -> Result<Option<ConnectionProfile>, QueryError>;

    /// Validates and saves a new profile.
    ///
    /// Fails when the identifier already exists so a create can never silently
    /// overwrite an unrelated profile.
    fn create(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, QueryError>;

    /// Validates and replaces the profile sharing `profile`'s identifier.
    fn update(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, QueryError>;

    /// Removes the profile with `id`.
    ///
    /// Returns `Ok(true)` when a profile was removed and `Ok(false)` when none
    /// matched.
    fn delete(&self, id: &ProfileId) -> Result<bool, QueryError>;
}

/// Removes a profile together with its stored secret.
///
/// The profile is deleted first; if it existed, its secret is then removed so a
/// later profile cannot inherit a stale credential. A missing secret is not an
/// error.
pub fn remove_profile(
    repository: &dyn ProfileRepository,
    secrets: &dyn SecretStore,
    id: &ProfileId,
) -> Result<bool, QueryError> {
    let removed = repository.delete(id)?;
    if removed {
        secrets.delete(&SecretRef::for_profile(id))?;
    }
    Ok(removed)
}

/// File-backed [`ProfileRepository`] storing a versioned JSON settings document.
pub struct FileProfileRepository {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileProfileRepository {
    /// Creates a repository that reads and writes `path`.
    ///
    /// The file is created on first save; its parent directory is created when
    /// needed.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    /// Path of the settings file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn load(&self) -> Result<SettingsDocument, QueryError> {
        match fs::read_to_string(&self.path) {
            Ok(text) => SettingsDocument::parse(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SettingsDocument::empty())
            }
            Err(error) => Err(io_error("read", &self.path, &error)),
        }
    }

    fn save(&self, document: &SettingsDocument) -> Result<(), QueryError> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|error| io_error("create the settings directory", parent, &error))?;
            }
        }

        let encoded = document.to_json()?;
        let temporary = temporary_path(&self.path);
        fs::write(&temporary, encoded)
            .map_err(|error| io_error("write the settings file", &temporary, &error))?;
        fs::rename(&temporary, &self.path)
            .map_err(|error| io_error("replace the settings file", &self.path, &error))?;
        Ok(())
    }
}

impl ProfileRepository for FileProfileRepository {
    fn list(&self) -> Result<Vec<ConnectionProfile>, QueryError> {
        let _guard = self.lock();
        Ok(self.load()?.profiles)
    }

    fn get(&self, id: &ProfileId) -> Result<Option<ConnectionProfile>, QueryError> {
        let _guard = self.lock();
        Ok(self
            .load()?
            .profiles
            .into_iter()
            .find(|profile| &profile.id == id))
    }

    fn create(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, QueryError> {
        profile.validate()?;
        let _guard = self.lock();
        let mut document = self.load()?;
        if document
            .profiles
            .iter()
            .any(|existing| existing.id == profile.id)
        {
            return Err(validation_error(format!(
                "a profile with identifier `{}` already exists",
                profile.id
            )));
        }
        document.profiles.push(profile.clone());
        self.save(&document)?;
        Ok(profile)
    }

    fn update(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, QueryError> {
        profile.validate()?;
        let _guard = self.lock();
        let mut document = self.load()?;
        let slot = document
            .profiles
            .iter_mut()
            .find(|existing| existing.id == profile.id)
            .ok_or_else(|| {
                validation_error(format!("profile `{}` does not exist", profile.id))
            })?;
        *slot = profile.clone();
        self.save(&document)?;
        Ok(profile)
    }

    fn delete(&self, id: &ProfileId) -> Result<bool, QueryError> {
        let _guard = self.lock();
        let mut document = self.load()?;
        let before = document.profiles.len();
        document.profiles.retain(|profile| &profile.id != id);
        let removed = document.profiles.len() != before;
        if removed {
            self.save(&document)?;
        }
        Ok(removed)
    }
}

/// Sibling temp path used for atomic replacement.
fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("settings.json"));
    name.push(".tmp");
    path.with_file_name(name)
}

fn io_error(action: &str, path: &Path, error: &std::io::Error) -> QueryError {
    QueryError::new(
        ErrorCategory::Internal,
        format!("could not {action} at `{}`", path.display()),
    )
    .with_engine_detail(error.to_string())
}

fn validation_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Validation, message)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{remove_profile, FileProfileRepository, ProfileRepository};
    use crate::domain::errors::ErrorCategory;
    use crate::domain::{
        ConnectionDescriptor, ConnectionProfile, ProfileId, ServerConnection, SqliteConnection,
        TlsMode, MAX_PROFILE_NAME_LENGTH,
    };
    use crate::persistence::secrets::{InMemorySecretStore, SecretRef, SecretStore};

    /// Self-cleaning temporary directory for one test.
    struct TempSettings {
        directory: PathBuf,
        path: PathBuf,
    }

    impl TempSettings {
        fn new() -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let directory = std::env::temp_dir().join(format!(
                "dbtables-settings-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&directory).expect("temp directory should be created");
            let path = directory.join("settings.json");
            Self { directory, path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempSettings {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
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
        ConnectionProfile::new(
            name,
            ConnectionDescriptor::Postgres(ServerConnection {
                host: "db.example.com".to_string(),
                port: 5432,
                database: Some("app".to_string()),
                username: "app_user".to_string(),
                tls: TlsMode::Preferred,
            }),
        )
    }

    #[test]
    fn create_list_get_update_delete_round_trip() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());

        let first = repository
            .create(sqlite_profile("Local app"))
            .expect("create should succeed");
        let second = repository
            .create(postgres_profile("Reporting"))
            .expect("create should succeed");

        assert_eq!(repository.list().expect("list should succeed").len(), 2);
        assert_eq!(
            repository.get(&first.id).expect("get should succeed"),
            Some(first.clone())
        );

        let mut renamed = first.clone();
        renamed.name = "Renamed".to_string();
        repository
            .update(renamed.clone())
            .expect("update should succeed");
        assert_eq!(
            repository
                .get(&first.id)
                .expect("get should succeed")
                .expect("profile should exist")
                .name,
            "Renamed"
        );

        assert!(repository.delete(&second.id).expect("delete should succeed"));
        assert!(!repository.delete(&second.id).expect("second delete is false"));
        assert_eq!(repository.list().expect("list should succeed"), vec![renamed]);
    }

    #[test]
    fn saved_profiles_survive_a_new_repository_instance() {
        let settings = TempSettings::new();
        let created = {
            let repository = FileProfileRepository::new(settings.path());
            repository
                .create(sqlite_profile("Local app"))
                .expect("create should succeed")
        };

        let reopened = FileProfileRepository::new(settings.path());
        assert_eq!(
            reopened.get(&created.id).expect("get should succeed"),
            Some(created)
        );
    }

    #[test]
    fn create_rejects_a_duplicate_identifier() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());
        let profile = sqlite_profile("Local app");
        repository
            .create(profile.clone())
            .expect("first create should succeed");

        let error = repository
            .create(profile)
            .expect_err("duplicate id must fail");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn create_rejects_invalid_profiles_without_writing() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());

        let invalid = sqlite_profile("");
        let error = repository
            .create(invalid)
            .expect_err("invalid profile must fail");
        assert_eq!(error.category, ErrorCategory::Validation);
        assert!(repository.list().expect("list should succeed").is_empty());
        assert!(!settings.path().exists(), "no file should be written");

        let overlong = sqlite_profile(&"n".repeat(MAX_PROFILE_NAME_LENGTH + 1));
        assert_eq!(
            repository
                .create(overlong)
                .expect_err("overlong name must fail")
                .category,
            ErrorCategory::Validation
        );
    }

    #[test]
    fn update_requires_an_existing_profile() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());

        let error = repository
            .update(sqlite_profile("Missing"))
            .expect_err("update of a missing profile must fail");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn settings_file_contains_no_secret_material() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());
        repository
            .create(postgres_profile("Reporting"))
            .expect("create should succeed");

        let written = fs::read_to_string(settings.path()).expect("settings file should exist");
        for forbidden in ["password", "passwd", "secret", "token", "credential"] {
            assert!(
                !written.to_lowercase().contains(forbidden),
                "settings file leaked `{forbidden}`",
            );
        }
    }

    #[test]
    fn removing_a_profile_removes_its_secret() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());
        let secrets = InMemorySecretStore::new();

        let profile = repository
            .create(postgres_profile("Reporting"))
            .expect("create should succeed");
        let reference = SecretRef::for_profile(&profile.id);
        secrets
            .set(&reference, &crate::database::ConnectionSecret::new("hunter2"))
            .expect("secret should store");

        assert!(remove_profile(&repository, &secrets, &profile.id).expect("remove should work"));
        assert!(!secrets.contains(&reference).expect("contains should work"));
        assert!(repository.list().expect("list should succeed").is_empty());
    }

    #[test]
    fn removing_a_missing_profile_leaves_other_secrets_alone() {
        let settings = TempSettings::new();
        let repository = FileProfileRepository::new(settings.path());
        let secrets = InMemorySecretStore::new();
        let reference = SecretRef::new("profile:someone-else");
        secrets
            .set(&reference, &crate::database::ConnectionSecret::new("hunter2"))
            .expect("secret should store");

        assert!(!remove_profile(&repository, &secrets, &ProfileId::new("missing"))
            .expect("remove should work"));
        assert!(secrets.contains(&reference).expect("contains should work"));
    }
}
