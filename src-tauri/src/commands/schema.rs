use tauri::State;

use crate::application::schema;
use crate::database::{
    ColumnDefinition, ConnectionId, ForeignKeyDefinition, ObjectRef, SqliteAdapter, TableDefinition,
    TableDescription, TableFilter,
};
use crate::domain::QueryError;

/// Creates a table from a typed definition and returns its description.
///
/// Every identifier in the definition is validated and quoted by the adapter;
/// structural errors are rejected before any statement runs.
#[tauri::command]
pub async fn create_table(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    definition: TableDefinition,
) -> Result<TableDescription, QueryError> {
    schema::create_table(&*adapter, &connection_id, &definition).await
}

/// Drops a table.
///
/// `cascade` is accepted for contract parity; SQLite has no
/// `DROP TABLE ... CASCADE` and ignores it.
#[tauri::command]
pub async fn drop_table(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    cascade: bool,
) -> Result<(), QueryError> {
    schema::drop_table(&*adapter, &connection_id, &object, cascade).await
}

/// Adds a column to an existing table.
#[tauri::command]
pub async fn add_column(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    column: ColumnDefinition,
) -> Result<(), QueryError> {
    schema::add_column(&*adapter, &connection_id, &object, &column).await
}

/// Renames a column on an existing table.
#[tauri::command]
pub async fn rename_column(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    from: String,
    to: String,
) -> Result<(), QueryError> {
    schema::rename_column(&*adapter, &connection_id, &object, &from, &to).await
}

/// Drops a column from an existing table.
#[tauri::command]
pub async fn drop_column(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    column: String,
) -> Result<(), QueryError> {
    schema::drop_column(&*adapter, &connection_id, &object, &column).await
}

/// Adds a foreign-key constraint to an existing table.
#[tauri::command]
pub async fn add_foreign_key(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    foreign_key: ForeignKeyDefinition,
) -> Result<(), QueryError> {
    schema::add_foreign_key(&*adapter, &connection_id, &object, &foreign_key).await
}

/// Drops a named foreign-key constraint from an existing table.
#[tauri::command]
pub async fn drop_foreign_key(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    name: String,
) -> Result<(), QueryError> {
    schema::drop_foreign_key(&*adapter, &connection_id, &object, &name).await
}

/// Creates an index on one or more columns of a table.
#[tauri::command]
pub async fn create_index(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    name: String,
    columns: Vec<String>,
    unique: bool,
) -> Result<(), QueryError> {
    schema::create_index(&*adapter, &connection_id, &object, &name, &columns, unique).await
}

/// Drops an index by name.
#[tauri::command]
pub async fn drop_index(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    name: String,
) -> Result<(), QueryError> {
    schema::drop_index(&*adapter, &connection_id, &object, &name).await
}

/// Counts rows in a table, optionally applying validated filters.
#[tauri::command]
pub async fn count_table_rows(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    object: ObjectRef,
    filters: Option<Vec<TableFilter>>,
) -> Result<u64, QueryError> {
    let filters = filters.unwrap_or_default();
    schema::count_table_rows(&*adapter, &connection_id, &object, &filters).await
}
