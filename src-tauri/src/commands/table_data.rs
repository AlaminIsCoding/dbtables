use tauri::State;

use crate::application::table_data::{self, ChangeGroupResult};
use crate::database::{ChangeRequest, ConnectionId, SqliteAdapter, TablePage, TablePageRequest};
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

/// Applies a batch of staged inserts/updates/deletes as one guarded group.
///
/// Every request is validated before the first write. When the engine supports
/// transactions the batch is wrapped in one and committed only if all changes
/// apply; a conflict or failure rolls it back without retrying, and an
/// uncertain write outcome is reported as `outcome_unknown` rather than
/// success. A precondition failure (for example, a table with no safe row
/// identity) rejects with a `QueryError` before any row is written.
#[tauri::command]
pub async fn apply_table_changes(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    requests: Vec<ChangeRequest>,
) -> Result<ChangeGroupResult, QueryError> {
    table_data::apply_changes(&*adapter, &connection_id, requests).await
}
