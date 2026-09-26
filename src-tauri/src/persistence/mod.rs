//! Local persistence for connection profiles and protected credentials.
//!
//! This module implements the storage half of the connection-profile boundary
//! described in `ARCHITECTURE.md` §7:
//!
//! - [`profiles`] persists **non-secret** profile fields (name, engine, paths,
//!   host/port, database, username, TLS mode) as a versioned JSON document.
//! - [`settings`] owns the settings format version and the upgrade path between
//!   versions.
//! - [`secrets`] defines the credential-storage boundary and the platform
//!   implementation.
//!
//! ## Credential-store decision (spec 06, T1)
//!
//! Passwords are stored through the [`keyring`] crate using its default `v1`
//! store, which selects the operating system's protected credential facility:
//!
//! | Platform      | Backing store                       |
//! |---------------|-------------------------------------|
//! | Windows       | Windows Credential Manager          |
//! | macOS         | Keychain                            |
//! | Linux / *BSD  | Secret Service (D-Bus)              |
//!
//! The `v1` feature set (the crate default) was chosen over the broader `cli`
//! feature set because it selects a native store automatically on every
//! supported desktop platform without extra runtime setup. [`KeyringSecretStore`]
//! keys each password by a [`SecretRef`] derived from the profile identifier.
//!
//! Profile data passed to [`profiles`] therefore contains only the identifier,
//! never a password. [`InMemorySecretStore`] is provided for tests and for
//! environments with no credential store; it never writes to disk.

pub mod profiles;
pub mod secrets;
pub mod settings;

pub use profiles::{remove_profile, FileProfileRepository, ProfileRepository};
pub use secrets::{
    apply_secret_edit, redact_secret, InMemorySecretStore, KeyringSecretStore, SecretRef,
    SecretStore, CREDENTIAL_SERVICE_NAME,
};
pub use settings::{migrate, SettingsDocument, SETTINGS_FORMAT_VERSION};
