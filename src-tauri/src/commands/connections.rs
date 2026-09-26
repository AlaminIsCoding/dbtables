use tauri::State;

use crate::application::connections::{self, sqlite_descriptor};
use crate::application::profiles::{ConnectionProfileInput, ProfileService};
use crate::database::{ConnectionId, ConnectionState, ConnectionTest, DatabaseState};
use crate::domain::{ConnectionProfile, EngineId, ProfileId, QueryError};

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
/// The engine is read from the descriptor, so MySQL and PostgreSQL settings are
/// tested through their own adapter with the submitted or saved secret.
#[tauri::command]
pub async fn test_connection_profile(
    profiles: State<'_, ProfileService>,
    state: State<'_, DatabaseState>,
    input: ConnectionProfileInput,
) -> Result<ConnectionTest, QueryError> {
    let adapter = state.adapter(input.descriptor.engine());
    profiles.test_connection(adapter, &input).await
}

/// Lists the databases a server profile can address.
///
/// Used to populate a database picker before a profile is saved. Engines with a
/// single fixed database return an `unsupported` error, which callers treat as
/// "no picker" rather than a failure.
#[tauri::command]
pub async fn list_profile_databases(
    profiles: State<'_, ProfileService>,
    state: State<'_, DatabaseState>,
    input: ConnectionProfileInput,
) -> Result<Vec<String>, QueryError> {
    let adapter = state.adapter(input.descriptor.engine());
    profiles.list_databases(adapter, &input).await
}

/// Opens a saved profile and returns its opaque connection token.
#[tauri::command]
pub async fn connect_profile(
    profiles: State<'_, ProfileService>,
    state: State<'_, DatabaseState>,
    profile_id: ProfileId,
) -> Result<ConnectionId, QueryError> {
    let engine = profiles.descriptor_for(&profile_id)?.engine();
    let adapter = state.adapter(engine);
    let connection = profiles.connect(adapter, &profile_id).await?;
    state.record(&connection, engine);
    Ok(connection)
}

/// Opens a saved profile against a specific database.
///
/// A PostgreSQL connection is bound to one database, so switching databases
/// opens a new connection with the chosen database. The profile's saved secret
/// is resolved in the backend; no password crosses this boundary.
#[tauri::command]
pub async fn connect_profile_database(
    profiles: State<'_, ProfileService>,
    state: State<'_, DatabaseState>,
    profile_id: ProfileId,
    database: String,
) -> Result<ConnectionId, QueryError> {
    let engine = profiles.descriptor_for(&profile_id)?.engine();
    let adapter = state.adapter(engine);
    let connection = profiles
        .connect_database(adapter, &profile_id, &database)
        .await?;
    state.record(&connection, engine);
    Ok(connection)
}

/// Opens a local SQLite file read-only and returns its opaque connection token.
///
/// The file path is non-secret profile data; the command returns no driver
/// handle, only an identifier the frontend echoes back on later calls.
#[tauri::command]
pub async fn connect_sqlite(
    state: State<'_, DatabaseState>,
    file_path: String,
) -> Result<ConnectionId, QueryError> {
    let descriptor = sqlite_descriptor(file_path);
    let adapter = state.adapter(EngineId::Sqlite);
    let connection = connections::connect(adapter, &descriptor, None).await?;
    state.record(&connection, EngineId::Sqlite);
    Ok(connection)
}

/// Closes a connection previously opened by a connect command.
#[tauri::command]
pub async fn disconnect_connection(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
) -> Result<(), QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    let result = connections::disconnect(adapter, &connection_id).await;
    // The token is dropped regardless of driver outcome so a failed close never
    // leaves a stale route behind.
    state.forget(&connection_id);
    result
}

/// Reports the current state of a known connection.
#[tauri::command]
pub async fn connection_state(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
) -> Result<ConnectionState, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    connections::connection_state(adapter, &connection_id).await
}
