use tauri::State;

use crate::application::queries;
use crate::database::{CancelOutcome, ConnectionId, DatabaseState};
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
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
    request: QueryRequest,
) -> Result<QueryResult, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    queries::execute_query(adapter, &connection_id, request).await
}

/// Reports the driver capabilities for a connection's engine.
///
/// Capabilities are per-connection because each engine's adapter differs; the
/// UI gates engine-specific controls such as cancellation on this instead of
/// assuming every connection supports them.
#[tauri::command]
pub fn query_capabilities(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
) -> Result<EngineCapabilities, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    Ok(queries::capabilities(adapter))
}

/// Requests cancellation of a running operation.
///
/// Adapters without cancellation capability reject with an `unsupported`
/// `QueryError`; a successful outcome only means the request was delivered, not
/// that the operation was rolled back.
#[tauri::command]
pub async fn cancel_query(
    state: State<'_, DatabaseState>,
    connection_id: ConnectionId,
    operation_id: OperationId,
) -> Result<CancelOutcome, QueryError> {
    let adapter = state.adapter_for(&connection_id)?;
    queries::cancel_query(adapter, &connection_id, &operation_id).await
}
