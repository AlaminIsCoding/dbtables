use tauri::State;

use crate::application::connections::{self, sqlite_descriptor};
use crate::application::profiles::{ConnectionProfileInput, ProfileService};
use crate::database::{ConnectionId, ConnectionState, ConnectionTest, SqliteAdapter};
use crate::domain::{ConnectionProfile, ProfileId, QueryError};

/// Lists persisted, secret-free connection profiles.
#[tauri::command]
pub fn list_connection_profiles(
    profiles: State<'_, ProfileService>,
) -> Result<Vec<ConnectionProfile>, QueryError> {
    profiles.list()
}

/// Creates or updates a connection profile and stores any submitted password
/// through the operating-system credential store.
#[tauri::command]
pub fn save_connection_profile(
    profiles: State<'_, ProfileService>,
    input: ConnectionProfileInput,
) -> Result<ConnectionProfile, QueryError> {
    profiles.save(input)
}

/// Deletes a saved profile and its protected credential, when one exists.
#[tauri::command]
pub fn delete_connection_profile(
    profiles: State<'_, ProfileService>,
    profile_id: ProfileId,
) -> Result<bool, QueryError> {
    profiles.delete(&profile_id)
}

/// Tests submitted settings without retaining a connection.
///
/// This app build currently wires SQLite into the command layer. Server profile
/// CRUD is available, but testing or connecting a MySQL/PostgreSQL profile
/// returns a clear adapter/configuration error until those adapters are wired
/// into the application state.
#[tauri::command]
pub async fn test_connection_profile(
    profiles: State<'_, ProfileService>,
    adapter: State<'_, SqliteAdapter>,
    input: ConnectionProfileInput,
) -> Result<ConnectionTest, QueryError> {
    profiles.test_connection(&*adapter, &input).await
}

/// Opens a saved profile and returns its opaque connection token.
#[tauri::command]
pub async fn connect_profile(
    profiles: State<'_, ProfileService>,
    adapter: State<'_, SqliteAdapter>,
    profile_id: ProfileId,
) -> Result<ConnectionId, QueryError> {
    profiles.connect(&*adapter, &profile_id).await
}

/// Opens a local SQLite file read-only and returns its opaque connection token.
///
/// The file path is non-secret profile data; the command returns no driver
/// handle, only an identifier the frontend echoes back on later calls.
#[tauri::command]
pub async fn connect_sqlite(
    adapter: State<'_, SqliteAdapter>,
    file_path: String,
) -> Result<ConnectionId, QueryError> {
    let descriptor = sqlite_descriptor(file_path);
    connections::connect(&*adapter, &descriptor, None).await
}

/// Closes a connection previously returned by [`connect_sqlite`].
#[tauri::command]
pub async fn disconnect_connection(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
) -> Result<(), QueryError> {
    connections::disconnect(&*adapter, &connection_id).await
}

/// Reports the current state of a known connection.
#[tauri::command]
pub async fn connection_state(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
) -> Result<ConnectionState, QueryError> {
    connections::connection_state(&*adapter, &connection_id).await
}
