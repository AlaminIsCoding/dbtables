//! Table data browsing use cases.
//!
//! The command layer calls these functions instead of an adapter directly, so
//! the page flow stays engine-neutral. The application owns the *policy* for how
//! large one page may be; the adapter still enforces its own hard ceiling as
//! defense in depth, validates every filter/sort identifier against the table
//! metadata, and binds comparison values rather than interpolating them.
//!
//! A page always reports the columns it returned and the `row_identity` the
//! adapter could establish. An empty identity is surfaced honestly (through
//! [`TablePage::has_row_identity`]) so callers can refuse unsafe row targeting
//! instead of assuming every row is editable.

use crate::database::{ConnectionId, DatabaseAdapter, TablePage, TablePageRequest};
use crate::domain::{ErrorCategory, QueryError};

/// Rows a table browser should request for its default page.
///
/// Chosen so an ordinary table stays inspectable without loading a full table
/// into frontend/backend memory; callers pick their own bounded size and the
/// service clamps it to [`HARD_MAX_TABLE_PAGE_ROWS`].
pub const DEFAULT_TABLE_PAGE_ROWS: u32 = 100;

/// Hard upper bound the application applies to any caller-supplied page size.
pub const HARD_MAX_TABLE_PAGE_ROWS: u32 = crate::database::MAX_TABLE_PAGE_ROWS;

/// Resolves the page size for a table page request.
///
/// `0` is rejected rather than silently treated as "unlimited" or "empty";
/// values above [`HARD_MAX_TABLE_PAGE_ROWS`] are clamped so a caller cannot pull
/// an unbounded page. The adapter performs the same resolution as a second line
/// of defense.
pub fn resolve_page_limit(requested: u32) -> Result<u32, QueryError> {
    if requested == 0 {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "the table page size must be greater than zero",
        ));
    }
    Ok(requested.min(HARD_MAX_TABLE_PAGE_ROWS))
}

/// Fetches one bounded, filtered, sorted page of a table or view.
///
/// The request's `limit` is resolved through [`resolve_page_limit`] before the
/// adapter runs, so every page this service fetches is bounded. The returned
/// [`TablePage`] carries the columns, the `row_identity` (empty when the object
/// has no safe identity), and the continuation offset when more rows may exist.
pub async fn fetch_table_page(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    request: TablePageRequest,
) -> Result<TablePage, QueryError> {
    let limit = resolve_page_limit(request.limit)?;
    adapter
        .fetch_table_page(connection, request.with_limit(limit))
        .await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use super::{
        fetch_table_page, resolve_page_limit, DEFAULT_TABLE_PAGE_ROWS,
        HARD_MAX_TABLE_PAGE_ROWS,
    };
    use crate::database::testing::FakeAdapter;
    use crate::database::{
        ConnectionId, DatabaseAdapter, FilterOperator, ObjectKind, ObjectRef, TableFilter,
        TablePageRequest,
    };
    use crate::domain::connection::SqliteConnection;
    use crate::domain::{ConnectionDescriptor, EngineId, ErrorCategory};

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

    fn users_object() -> ObjectRef {
        ObjectRef {
            database: None,
            schema: None,
            name: "users".to_string(),
            kind: ObjectKind::Table,
        }
    }

    #[test]
    fn resolve_page_limit_rejects_zero_and_clamps_to_the_hard_ceiling() {
        assert_eq!(resolve_page_limit(DEFAULT_TABLE_PAGE_ROWS), Ok(DEFAULT_TABLE_PAGE_ROWS));
        assert_eq!(resolve_page_limit(1), Ok(1));
        assert_eq!(
            resolve_page_limit(HARD_MAX_TABLE_PAGE_ROWS + 1),
            Ok(HARD_MAX_TABLE_PAGE_ROWS)
        );

        let error = resolve_page_limit(0).expect_err("zero is not a valid page size");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn fetch_table_page_clamps_the_limit_and_returns_row_identity() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let page = block_on(fetch_table_page(
            &adapter,
            &connection,
            TablePageRequest::new("page-1", users_object(), HARD_MAX_TABLE_PAGE_ROWS + 25),
        ))
        .expect("a bounded page should succeed");

        assert_eq!(page.operation_id.as_str(), "page-1");
        assert_eq!(page.limit, HARD_MAX_TABLE_PAGE_ROWS);
        assert_eq!(page.row_identity, ["id"]);
        assert!(page.has_row_identity());
        assert_eq!(page.rows.len(), 3);
    }

    #[test]
    fn fetch_table_page_reports_a_missing_row_identity() {
        let adapter = FakeAdapter::new(EngineId::Sqlite).without_primary_key();
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let page = block_on(fetch_table_page(
            &adapter,
            &connection,
            TablePageRequest::new("page-no-pk", users_object(), 10),
        ))
        .expect("paging still works without a primary key");

        assert!(
            page.row_identity.is_empty(),
            "a table without a safe identity must report no identity"
        );
        assert!(!page.has_row_identity());
    }

    #[test]
    fn fetch_table_page_rejects_invalid_limits_and_identifiers() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let zero = block_on(fetch_table_page(
            &adapter,
            &connection,
            TablePageRequest::new("page-zero", users_object(), 0),
        ))
        .expect_err("a zero page size must be rejected before the adapter runs");
        assert_eq!(zero.category, ErrorCategory::Validation);

        let unknown = block_on(fetch_table_page(
            &adapter,
            &connection,
            TablePageRequest::new("page-bad", users_object(), 10).with_filters(vec![
                TableFilter {
                    column: "name = 'bob'".to_string(),
                    operator: FilterOperator::Equal,
                    values: vec![crate::domain::CellValue::Text("bob".to_string())],
                },
            ]),
        ))
        .expect_err("an identifier outside table metadata must be rejected");
        assert_eq!(unknown.category, ErrorCategory::Validation);

        // An unknown connection is still a connection error, not a capability one.
        let missing = block_on(fetch_table_page(
            &adapter,
            &ConnectionId::new("missing"),
            TablePageRequest::new("page-missing", users_object(), 10),
        ))
        .expect_err("an unknown connection must fail");
        assert_eq!(missing.category, ErrorCategory::Connection);
    }
}
