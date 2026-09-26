use tauri::State;

use crate::application::table_data;
use crate::database::{ConnectionId, SqliteAdapter, TablePage, TablePageRequest};
use crate::domain::QueryError;

/// Fetches one bounded, filtered, sorted page of a table or view.
///
/// The request carries column identifiers and bound values separately. The
/// application service clamps the page size and the adapter validates every
/// identifier against table metadata, so no caller-controlled text reaches the
/// statement as SQL. The returned page reports the row identity the adapter
/// could establish, or none when the object has no safe identifier.
#[tauri::command]
pub async fn fetch_table_page(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    request: TablePageRequest,
) -> Result<TablePage, QueryError> {
    table_data::fetch_table_page(&*adapter, &connection_id, request).await
}
