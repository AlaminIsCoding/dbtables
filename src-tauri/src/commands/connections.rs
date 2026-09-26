use tauri::State;

use crate::application::connections::{self, sqlite_descriptor};
use crate::database::{ConnectionId, ConnectionState, SqliteAdapter};
use crate::domain::QueryError;

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
