use tauri::State;

use crate::application::queries;
use crate::database::{ConnectionId, SqliteAdapter};
use crate::domain::{QueryError, QueryRequest, QueryResult};

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
