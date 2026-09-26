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

use crate::database::{
    validate_pending_change, ChangeOutcome, ChangeRequest, ChangeResult, ConnectionId,
    DatabaseAdapter, ObjectKind, TablePage, TablePageRequest, TransactionId,
};
use crate::domain::{ErrorCategory, QueryError};
use serde::{Deserialize, Serialize};

/// How a group of staged changes ended.
///
/// The variants distinguish the outcomes a user must be able to see: a clean
/// apply, a conflict that was rolled back, a failure that was rolled back, an
/// unconfirmed write that must not be retried, and independent auto-committed
/// changes on an engine without transaction support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeGroupState {
    /// Every change applied; a transaction, when used, committed.
    Applied,
    /// A change conflicted; the group was rolled back where supported.
    Conflict,
    /// A change failed; the group was rolled back where supported.
    Failed,
    /// A write outcome could not be confirmed. Not rolled back or retried.
    OutcomeUnknown,
    /// Applied one at a time because the engine has no transaction support.
    AutoCommit,
}

/// Result of applying one or more staged changes as a group.
///
/// `results` preserves each change's terminal outcome even after a failed or
/// conflicted apply, so callers can keep pending edits inspectable instead of
/// discarding them. `grouped` reports whether a transaction wrapped the batch;
/// `state` and `error` explain the batch-level outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeGroupResult {
    /// Per-change outcomes, in request order.
    pub results: Vec<ChangeResult>,
    /// Whether the changes were wrapped in an explicit transaction.
    pub grouped: bool,
    /// Batch-level outcome.
    pub state: ChangeGroupState,
    /// Transaction used for the group, when one was opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<TransactionId>,
    /// Rollback or commit error, when the group ended abnormally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
}

/// Validates a staged change request before any engine call.
///
/// Views are read-only, so a change must target a base table. The change itself
/// is checked structurally; whether the row can be targeted safely is the
/// adapter's check against the table's primary key.
pub fn validate_change_request(request: &ChangeRequest) -> Result<(), QueryError> {
    if request.object.kind != ObjectKind::Table {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            format!(
                "`{}` is not a base table and cannot be modified",
                request.object.name
            ),
        ));
    }
    validate_pending_change(&request.change)
}

/// Applies one staged insert/update/delete through the adapter.
///
/// The application rejects a malformed request before it reaches the adapter, so
/// an obviously unsafe write never opens a transaction or touches the engine.
/// The adapter remains responsible for validating column identifiers, enforcing
/// the primary-key row identity, and reporting a stale-row conflict.
pub async fn apply_change(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    request: ChangeRequest,
) -> Result<ChangeResult, QueryError> {
    validate_change_request(&request)?;
    adapter.apply_change(connection, request).await
}

