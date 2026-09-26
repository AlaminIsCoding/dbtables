//! Representative large-result performance and bounded-fetching coverage.
//!
//! These tests exercise the real `SqliteAdapter` and the application query
//! policy against a fixture larger than the hard row ceiling, so the bounded
//! result flow is measured end to end rather than only through the small unit
//! fixtures. They assert the deterministic *bound* (row counts and termination)
//! instead of a wall-clock budget: on shared or slow machines a timing
//! assertion would be flaky, while the cap is the property that keeps the UI
//! and process memory responsive. Each test prints a one-line profile of the
//! rows and duration observed so a run records the measurement.
//!
//! Run with `cargo test --manifest-path src-tauri/Cargo.toml`. The fixture is a
//! temporary SQLite file removed when the test ends; no server or credential is
//! required.
//!
//! See `README.md` ("Performance and bounded results") for the policy the
//! assertions pin.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use dbtables_lib::application::queries::{
    can_fetch_more, execute_query, next_fetch_rows, DEFAULT_MAX_ROWS, FETCH_MORE_STEP,
    HARD_MAX_ROWS,
};
use dbtables_lib::database::{DatabaseAdapter, SqliteAdapter};
use dbtables_lib::domain::{ConnectionDescriptor, OperationState, QueryRequest, SqliteConnection};

/// Rows in the representative large fixture.
///
/// It must exceed [`HARD_MAX_ROWS`] so the bounded flow is exercised from the
/// first page all the way to its hard ceiling and is never accidentally
/// complete.
const LARGE_ROW_COUNT: i64 = HARD_MAX_ROWS as i64 + 2_000;

/// SQL projection for the large fixture, ordered so paging is deterministic.
const LARGE_SELECT: &str = "SELECT id, payload FROM perf_events ORDER BY id";

/// A temporary SQLite database holding a table larger than the hard row cap.
struct LargeSqliteFixture {
    path: PathBuf,
}

impl LargeSqliteFixture {
    fn create() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = format!(
            "dbtables-performance-{}-{}.sqlite",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(unique);
        // Start from a clean path so a leftover file cannot change the fixture.
        let _ = std::fs::remove_file(&path);

        let mut connection =
            rusqlite::Connection::open(&path).expect("performance fixture should open");
        connection
            .execute_batch(
                "CREATE TABLE perf_events (\
                     id INTEGER PRIMARY KEY NOT NULL, \
                     payload TEXT NOT NULL\
                 );",
            )
            .expect("performance fixture schema should apply");

        {
            let transaction = connection
                .transaction()
                .expect("performance fixture transaction should open");
            {
                let mut insert = transaction
                    .prepare("INSERT INTO perf_events (id, payload) VALUES (?1, ?2)")
                    .expect("performance fixture insert should prepare");
                for id in 1..=LARGE_ROW_COUNT {
                    insert
                        .execute(rusqlite::params![id, format!("payload-{id}")])
                        .expect("performance fixture row should insert");
                }
            }
            transaction
                .commit()
                .expect("performance fixture transaction should commit");
        }
        drop(connection);

        Self { path }
    }

    fn descriptor(&self) -> ConnectionDescriptor {
        ConnectionDescriptor::Sqlite(SqliteConnection {
            file_path: self.path.to_string_lossy().into_owned(),
        })
    }
}

impl Drop for LargeSqliteFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Builds the runtime the application command layer uses for adapter futures.
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("performance test runtime should build")
}

/// Connects `adapter` to a fresh large fixture.
///
/// The caller owns the adapter: it holds the open connection handles, so it must
/// outlive every query against the returned id.
fn connect(
    runtime: &tokio::runtime::Runtime,
    adapter: &SqliteAdapter,
    fixture: &LargeSqliteFixture,
) -> dbtables_lib::database::ConnectionId {
    runtime
        .block_on(adapter.connect(&fixture.descriptor(), None))
        .expect("the performance fixture should connect")
}

