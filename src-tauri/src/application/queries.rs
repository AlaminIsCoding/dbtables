//! Query execution use cases.
//!
//! The command layer calls these functions instead of an adapter directly. The
//! application owns the *policy* for how many rows a single statement may load
//! into memory; the adapter still enforces its own hard ceiling as defense in
//! depth. Normalized result mapping, duration, and error categories are handled
//! by the adapter so the application stays engine-neutral.

use crate::database::{CancelOutcome, ConnectionId, DatabaseAdapter};
use crate::domain::{EngineCapabilities, ErrorCategory, OperationId, QueryError, QueryRequest, QueryResult};

/// Rows returned when a request does not set its own cap.
///
/// Chosen so an ordinary `SELECT *` stays inspectable without letting an
/// accidental full-table read consume unbounded frontend/backend memory.
pub const DEFAULT_MAX_ROWS: u32 = 500;

/// Hard upper bound the application applies to any caller-supplied cap.
pub const HARD_MAX_ROWS: u32 = 10_000;

/// Rows added to the cap each time a caller fetches more of the same result.
///
/// The frontend mirrors this step so a "fetch more" request grows by a bounded
/// amount; the backend still clamps the result to [`HARD_MAX_ROWS`].
pub const FETCH_MORE_STEP: u32 = 500;

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

/// Whether a truncated result that showed `loaded` rows can be extended.
///
/// Reaching [`HARD_MAX_ROWS`] is the end of the bounded flow: the application
/// will not grow a result past its hard ceiling, so the UI must stop offering
/// "fetch more" rather than re-running the same statement forever.
pub fn can_fetch_more(loaded: u32) -> bool {
    loaded < HARD_MAX_ROWS
}

/// Resolves the cap to request for the next incremental fetch.
///
/// Returns `None` when `loaded` rows already reached [`HARD_MAX_ROWS`], so a
/// caller cannot ask for an unbounded extension. Otherwise the cap grows by
/// [`FETCH_MORE_STEP`] and is clamped to the hard ceiling.
pub fn next_fetch_rows(loaded: u32) -> Option<u32> {
    if !can_fetch_more(loaded) {
        return None;
    }

    Some(loaded.saturating_add(FETCH_MORE_STEP).min(HARD_MAX_ROWS))
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

/// Reports the capabilities the adapter can actually honor.
///
/// The UI uses this to gate engine-specific controls such as cancellation
/// instead of assuming every engine supports the same behavior.
pub fn capabilities(adapter: &dyn DatabaseAdapter) -> EngineCapabilities {
    adapter.capabilities()
}

/// Requests cancellation of a running operation.
///
/// Cancellation is a request, not a confirmed outcome: adapters that do not
/// support it reject with an `Unsupported` error, and a success only means the
/// driver accepted the request. The running [`execute_query`] call reports the
/// operation's actual final state, so callers must not treat this result as the
/// query's outcome.
pub async fn cancel_query(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    operation: &OperationId,
) -> Result<CancelOutcome, QueryError> {
    adapter.cancel(connection, operation).await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{
        cancel_query, can_fetch_more, capabilities, execute_query, next_fetch_rows,
        resolve_max_rows, DEFAULT_MAX_ROWS, FETCH_MORE_STEP, HARD_MAX_ROWS,
    };
    use crate::database::testing::FakeAdapter;
    use crate::database::{CancelOutcome, ConnectionId, ConnectionSecret, DatabaseAdapter};
    use crate::domain::connection::{ServerConnection, SqliteConnection, TlsMode};
    use crate::domain::{
        ConnectionDescriptor, EngineId, ErrorCategory, OperationId, OperationState, QueryRequest,
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
    fn next_fetch_rows_grows_by_a_bounded_step_and_stops_at_the_hard_cap() {
        assert_eq!(next_fetch_rows(0), Some(FETCH_MORE_STEP));
        assert_eq!(next_fetch_rows(FETCH_MORE_STEP), Some(FETCH_MORE_STEP * 2));
        assert_eq!(
            next_fetch_rows(HARD_MAX_ROWS - 1),
            Some(HARD_MAX_ROWS),
            "the next fetch must not exceed the hard ceiling"
        );

        assert!(can_fetch_more(0));
        assert!(can_fetch_more(HARD_MAX_ROWS - 1));
        assert!(!can_fetch_more(HARD_MAX_ROWS));
        assert_eq!(next_fetch_rows(HARD_MAX_ROWS), None);
        assert_eq!(
            next_fetch_rows(HARD_MAX_ROWS + 1),
            None,
            "an already-over-cap result cannot be extended"
        );
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

    #[test]
    fn capabilities_delegate_to_the_adapter() {
        let adapter = FakeAdapter::new(EngineId::Postgres);
        assert_eq!(capabilities(&adapter), EngineId::Postgres.capabilities());
        assert!(capabilities(&adapter).cancellation);

        let sqlite = FakeAdapter::new(EngineId::Sqlite);
        assert_eq!(capabilities(&sqlite), EngineId::Sqlite.capabilities());
        assert!(!capabilities(&sqlite).cancellation);
    }

    #[test]
    fn cancel_query_requires_adapter_capability_and_reports_the_request() {
        let unsupported = FakeAdapter::new(EngineId::Sqlite);
        let sqlite_connection = block_on(unsupported.connect(&sqlite_descriptor(), None))
            .expect("fake connect should succeed");
        let error = block_on(cancel_query(
            &unsupported,
            &sqlite_connection,
            &OperationId::new("op-running"),
        ))
        .expect_err("SQLite must report cancellation as unsupported");
        assert_eq!(error.category, ErrorCategory::Unsupported);

        let descriptor = ConnectionDescriptor::Postgres(ServerConnection {
            host: "localhost".to_string(),
            port: 5432,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
        });
        let secret = ConnectionSecret::new("test-only-value");
        let adapter = FakeAdapter::new(EngineId::Postgres).with_running_operation("op-running");
        let connection = block_on(adapter.connect(&descriptor, Some(&secret)))
            .expect("fake connect should succeed");

        assert_eq!(
            block_on(cancel_query(
                &adapter,
                &connection,
                &OperationId::new("op-running")
            ))
            .expect("a running operation accepts cancellation"),
            CancelOutcome::Requested
        );
        assert_eq!(
            block_on(cancel_query(
                &adapter,
                &connection,
                &OperationId::new("op-idle")
            ))
            .expect("an idle operation does not accept cancellation"),
            CancelOutcome::NotRunning
        );
    }
}
