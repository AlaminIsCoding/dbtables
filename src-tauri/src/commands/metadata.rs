use tauri::State;

use crate::application::metadata;
use crate::database::{
    ConnectionId, DatabaseState, ObjectRef, ObjectScope, ScopeListing, TableDescription,
};
use crate::domain::QueryError;

/// Lists tables and views visible to a connection.
///
/// `scope` is optional because engines differ: SQLite exposes neither a
/// database nor a schema, MySQL exposes databases, and PostgreSQL exposes
/// schemas.
#[tauri::command]
pub async fn list_objects(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
    scope: Option<ObjectScope>,
) -> Result<Vec<ObjectRef>, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    let scope = scope.unwrap_or_default();
    metadata::list_objects(adapter, &connection_id, &scope).await
}

/// Lists database/catalog and schema scopes exposed by a connection.
#[tauri::command]
pub async fn list_scopes(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
) -> Result<ScopeListing, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    metadata::list_scopes(adapter, &connection_id).await
}

/// Describes a table or view, including its columns and supported metadata.
#[tauri::command]
pub async fn describe_table(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
    object: ObjectRef,
) -> Result<TableDescription, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    metadata::describe_table(adapter, &connection_id, &object).await
}