/// The default cap bounds a single large result before any fetch-more.
#[test]
fn a_large_result_is_capped_at_the_default_bound() {
    let fixture = LargeSqliteFixture::create();
    let adapter = SqliteAdapter::new();
    let runtime = runtime();
    let connection = connect(&runtime, &adapter, &fixture);

    let result = runtime
        .block_on(execute_query(
            &adapter,
            &connection,
            QueryRequest::new("perf-default", LARGE_SELECT),
        ))
        .expect("a large SELECT should produce a normalized result");

    assert_eq!(
        result.state,
        OperationState::Succeeded,
        "a valid large SELECT must succeed",
    );
    assert_eq!(
        result.columns.len(),
        2,
        "both selected columns must be reported"
    );
    assert_eq!(
        result.rows.len(),
        DEFAULT_MAX_ROWS as usize,
        "one execution must return exactly the default cap, not the whole table",
    );
    assert!(
        result.truncated,
        "a capped large result must be marked truncated",
    );
    assert!(
        result.duration_ms.is_some(),
        "a completed large result must report a duration",
    );

    // The returned window is the first `DEFAULT_MAX_ROWS` ordered rows.
    assert_eq!(
        result.rows.first().and_then(|row| row.first()),
        Some(&dbtables_lib::domain::CellValue::Integer(1)),
        "the bounded window must start at the first ordered row",
    );
    assert_eq!(
        result.rows.last().and_then(|row| row.first()),
        Some(&dbtables_lib::domain::CellValue::Integer(
            DEFAULT_MAX_ROWS as i64
        )),
        "the bounded window must stop at the requested cap",
    );

    eprintln!(
        "profile: default-capped large result returned {} of {} rows in {:?} ms",
        result.rows.len(),
        LARGE_ROW_COUNT,
        result.duration_ms,
    );
}

/// Fetch-more grows in bounded steps and terminates at the hard ceiling.
#[test]
fn fetch_more_grows_in_bounded_steps_and_stops_at_the_hard_ceiling() {
    let fixture = LargeSqliteFixture::create();
    let adapter = SqliteAdapter::new();
    let runtime = runtime();
    let connection = connect(&runtime, &adapter, &fixture);

    let max_fetches = HARD_MAX_ROWS / FETCH_MORE_STEP + 2;
    let mut requested = DEFAULT_MAX_ROWS;
    let mut fetches = 0u32;
    let mut profiled_duration_ms = 0u64;
    let mut last_window: usize;

    loop {
        let result = runtime
            .block_on(execute_query(
                &adapter,
                &connection,
                QueryRequest::new("perf-fetch", LARGE_SELECT).with_max_rows(requested),
            ))
            .expect("a bounded fetch should produce a normalized result");

        assert_eq!(result.state, OperationState::Succeeded);
        assert!(
            result.rows.len() <= requested as usize,
            "a fetch must never return more than it requested ({} > {requested})",
            result.rows.len(),
        );
        assert!(
            result.rows.len() <= HARD_MAX_ROWS as usize,
            "a single window must never exceed the hard ceiling",
        );

        last_window = result.rows.len();
        profiled_duration_ms += result.duration_ms.unwrap_or(0);
        fetches += 1;
        assert!(
            fetches <= max_fetches,
            "the bounded fetch flow must terminate; it ran {fetches} fetches",
        );

        let loaded = u32::try_from(result.rows.len()).expect("window fits in u32");
        match next_fetch_rows(loaded) {
            Some(next) => {
                assert_eq!(
                    next,
                    loaded.saturating_add(FETCH_MORE_STEP).min(HARD_MAX_ROWS),
                    "each fetch must grow by exactly one bounded step, clamped to the ceiling",
                );
                assert!(next <= HARD_MAX_ROWS);
                requested = next;
            }
            None => break,
        }
    }

    assert_eq!(
        requested, HARD_MAX_ROWS,
        "the flow must climb to the hard ceiling, not stop early",
    );
    assert_eq!(
        last_window, HARD_MAX_ROWS as usize,
        "the final window must deliver the full hard-capped result",
    );
    assert!(
        !can_fetch_more(HARD_MAX_ROWS),
        "the hard ceiling must end the fetch-more flow",
    );
    assert_eq!(
        next_fetch_rows(HARD_MAX_ROWS),
        None,
        "an at-ceiling result cannot be extended further",
    );
    assert!(
        LARGE_ROW_COUNT > HARD_MAX_ROWS as i64,
        "the fixture must outlast the ceiling to prove the flow is bounded",
    );

    eprintln!(
        "profile: {fetches} bounded fetches reached a {last_window}-row window \
         (fixture {LARGE_ROW_COUNT} rows) in {profiled_duration_ms} ms total",
    );
}

/// A caller that asks for more than the hard ceiling is still clamped.
#[test]
fn a_request_above_the_hard_ceiling_is_clamped() {
    let fixture = LargeSqliteFixture::create();
    let adapter = SqliteAdapter::new();
    let runtime = runtime();
    let connection = connect(&runtime, &adapter, &fixture);

    let result = runtime
        .block_on(execute_query(
            &adapter,
            &connection,
            QueryRequest::new("perf-over-cap", LARGE_SELECT)
                .with_max_rows(HARD_MAX_ROWS.saturating_mul(2)),
        ))
        .expect("an over-cap request should produce a normalized result");

    assert_eq!(result.state, OperationState::Succeeded);
    assert_eq!(
        result.rows.len(),
        HARD_MAX_ROWS as usize,
        "an over-cap request must be clamped to the hard ceiling",
    );
    assert!(
        result.truncated,
        "a clamped large result must be marked truncated",
    );
}
