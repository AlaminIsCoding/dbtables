//! Query execution use cases.
//!
//! The command layer calls these functions instead of an adapter directly. The
//! application owns the *policy* for how many rows a single statement may load
//! into memory; the adapter still enforces its own hard ceiling as defense in
//! depth. Normalized result mapping, duration, and error categories are handled
//! by the adapter so the application stays engine-neutral.

use crate::database::{ConnectionId, DatabaseAdapter};
use crate::domain::{ErrorCategory, QueryError, QueryRequest, QueryResult};

/// Rows returned when a request does not set its own cap.
///
/// Chosen so an ordinary `SELECT *` stays inspectable without letting an
/// accidental full-table read consume unbounded frontend/backend memory.
pub const DEFAULT_MAX_ROWS: u32 = 500;

/// Hard upper bound the application applies to any caller-supplied cap.
pub const HARD_MAX_ROWS: u32 = 10_000;

/// Resolves the row cap for a request.
///
/// `None` gets the default; an explicit `0` is rejected rather than silently
/// treated as "unlimited" or "empty". Values above [`HARD_MAX_ROWS`] are
/// clamped.
pub fn resolve_max_rows(requested: Option<u32>) -> Result<u32, QueryError> {
    match requested {
        None => Ok(DEFAULT_MAX_ROWS),
        Some(0) => Err(QueryError::new(
            ErrorCategory::Validation,
            "the maximum row count must be greater than zero",
        )),
        Some(value) => Ok(value.min(HARD_MAX_ROWS)),
    }
}

/// Executes one SQL statement with a bounded result size.
///
/// The request's `max_rows` is resolved through [`resolve_max_rows`] before the
/// adapter runs, so every execution this slice performs is capped.
pub async fn execute_query(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    request: QueryRequest,
) -> Result<QueryResult, QueryError> {
    let cap = resolve_max_rows(request.max_rows)?;
    adapter
        .execute(connection, request.with_max_rows(cap))
        .await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{execute_query, resolve_max_rows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS};
    use crate::database::testing::FakeAdapter;
    use crate::database::{ConnectionId, DatabaseAdapter};
    use crate::domain::connection::SqliteConnection;
    use crate::domain::{
        ConnectionDescriptor, EngineId, ErrorCategory, OperationState, QueryRequest,
    };

    fn block_on<F: Future>(future: F) -> F::Output {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = Box::pin(future);
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn sqlite_descriptor() -> ConnectionDescriptor {
        ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: "C:/data/app.sqlite".to_string(),
        })
    }

    #[test]
    fn resolve_max_rows_defaults_clamps_and_rejects_zero() {
        assert_eq!(resolve_max_rows(None), Ok(DEFAULT_MAX_ROWS));
        assert_eq!(resolve_max_rows(Some(10)), Ok(10));
        assert_eq!(
            resolve_max_rows(Some(HARD_MAX_ROWS + 1)),
            Ok(HARD_MAX_ROWS)
        );

        let error = resolve_max_rows(Some(0)).expect_err("zero is not a valid cap");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn execute_query_applies_the_resolved_cap() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection = block_on(adapter.connect(&sqlite_descriptor(), None))
            .expect("fake connect should succeed");

        let result = block_on(execute_query(
            &adapter,
            &connection,
            QueryRequest::new("op", "SELECT id, name FROM users").with_max_rows(1),
        ))
        .expect("fake select should succeed");

        assert_eq!(result.state, OperationState::Succeeded);
        assert_eq!(result.rows.len(), 1);
        assert!(result.truncated);

        let unbounded = block_on(execute_query(
            &adapter,
            &connection,
            QueryRequest::new("op", "SELECT id, name FROM users"),
        ))
        .expect("fake select should succeed");

        assert!(!unbounded.truncated);
        assert_eq!(unbounded.rows.len(), 2);
    }

    #[test]
    fn execute_query_reports_precondition_failures() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection = block_on(adapter.connect(&sqlite_descriptor(), None))
            .expect("fake connect should succeed");

        let zero = block_on(execute_query(
            &adapter,
            &connection,
            QueryRequest::new("op", "SELECT 1").with_max_rows(0),
        ))
        .expect_err("a zero cap must be rejected");
        assert_eq!(zero.category, ErrorCategory::Validation);

        let unknown = block_on(execute_query(
            &adapter,
            &ConnectionId::new("missing"),
            QueryRequest::new("op", "SELECT 1"),
        ))
        .expect_err("an unknown connection must fail");
        assert_eq!(unknown.category, ErrorCategory::Connection);
    }
}
