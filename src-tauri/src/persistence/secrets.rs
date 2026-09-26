//! Protected credential-storage boundary.
//!
//! Passwords are addressed by an opaque [`SecretRef`] and never appear in
//! profile data, settings files, logs, or errors. Two implementations are
//! provided:
//!
//! - [`KeyringSecretStore`] is the production backend. It stores each password
//!   through the [`keyring`] crate's default (`v1`) store, which maps onto the
//!   operating system's protected credential facility: Windows Credential
//!   Manager, macOS Keychain, and the Linux/*BSD Secret Service (D-Bus).
//! - [`InMemorySecretStore`] is a non-persistent double for tests and for
//!   environments without a credential store. It never writes to disk.
//!
//! Callers must not log or serialize a [`ConnectionSecret`]; the type's `Debug`
//! implementation is already redacted and it is deliberately not serializable.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::database::ConnectionSecret;
use crate::domain::errors::{ErrorCategory, QueryError};
use crate::domain::ProfileId;

/// Service name under which entries are registered with the OS credential store.
pub const CREDENTIAL_SERVICE_NAME: &str = "dbtables";

/// Opaque key that identifies one secret in protected storage.
///
/// The value contains no secret material; it is a lookup key only. Serialized
/// as a plain string so it can round-trip through settings if a reference is
/// ever persisted.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretRef(String);

impl SecretRef {
    /// Wraps an arbitrary key.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Derives the reference for a profile from its identifier.
    ///
    /// Prefixing keeps the key distinct from any other entry a future feature
    /// might store under the same service name.
    pub fn for_profile(id: &ProfileId) -> Self {
        Self(format!("profile:{}", id.as_str()))
    }

    /// Borrows the key as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Storage boundary for database passwords.
///
/// Implementations must never write a secret anywhere but the protected store
/// and must never include a secret in an error or log line.
pub trait SecretStore: Send + Sync {
    /// Stores or replaces the secret for `reference`.
    fn set(&self, reference: &SecretRef, secret: &ConnectionSecret) -> Result<(), QueryError>;

    /// Reads the secret for `reference`, or `None` when none is stored.
    fn get(&self, reference: &SecretRef) -> Result<Option<ConnectionSecret>, QueryError>;

    /// Removes the secret for `reference`.
    ///
    /// Returns `Ok(true)` when a secret was removed and `Ok(false)` when there
    /// was nothing to remove. A missing entry is not an error.
    fn delete(&self, reference: &SecretRef) -> Result<bool, QueryError>;

    /// Reports whether a secret is currently stored for `reference`.
    fn contains(&self, reference: &SecretRef) -> Result<bool, QueryError> {
        Ok(self.get(reference)?.is_some())
    }
}

/// Applies an edit's credential without discarding a saved secret.
///
/// A profile edit that leaves the password field blank submits `None` (or an
/// empty secret). Neither case may overwrite the saved value, so the edit is a
/// no-op. A non-empty value replaces the stored secret.
pub fn apply_secret_edit(
    store: &dyn SecretStore,
    reference: &SecretRef,
    submitted: Option<&ConnectionSecret>,
) -> Result<(), QueryError> {
    match submitted {
        Some(secret) if !secret.is_empty() => store.set(reference, secret),
        _ => Ok(()),
    }
}

/// Replaces every occurrence of `secret` in `text` with a redaction marker.
///
/// Error messages should already exclude secrets; this helper is a safety net
/// for wrapping engine/driver text that might echo a submitted value.
pub fn redact_secret(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_string()
    } else {
        text.replace(secret, "[redacted]")
    }
}

/// Production secret store backed by the OS credential facility.
///
/// Each secret is stored under [`CREDENTIAL_SERVICE_NAME`] with the
/// [`SecretRef`] as the account name.
pub struct KeyringSecretStore {
    service: String,
}

impl KeyringSecretStore {
    /// Creates a store that registers entries under `service`.
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// Creates a store using the application's default service name.
    pub fn with_default_service() -> Self {
        Self::new(CREDENTIAL_SERVICE_NAME)
    }

    fn entry(&self, reference: &SecretRef) -> Result<keyring::Entry, QueryError> {
        keyring::Entry::new(&self.service, reference.as_str()).map_err(|error| {
            QueryError::new(
                ErrorCategory::Configuration,
                "could not open the operating-system credential store",
            )
            .with_engine_detail(error.to_string())
        })
    }
}

impl SecretStore for KeyringSecretStore {
    fn set(&self, reference: &SecretRef, secret: &ConnectionSecret) -> Result<(), QueryError> {
        self.entry(reference)?
            .set_password(secret.expose())
            .map_err(|error| {
                QueryError::new(
                    ErrorCategory::Internal,
                    "could not save the password to the operating-system credential store",
                )
                .with_engine_detail(error.to_string())
            })
    }