/// Applies a batch of staged changes, grouping them in a transaction when the
/// engine supports one.
///
/// All requests are validated before the first change runs, so a malformed
/// change cannot leave a partially applied batch. When the engine reports
/// transaction support the batch is wrapped in one transaction and committed
/// only if every change applies; a conflict or failure triggers a rollback so
/// no part of the batch is left committed. An unconfirmed write outcome is never
/// rolled back automatically or retried. Engines without transaction support
/// apply each change independently and report [`ChangeGroupState::AutoCommit`].
pub async fn apply_changes(
    adapter: &dyn DatabaseAdapter,
    connection: &ConnectionId,
    requests: Vec<ChangeRequest>,
) -> Result<ChangeGroupResult, QueryError> {
    for request in &requests {
        validate_change_request(request)?;
    }

    if requests.is_empty() {
        return Ok(ChangeGroupResult {
            results: Vec::new(),
            grouped: false,
            state: ChangeGroupState::Applied,
            transaction: None,
            error: None,
        });
    }

    let supports_transactions = adapter.capabilities().transactions;
    if !supports_transactions || requests.len() == 1 {
        let mut results = Vec::with_capacity(requests.len());
        for request in requests {
            results.push(adapter.apply_change(connection, request).await?);
        }
        let mut state = aggregate_state(&results);
        if !supports_transactions && state == ChangeGroupState::Applied {
            state = ChangeGroupState::AutoCommit;
        }
        return Ok(ChangeGroupResult {
            results,
            grouped: false,
            state,
            transaction: None,
            error: None,
        });
    }

    let transaction = adapter.begin_transaction(connection).await?;
    let mut results = Vec::with_capacity(requests.len());

    for request in requests {
        let result = match adapter.apply_change(connection, request).await {
            Ok(result) => result,
            Err(error) => {
                // A precondition failure (for example, a row the adapter
                // cannot target safely) means this change was never attempted.
                // Roll the transaction back so an earlier change in the batch
                // is never left pending, then surface the precondition error.
                let _ = adapter.rollback(connection, &transaction).await;
                return Err(error);
            }
        };
        let applied = result.outcome.is_applied();
        results.push(result);

        if applied {
            continue;
        }

        let last = results
            .last()
            .expect("a non-applied result was just pushed")
            .outcome;
        if last == ChangeOutcome::OutcomeUnknown {
            // The write may or may not have committed. A rollback cannot be
            // promised either, so leave the transaction alone and report it.
            return Ok(ChangeGroupResult {
                results,
                grouped: true,
                state: ChangeGroupState::OutcomeUnknown,
                transaction: Some(transaction),
                error: None,
            });
        }

        let state = if last == ChangeOutcome::Conflict {
            ChangeGroupState::Conflict
        } else {
            ChangeGroupState::Failed
        };
        let error = adapter.rollback(connection, &transaction).await.err();
        return Ok(ChangeGroupResult {
            results,
            grouped: true,
            state,
            transaction: Some(transaction),
            error,
        });
    }

    match adapter.commit(connection, &transaction).await {
        Ok(()) => Ok(ChangeGroupResult {
            results,
            grouped: true,
            state: ChangeGroupState::Applied,
            transaction: Some(transaction),
            error: None,
        }),
        Err(error) => {
            let state = if error.category.may_have_unknown_outcome() {
                ChangeGroupState::OutcomeUnknown
            } else {
                ChangeGroupState::Failed
            };
            Ok(ChangeGroupResult {
                results,
                grouped: true,
                state,
                transaction: Some(transaction),
                error: Some(error),
            })
        }
    }
}

