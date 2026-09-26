use tauri::State;

use crate::application::queries;
use crate::database::{CancelOutcome, ConnectionId, SqliteAdapter};
use crate::domain::{
    EngineCapabilities, OperationId, QueryError, QueryRequest, QueryResult,
};

/// Executes one read-only SQL statement and returns a normalized result.
///
/// The application service applies the row cap; the adapter returns completed
/// outcomes (success, empty, failed) as a `QueryResult`, so only precondition
/// failures such as an unknown connection reject the call.
#[tauri::command]
pub async fn execute_query(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    request: QueryRequest,
) -> Result<QueryResult, QueryError> {
    queries::execute_query(&*adapter, &connection_id, request).await
}

/// Reports the driver capabilities for the active adapter.
///
/// The UI gates engine-specific controls such as cancellation on this instead
/// of assuming every connection supports them.
#[tauri::command]
pub fn query_capabilities(adapter: State<'_, SqliteAdapter>) -> EngineCapabilities {
    queries::capabilities(&*adapter)
}

/// Requests cancellation of a running operation.
///
/// Adapters without cancellation capability reject with an `unsupported`
/// `QueryError`; a successful outcome only means the request was delivered, not
/// that the operation was rolled back.
#[tauri::command]
pub async fn cancel_query(
    adapter: State<'_, SqliteAdapter>,
    connection_id: ConnectionId,
    operation_id: OperationId,
) -> Result<CancelOutcome, QueryError> {
    queries::cancel_query(&*adapter, &connection_id, &operation_id).await
}
