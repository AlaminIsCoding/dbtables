use tauri::State;

use crate::application::metadata;
use crate::database::{
    ConnectionId, ObjectRef, ObjectScope, ScopeListing, SqliteAdapter, TableDescription,
};
use crate::domain::QueryError;

/// Lists tables and views visible to a connection.
///
/// `scope` is optional because SQLite exposes neither a database nor a schema
/// scope; engines that do (MySQL/PostgreSQL) use it in later slices.
#[tauri::command]
pub async fn list_objects(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    scope: Option<ObjectScope>,
) -> Result<Vec<ObjectRef>, QueryError> {
    let scope = scope.unwrap_or_default();
    metadata::list_objects(&*adapter, &connection_id, &scope).await
}

/// Lists database/catalog and schema scopes exposed by a connection.
#[tauri::command]
pub async fn list_scopes(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
) -> Result<ScopeListing, QueryError> {
    metadata::list_scopes(&*adapter, &connection_id).await
}

/// Describes a table or view, including its columns and supported metadata.
#[tauri::command]
pub async fn describe_table(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
) -> Result<TableDescription, QueryError> {
    metadata::describe_table(&*adapter, &connection_id, &object).await
}