/// Aggregate outcome of independently applied changes.
fn aggregate_state(results: &[ChangeResult]) -> ChangeGroupState {
    if results
        .iter()
        .any(|result| result.outcome == ChangeOutcome::OutcomeUnknown)
    {
        ChangeGroupState::OutcomeUnknown
    } else if results
        .iter()
        .any(|result| result.outcome == ChangeOutcome::Failed)
    {
        ChangeGroupState::Failed
    } else if results
        .iter()
        .any(|result| result.outcome == ChangeOutcome::Conflict)
    {
        ChangeGroupState::Conflict
    } else {
        ChangeGroupState::Applied
    }
}

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
        apply_change, apply_changes, fetch_table_page, resolve_page_limit, validate_change_request,
        ChangeGroupState, DEFAULT_TABLE_PAGE_ROWS, HARD_MAX_TABLE_PAGE_ROWS,
    };
    use crate::database::testing::FakeAdapter;
    use crate::database::{
        ChangeOutcome, ChangeRequest, ConnectionId, DatabaseAdapter, FilterOperator, ObjectKind,
        ObjectRef, PendingChange, RowIdentity, RowKey, TableFilter, TablePageRequest,
    };
    use crate::domain::connection::SqliteConnection;
    use crate::domain::{
        CellValue, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory,
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

    fn view_object() -> ObjectRef {
        ObjectRef {
            database: None,
            schema: None,
            name: "active_users".to_string(),
            kind: ObjectKind::View,
        }
    }

    #[test]
    fn validate_change_request_rejects_views_and_unsafe_shapes() {
        let view_request = ChangeRequest::new(
            "chg-view",
            view_object(),
            PendingChange::insert(vec![RowKey::new("id", CellValue::Integer(1))]),
        );
        assert_eq!(
            validate_change_request(&view_request)
                .expect_err("a view is read-only")
                .category,
            ErrorCategory::Validation
        );

        let no_key = ChangeRequest::new(
            "chg-no-key",
            users_object(),
            PendingChange::delete(RowIdentity::new(Vec::new(), Vec::new())),
        );
        assert_eq!(
            validate_change_request(&no_key)
                .expect_err("a delete without a key is unsafe")
                .category,
            ErrorCategory::Validation
        );

        let valid = ChangeRequest::new(
            "chg-ok",
            users_object(),
            PendingChange::update(
                RowIdentity::key("id", CellValue::Integer(1)),
                vec![RowKey::new("name", CellValue::Text("bob".to_string()))],
            ),
        );
        assert!(validate_change_request(&valid).is_ok());
    }

    #[test]
    fn apply_change_applies_a_guarded_insert_and_reports_a_stale_conflict() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let insert = ChangeRequest::new(
            "chg-insert",
            users_object(),
            PendingChange::insert(vec![
                RowKey::new("id", CellValue::Integer(99)),
                RowKey::new("name", CellValue::Text("mallory".to_string())),
            ]),
        );
        let result = block_on(apply_change(&adapter, &connection, insert)).expect("insert applies");
        assert_eq!(result.outcome, ChangeOutcome::Applied);
        assert_eq!(result.affected_rows, Some(1));

        // The original value no longer matches row 1, so the update must
        // conflict rather than overwrite it.
        let stale = ChangeRequest::new(
            "chg-stale",
            users_object(),
            PendingChange::update(
                RowIdentity::new(
                    vec![RowKey::new("id", CellValue::Integer(1))],
                    vec![RowKey::new("name", CellValue::Text("not-alice".to_string()))],
                ),
                vec![RowKey::new("name", CellValue::Text("bob".to_string()))],
            ),
        );
        let result =
            block_on(apply_change(&adapter, &connection, stale)).expect("executed change returns a result");
        assert_eq!(result.outcome, ChangeOutcome::Conflict);
        assert_eq!(result.conflicted_columns, ["name"]);
    }

    #[test]
    fn apply_change_rejects_a_table_without_a_safe_row_identity() {
        let adapter = FakeAdapter::new(EngineId::Sqlite).without_primary_key();
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let update = ChangeRequest::new(
            "chg-no-pk",
            users_object(),
            PendingChange::update(
                RowIdentity::key("id", CellValue::Integer(1)),
                vec![RowKey::new("name", CellValue::Text("bob".to_string()))],
            ),
        );
        let error =
            block_on(apply_change(&adapter, &connection, update)).expect_err("no safe identity");
        assert_eq!(error.category, ErrorCategory::Unsupported);
    }

    #[test]
    fn apply_changes_groups_in_a_transaction_and_commits_a_clean_batch() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let requests = vec![
            ChangeRequest::new(
                "grp-1",
                users_object(),
                PendingChange::insert(vec![
                    RowKey::new("id", CellValue::Integer(101)),
                    RowKey::new("name", CellValue::Text("dana".to_string())),
                ]),
            ),
            ChangeRequest::new(
                "grp-2",
                users_object(),
                PendingChange::insert(vec![
                    RowKey::new("id", CellValue::Integer(102)),
                    RowKey::new("name", CellValue::Text("erin".to_string())),
                ]),
            ),
        ];

        let group = block_on(apply_changes(&adapter, &connection, requests)).expect("group applies");
        assert!(group.grouped);
        assert_eq!(group.state, ChangeGroupState::Applied);
        assert_eq!(group.results.len(), 2);
        assert_eq!(adapter.begin_transaction_call_count(), 1);
        assert_eq!(adapter.commit_call_count(), 1);
        assert_eq!(adapter.rollback_call_count(), 0);
        assert!(group.transaction.is_some());
    }

    #[test]
    fn apply_changes_rolls_back_a_conflicted_batch_and_keeps_the_outcome() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let requests = vec![
            ChangeRequest::new(
                "grp-ok",
                users_object(),
                PendingChange::insert(vec![
                    RowKey::new("id", CellValue::Integer(103)),
                    RowKey::new("name", CellValue::Text("frank".to_string())),
                ]),
            ),
            ChangeRequest::new(
                "grp-conflict",
                users_object(),
                PendingChange::update(
                    RowIdentity::new(
                        vec![RowKey::new("id", CellValue::Integer(1))],
                        vec![RowKey::new("name", CellValue::Text("stale".to_string()))],
                    ),
                    vec![RowKey::new("name", CellValue::Text("changed".to_string()))],
                ),
            ),
        ];

        let group =
            block_on(apply_changes(&adapter, &connection, requests)).expect("group runs");
        assert!(group.grouped);
        assert_eq!(group.state, ChangeGroupState::Conflict);
        assert_eq!(group.results.len(), 2);
        assert_eq!(group.results[0].outcome, ChangeOutcome::Applied);
        assert_eq!(group.results[1].outcome, ChangeOutcome::Conflict);
        assert_eq!(adapter.commit_call_count(), 0);
        assert_eq!(adapter.rollback_call_count(), 1);
    }

    #[test]
    fn apply_changes_never_rolls_back_or_retries_an_uncertain_write() {
        let adapter = FakeAdapter::new(EngineId::Sqlite).with_uncertain_write();
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let requests = vec![
            ChangeRequest::new(
                "grp-uncertain",
                users_object(),
                PendingChange::delete(RowIdentity::key("id", CellValue::Integer(1))),
            ),
            ChangeRequest::new(
                "grp-uncertain-2",
                users_object(),
                PendingChange::delete(RowIdentity::key("id", CellValue::Integer(2))),
            ),
        ];

        let group =
            block_on(apply_changes(&adapter, &connection, requests)).expect("group runs");
        assert!(group.grouped);
        assert_eq!(group.state, ChangeGroupState::OutcomeUnknown);
        assert_eq!(adapter.rollback_call_count(), 0);
        assert_eq!(adapter.commit_call_count(), 0);
        assert_eq!(group.results.len(), 1);
        assert_eq!(group.results[0].outcome, ChangeOutcome::OutcomeUnknown);
    }

    #[test]
    fn apply_changes_auto_commits_on_an_engine_without_transactions() {
        let adapter = FakeAdapter::new(EngineId::Sqlite)
            .with_capabilities(EngineCapabilities::default());
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let requests = vec![
            ChangeRequest::new(
                "auto-1",
                users_object(),
                PendingChange::insert(vec![
                    RowKey::new("id", CellValue::Integer(201)),
                    RowKey::new("name", CellValue::Text("gina".to_string())),
                ]),
            ),
            ChangeRequest::new(
                "auto-2",
                users_object(),
                PendingChange::insert(vec![
                    RowKey::new("id", CellValue::Integer(202)),
                    RowKey::new("name", CellValue::Text("hank".to_string())),
                ]),
            ),
        ];

        let group =
            block_on(apply_changes(&adapter, &connection, requests)).expect("group runs");
        assert!(!group.grouped);
        assert_eq!(group.state, ChangeGroupState::AutoCommit);
        assert_eq!(adapter.begin_transaction_call_count(), 0);
        assert_eq!(adapter.commit_call_count(), 0);
    }

    #[test]
    fn apply_changes_rolls_back_when_a_change_cannot_be_attempted() {
        let adapter = FakeAdapter::new(EngineId::Sqlite).without_primary_key();
        let connection =
            block_on(adapter.connect(&sqlite_descriptor(), None)).expect("fake connect");

        let requests = vec![
            ChangeRequest::new(
                "grp-insert",
                users_object(),
                PendingChange::insert(vec![
                    RowKey::new("id", CellValue::Integer(301)),
                    RowKey::new("name", CellValue::Text("ivar".to_string())),
                ]),
            ),
            ChangeRequest::new(
                "grp-unsafe",
                users_object(),
                PendingChange::update(
                    RowIdentity::key("id", CellValue::Integer(1)),
                    vec![RowKey::new("name", CellValue::Text("nope".to_string()))],
                ),
            ),
        ];

        let error = block_on(apply_changes(&adapter, &connection, requests))
            .expect_err("a change that cannot target a row must fail the batch");
        assert_eq!(error.category, ErrorCategory::Unsupported);
        assert_eq!(
            adapter.begin_transaction_call_count(),
            1,
            "the batch still opened one transaction"
        );
        assert_eq!(
            adapter.commit_call_count(),
            0,
            "an unapplicable change must not commit the batch"
        );
        assert_eq!(
            adapter.rollback_call_count(),
            1,
            "the open transaction must be rolled back, not left dangling"
        );
    }
}