    fn get(&self, reference: &SecretRef) -> Result<Option<ConnectionSecret>, QueryError> {
        match self.entry(reference)?.get_password() {
            Ok(value) => Ok(Some(ConnectionSecret::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(QueryError::new(
                ErrorCategory::Internal,
                "could not read the password from the operating-system credential store",
            )
            .with_engine_detail(error.to_string())),
        }
    }

    fn delete(&self, reference: &SecretRef) -> Result<bool, QueryError> {
        match self.entry(reference)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(QueryError::new(
                ErrorCategory::Internal,
                "could not delete the password from the operating-system credential store",
            )
            .with_engine_detail(error.to_string())),
        }
    }
}

/// Non-persistent secret store for tests and store-less environments.
///
/// Values live only in this process's memory and are never written to disk.
#[derive(Default)]
pub struct InMemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
}

impl InMemorySecretStore {
    /// Creates an empty store.
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl SecretStore for InMemorySecretStore {
    fn set(&self, reference: &SecretRef, secret: &ConnectionSecret) -> Result<(), QueryError> {
        self.entries()
            .insert(reference.as_str().to_string(), secret.expose().to_string());
        Ok(())
    }

    fn get(&self, reference: &SecretRef) -> Result<Option<ConnectionSecret>, QueryError> {
        Ok(self
            .entries()
            .get(reference.as_str())
            .map(ConnectionSecret::new))
    }

    fn delete(&self, reference: &SecretRef) -> Result<bool, QueryError> {
        Ok(self.entries().remove(reference.as_str()).is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_secret_edit, redact_secret, InMemorySecretStore, SecretRef, SecretStore,
    };
    use crate::database::ConnectionSecret;
    use crate::domain::ProfileId;

    #[test]
    fn secret_ref_for_profile_is_deterministic_and_plain() {
        let id = ProfileId::new("profile-1");
        let reference = SecretRef::for_profile(&id);

        assert_eq!(reference, SecretRef::for_profile(&id));
        assert!(reference.as_str().contains("profile-1"));
        assert_eq!(
            serde_json::to_value(&reference).expect("reference should serialize"),
            serde_json::json!("profile:profile-1")
        );
    }

    #[test]
    fn in_memory_store_round_trips_and_deletes() {
        let store = InMemorySecretStore::new();
        let reference = SecretRef::new("profile:1");

        assert!(!store.contains(&reference).expect("contains should work"));
        assert!(store.get(&reference).expect("get should work").is_none());

        store
            .set(&reference, &ConnectionSecret::new("hunter2"))
            .expect("set should work");
        assert!(store.contains(&reference).expect("contains should work"));
        assert_eq!(
            store
                .get(&reference)
                .expect("get should work")
                .expect("value should be present")
                .expose(),
            "hunter2"
        );

        assert!(store.delete(&reference).expect("delete should work"));
        assert!(!store.delete(&reference).expect("second delete should work"));
        assert!(store.get(&reference).expect("get should work").is_none());
    }

    #[test]
    fn blank_edits_do_not_overwrite_a_saved_secret() {
        let store = InMemorySecretStore::new();
        let reference = SecretRef::new("profile:1");
        store
            .set(&reference, &ConnectionSecret::new("kept-secret"))
            .expect("initial set should work");

        // A blank edit submits `None`.
        apply_secret_edit(&store, &reference, None).expect("blank edit should be a no-op");
        // A blank edit also submits an empty secret.
        let empty = ConnectionSecret::new("");
        apply_secret_edit(&store, &reference, Some(&empty))
            .expect("empty edit should be a no-op");

        let stored = store
            .get(&reference)
            .expect("get should work")
            .expect("secret should remain");
        assert_eq!(stored.expose(), "kept-secret");
    }

    #[test]
    fn non_empty_edits_replace_the_saved_secret() {
        let store = InMemorySecretStore::new();
        let reference = SecretRef::new("profile:1");

        apply_secret_edit(&store, &reference, Some(&ConnectionSecret::new("first")))
            .expect("first edit should write");
        apply_secret_edit(&store, &reference, Some(&ConnectionSecret::new("second")))
            .expect("second edit should replace");

        let stored = store
            .get(&reference)
            .expect("get should work")
            .expect("secret should be present");
        assert_eq!(stored.expose(), "second");
    }

    #[test]
    fn redact_secret_hides_the_value() {
        let rendered = redact_secret("login failed for hunter2", "hunter2");

        assert!(!rendered.contains("hunter2"));
        assert!(rendered.contains("[redacted]"));
        assert_eq!(redact_secret("no secret here", ""), "no secret here");
    }
}
