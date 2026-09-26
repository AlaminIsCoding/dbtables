# Adapter contract tests

`adapter_contract.rs` runs one shared contract against every configured engine so
SQLite, MySQL, and PostgreSQL cannot drift into three different behaviors. The
reusable harness lives in `contract/mod.rs`; adding an engine means building one
`EngineTarget` and calling `run_contract`, not copying the expectations.

## Running

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

- **SQLite** always runs against a temporary fixture database created by the test.
- **MySQL** runs when `DBTABLES_MYSQL_TEST_HOST` is set.
- **PostgreSQL** runs when `DBTABLES_POSTGRES_TEST_HOST` is set.

Tests for unconfigured server engines return early, so the default run needs no
server and no credential. When a server is configured, the test result reflects
the contract check against that live engine.

## Configuring a disposable server

Only ever point these tests at a disposable test database. The variables mirror
the adapters' own integration tests:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DBTABLES_MYSQL_TEST_HOST` | to enable MySQL | — | Setting it enables the MySQL contract test. |
| `DBTABLES_MYSQL_TEST_PORT` | no | `3306` | |
| `DBTABLES_MYSQL_TEST_DATABASE` | no | session default | Metadata is read from this database. Prefer setting it. |
| `DBTABLES_MYSQL_TEST_USER` | no | `root` | |
| `DBTABLES_MYSQL_TEST_PASSWORD` | no | none | Read from the environment only; never printed. |
| `DBTABLES_MYSQL_TEST_TLS` | no | disabled | `preferred`, `required`, `verify_ca`, or `verify_full`. |
| `DBTABLES_POSTGRES_TEST_HOST` | to enable PostgreSQL | — | Setting it enables the PostgreSQL contract test. |
| `DBTABLES_POSTGRES_TEST_PORT` | no | `5432` | |
| `DBTABLES_POSTGRES_TEST_DATABASE` | no | driver default | |
| `DBTABLES_POSTGRES_TEST_USER` | no | `postgres` | |
| `DBTABLES_POSTGRES_TEST_PASSWORD` | no | none | Read from the environment only; never printed. |
| `DBTABLES_POSTGRES_TEST_TLS` | no | disabled | `preferred`, `required`, `verify_ca`, or `verify_full`. |

No password is written to a file, echoed in test output, or included in an
assertion message. Do not commit a `.env` file containing credentials; the
repository ignores `.env` but the environment should be set per shell session.

## Shared expectations

Every configured engine must satisfy all of these through the `DatabaseAdapter`
boundary (the SQLite fixture makes `contract_users` available for the metadata
check):

1. **Connect** — `test_connection` reports the target engine and `connect`
   returns a handle whose state is `connected`.
2. **Metadata** — `list_scopes` either reports the engine's scopes or returns an
   explicit `Unsupported` error; `list_objects` succeeds, the controlled SQLite
   table is present, and any listed object can be described with at least one
   column.
3. **SELECT** — `SELECT 1 AS one` returns `succeeded`, echoes the operation id,
   reports one column named `one`, one row whose value normalizes to numeric `1`,
   a duration, and `truncated = false`.
4. **DML-result metadata** — a write statement returns a normalized, terminal
   result, is never reported as success by a read-only adapter, never fabricates
   `affected_rows`, and carries a categorized normalized error and a duration.
5. **Invalid query** — `SELECT FROM WHERE` returns `failed` with a `syntax`
   category rather than an `Err` or a silent success.
6. **Disconnect** — `disconnect` succeeds and the handle then reports
   `disconnected`.

A separate test pins the positive DML result shape (`succeeded` with
`affected_rows = Some(1)` and a duration) through the deterministic `FakeAdapter`,
which models a writable engine.

## Capability differences (documented, not hidden)

The shipped adapters implement the read-only slice, so transaction, cancellation,
and staged-change flags are `false` even where the engine supports them later.
The differences the contract asserts today:

| Behavior | SQLite | MySQL | PostgreSQL |
|---|---|---|---|
| `list_scopes` | `Unsupported` error (no scopes) | databases/catalogs | schemas |
| Object scope | none | `database` (catalog) | `schema` |
| Multiple databases on one connection | no | yes | no (connection bound to one database) |
| Schema namespace separate from database | no | no (`schemas = false`) | yes (`schemas = true`) |
| TLS-capable driver configuration | no | yes | yes |
| `execute` on DML (read-only slice) | `permission` failure | `permission`/`validation` failure | `permission`/`validation` failure |

`EngineId::capabilities()` in `src-tauri/src/domain/capabilities.rs` records the
long-term per-engine intent; `read_only_slice_capabilities_are_explicit` in
`adapter_contract.rs` pins what the adapters actually honor in this slice. Any
change to those sets is a deliberate contract change and should be reviewed
against this document.

## Manual verification

Automated coverage cannot prove a real server connects in a user's environment.
The spec's manual gate remains with the user: connect to disposable MySQL and
PostgreSQL databases, run a query, inspect table metadata, and test bad
credentials and TLS configuration if available. Connection details stay local
and must not be reported back to the agent.