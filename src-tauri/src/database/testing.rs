//! Deterministic in-memory adapter used by adapter contract tests.
//!
//! The fake never touches a real driver, network, or filesystem. Its behavior
//! is driven only by the engine, the arguments, and recognizable SQL clauses,
//! so contract tests are reproducible and run fully offline. Later specs can
//! run the same expectations against real adapters.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use crate::domain::{
    CellValue, ColumnInfo, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory,
    OperationId, QueryError, QueryRequest, QueryResult, Row,
};

use super::{
    validate_filter_values, AdapterFuture, CancelOutcome, ChangeRequest, ChangeResult,
    ConnectionId, ConnectionSecret, ConnectionState, ConnectionTest, ConstraintInfo, ConstraintKind,
    DatabaseAdapter, FilterOperator, IndexInfo, ObjectKind, ObjectRef, ObjectScope, PendingChange,
    RowIdentity, ScopeListing, SortDirection, TableDescription, TableFilter, TablePage,
    TablePageRequest, TransactionId,
};

/// Small deterministic table the fake exposes for paging and writes.
///
/// Modeling real rows lets contract tests prove that a filter selects the
/// expected values, that paging is bounded, and that a stale original value
/// yields a conflict instead of an overwrite.
struct FakeTable {
    columns: Vec<ColumnInfo>,
    primary_key: Vec<String>,
    rows: Vec<Row>,
    next_id: i64,
    indexes: Vec<IndexInfo>,
    constraints: Vec<ConstraintInfo>,
}

impl Default for FakeTable {
    fn default() -> Self {
        Self {
            columns: vec![
                ColumnInfo {
                    name: "id".to_string(),
                    type_name: Some("INTEGER".to_string()),
                    nullable: Some(false),
                },
                ColumnInfo {
                    name: "name".to_string(),
                    type_name: Some("TEXT".to_string()),
                    nullable: Some(true),
                },
            ],
            primary_key: vec!["id".to_string()],
            rows: vec![
                vec![CellValue::Integer(1), CellValue::Text("alice".to_string())],
                vec![CellValue::Integer(2), CellValue::Text("bob".to_string())],
                vec![CellValue::Integer(3), CellValue::Text("carol".to_string())],
            ],
            next_id: 4,
            indexes: vec![
                IndexInfo::new("users_pkey", vec!["id".to_string()], true, true),
                IndexInfo::new("users_name_idx", vec!["name".to_string()], false, false),
            ],
            constraints: vec![ConstraintInfo::primary_key(
                "users_pkey",
                vec!["id".to_string()],
            )],
        }
    }
}

/// Mutable bookkeeping owned by [`FakeAdapter`].
#[derive(Default)]
struct FakeState {
    next_connection: u64,
    connections: HashMap<ConnectionId, ConnectionState>,
    running_operations: HashSet<OperationId>,
    next_transaction: u64,
    open_transactions: HashSet<TransactionId>,
    execute_calls: usize,
    begin_transaction_calls: usize,
    commit_calls: usize,
    rollback_calls: usize,
    table: FakeTable,
    uncertain_writes: bool,
}

fn column_index(columns: &[ColumnInfo], name: &str) -> Option<usize> {
    columns.iter().position(|column| column.name == name)
}

fn numeric(value: &CellValue) -> Option<f64> {
    match value {
        CellValue::Integer(value) => Some(*value as f64),
        CellValue::Float(value) => Some(*value),
        CellValue::Decimal(value) => value.parse().ok(),
        _ => None,
    }
}

/// Deterministic comparison for the value types the fake table stores.
fn compare_values(left: &CellValue, right: &CellValue) -> Option<Ordering> {
    match (left, right) {
        (CellValue::Null, CellValue::Null) => Some(Ordering::Equal),
        (CellValue::Text(left), CellValue::Text(right)) => Some(left.cmp(right)),
        (CellValue::Boolean(left), CellValue::Boolean(right)) => Some(left.cmp(right)),
        (CellValue::Bytes(left), CellValue::Bytes(right)) => Some(left.cmp(right)),
        (left, right) => match (numeric(left), numeric(right)) {
            (Some(left), Some(right)) => left.partial_cmp(&right),
            _ => None,
        },
    }
}

fn values_equal(left: &CellValue, right: &CellValue) -> bool {
    compare_values(left, right) == Some(Ordering::Equal)
}

fn matches_filter(cell: &CellValue, filter: &TableFilter) -> bool {
    let first = filter.values.first();
    match filter.operator {
        FilterOperator::IsNull => matches!(cell, CellValue::Null),
        FilterOperator::IsNotNull => !matches!(cell, CellValue::Null),
        FilterOperator::Equal => first.is_some_and(|value| values_equal(cell, value)),
        FilterOperator::NotEqual => first.is_some_and(|value| !values_equal(cell, value)),
        FilterOperator::LessThan => first
            .and_then(|value| compare_values(cell, value))
            .is_some_and(|ordering| ordering == Ordering::Less),
        FilterOperator::LessThanOrEqual => first
            .and_then(|value| compare_values(cell, value))
            .is_some_and(|ordering| ordering != Ordering::Greater),
        FilterOperator::GreaterThan => first
            .and_then(|value| compare_values(cell, value))
            .is_some_and(|ordering| ordering == Ordering::Greater),
        FilterOperator::GreaterThanOrEqual => first
            .and_then(|value| compare_values(cell, value))
            .is_some_and(|ordering| ordering != Ordering::Less),
        FilterOperator::Like => match (cell, first) {
            (CellValue::Text(cell), Some(CellValue::Text(pattern))) => {
                cell.to_lowercase().contains(&pattern.to_lowercase())
            }
            _ => false,
        },
        FilterOperator::In => filter
            .values
            .iter()
            .any(|value| values_equal(cell, value)),
    }
}

fn validation_error(message: impl Into<String>) -> QueryError {
    QueryError::new(ErrorCategory::Validation, message)
}

/// Confirms a staged write targets the fake `users` base table.
///
/// The fake exposes `users` as its only writable relation; views such as
/// `active_users` and any other object are read-only and must be rejected
/// before a change is applied.
fn ensure_write_target(object: &ObjectRef) -> Result<(), QueryError> {
    if object.kind != ObjectKind::Table || object.name != "users" {
        return Err(validation_error(format!(
            "the fake adapter can only modify the `users` base table, not `{}`",
            object.name
        )));
    }
    Ok(())
}

/// Finds the row whose declared primary-key columns equal `row`'s values.
///
/// Returns `None` when the table declares no primary key. Used to reject a
/// duplicate insert without mutating any rows.
fn find_primary_key_row(table: &FakeTable, row: &Row) -> Option<usize> {
    if table.primary_key.is_empty() {
        return None;
    }
    table.rows.iter().position(|existing| {
        table.primary_key.iter().all(|name| {
            let Some(index) = column_index(&table.columns, name) else {
                return false;
            };
            let left = existing.get(index).unwrap_or(&CellValue::Null);
            let right = row.get(index).unwrap_or(&CellValue::Null);
            values_equal(left, right)
        })
    })
}

/// Where a staged update/delete points: at a live row, or at a conflict.
enum RowLocation {
    Found(usize),
    Conflict(Vec<String>),
}

/// Resolves a row identity against the fake table.
///
/// Returns `Unsupported` when the table has no safe identity, a validation
/// error when the identity does not name exactly the declared primary key, or
/// a conflict when the key no longer matches or an original value is stale.
fn locate_row(table: &FakeTable, identity: &RowIdentity) -> Result<RowLocation, QueryError> {
    if table.primary_key.is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Unsupported,
            "the table has no safe row identity for this change",
        ));
    }
    if identity.keys.is_empty() {
        return Err(validation_error(
            "a row identity requires at least one key column",
        ));
    }

    let mut seen = HashSet::new();
    for key in &identity.keys {
        if !seen.insert(key.column.as_str()) {
            return Err(validation_error(format!(
                "row identity lists column `{}` more than once",
                key.column
            )));
        }
    }

    for key in &identity.keys {
        if !table.primary_key.iter().any(|primary| primary == &key.column) {
            return Err(validation_error(format!(
                "row identity column `{}` is not part of the table's primary key",
                key.column
            )));
        }
    }

    for primary in &table.primary_key {
        if !identity.keys.iter().any(|key| &key.column == primary) {
            return Err(validation_error(format!(
                "row identity is missing primary-key column `{primary}`"
            )));
        }
    }

    let key_columns: Vec<String> = identity
        .keys
        .iter()
        .map(|key| key.column.clone())
        .collect();

    let found = table.rows.iter().position(|row| {
        identity.keys.iter().all(|key| {
            let index = column_index(&table.columns, &key.column)
                .expect("identity column validated before matching");
            row.get(index)
                .is_some_and(|cell| values_equal(cell, &key.value))
        })
    });

    let Some(index) = found else {
        return Ok(RowLocation::Conflict(key_columns));
    };

    let mut stale = Vec::new();
    for expected in &identity.original_values {
        let column = column_index(&table.columns, &expected.column).ok_or_else(|| {
            validation_error(format!(
                "unknown original-value column `{}`",
                expected.column
            ))
        })?;
        let current = table.rows[index].get(column).unwrap_or(&CellValue::Null);
        if !values_equal(current, &expected.value) {
            stale.push(expected.column.clone());
        }
    }

    if stale.is_empty() {
        Ok(RowLocation::Found(index))
    } else {
        Ok(RowLocation::Conflict(stale))
    }
}

/// Deterministic adapter used by contract tests and local development.
pub struct FakeAdapter {
    engine: EngineId,
    capabilities: EngineCapabilities,
    state: Mutex<FakeState>,
    connect_error: Mutex<Option<QueryError>>,
}

impl FakeAdapter {
    /// Creates a fake adapter for `engine` with that engine's default
    /// capabilities.
    pub fn new(engine: EngineId) -> Self {
        Self {
            engine,
            capabilities: engine.capabilities(),
            state: Mutex::new(FakeState::default()),
            connect_error: Mutex::new(None),
        }
    }

    /// Overrides reported capabilities, for exercising capability-gated paths.
    pub fn with_capabilities(mut self, capabilities: EngineCapabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// Makes every connect/test-connection attempt fail with `error`.
    pub fn with_connect_error(self, error: QueryError) -> Self {
        *self.connect_error.lock().expect("fake adapter state poisoned") = Some(error);
        self
    }

    /// Marks `operation` as currently running so cancellation can be observed.
    pub fn with_running_operation(self, operation: impl Into<OperationId>) -> Self {
        self.state()
            .running_operations
            .insert(operation.into());
        self
    }

    /// Removes the fake table's primary key, modeling a table that cannot be
    /// targeted safely for update/delete.
    pub fn without_primary_key(self) -> Self {
        {
            let mut state = self.state();
            state.table.primary_key.clear();
            state.table.indexes.retain(|index| !index.primary);
            state
                .table
                .constraints
                .retain(|constraint| constraint.kind != ConstraintKind::PrimaryKey);
        }
        self
    }

    /// Declares the fake table's primary key, modeling a composite identity.
    pub fn with_primary_key<I, S>(self, columns: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let primary_key: Vec<String> = columns.into_iter().map(Into::into).collect();
        {
            let mut state = self.state();
            state
                .table
                .constraints
                .retain(|constraint| constraint.kind != ConstraintKind::PrimaryKey);
            state.table.constraints.push(ConstraintInfo::primary_key(
                "users_pkey",
                primary_key.clone(),
            ));
            state.table.primary_key = primary_key;
        }
        self
    }

    /// Makes the next applied change report an uncertain outcome, modeling a
    /// transport failure during a write.
    pub fn with_uncertain_write(self) -> Self {
        self.state().uncertain_writes = true;
        self
    }

    /// Number of `execute` calls observed, used to prove no silent retries.
    pub fn execute_call_count(&self) -> usize {
        self.state().execute_calls
    }

    /// Number of `begin_transaction` calls observed by the fake.
    pub fn begin_transaction_call_count(&self) -> usize {
        self.state().begin_transaction_calls
    }

    /// Number of `commit` calls observed by the fake.
    pub fn commit_call_count(&self) -> usize {
        self.state().commit_calls
    }

    /// Number of `rollback` calls observed by the fake.
    pub fn rollback_call_count(&self) -> usize {
        self.state().rollback_calls
    }

    fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state.lock().expect("fake adapter state poisoned")
    }

    fn server_version(&self) -> &'static str {
        match self.engine {
            EngineId::Sqlite => "3.45.0",
            EngineId::MySql => "8.0.36",
            EngineId::Postgres => "16.2",
        }
    }

    fn check_connection(
        &self,
        descriptor: &ConnectionDescriptor,
        secret: Option<&ConnectionSecret>,
    ) -> Result<(), QueryError> {
        if let Some(error) = self
            .connect_error
            .lock()
            .expect("fake adapter state poisoned")
            .clone()
        {
            return Err(error);
        }

        if descriptor.engine() != self.engine {
            return Err(QueryError::new(
                ErrorCategory::Configuration,
                format!(
                    "{} adapter cannot serve {} connections",
                    self.engine,
                    descriptor.engine()
                ),
            ));
        }

        if descriptor.server().is_some() {
            match secret {
                None => {
                    return Err(QueryError::new(
                        ErrorCategory::Authentication,
                        "a username and password are required",
                    ));
                }
                Some(secret) if secret.is_empty() => {
                    return Err(QueryError::new(
                        ErrorCategory::Authentication,
                        "the password must not be empty",
                    ));
                }
                Some(secret) if secret.expose() == "bad" => {
                    return Err(QueryError::new(
                        ErrorCategory::Authentication,
                        "the supplied credentials were rejected",
                    )
                    .with_code("28P01"));
                }
                Some(_) => {}
            }
        }

        Ok(())
    }

    fn unknown_connection(connection: &ConnectionId) -> QueryError {
        QueryError::new(
            ErrorCategory::Connection,
            format!("connection `{connection}` is not open"),
        )
    }
}

impl DatabaseAdapter for FakeAdapter {
    fn engine(&self) -> EngineId {
        self.engine
    }

    fn capabilities(&self) -> EngineCapabilities {
        self.capabilities
    }

    fn test_connection<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionTest, QueryError>> {
        Box::pin(async move {
            self.check_connection(descriptor, secret)?;
            Ok(ConnectionTest {
                engine: self.engine,
                server_version: Some(self.server_version().to_string()),
            })
        })
    }

    fn connect<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionId, QueryError>> {
        Box::pin(async move {
            self.check_connection(descriptor, secret)?;

            let mut state = self.state();
            state.next_connection += 1;
            let id = ConnectionId::new(format!("{}-conn-{}", self.engine, state.next_connection));
            state.connections.insert(id.clone(), ConnectionState::Connected);
            Ok(id)
        })
    }

    fn disconnect<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            let mut state = self.state();
            match state.connections.get_mut(connection) {
                Some(slot) => {
                    *slot = ConnectionState::Disconnected;
                    Ok(())
                }
                None => Err(Self::unknown_connection(connection)),
            }
        })
    }

    fn connection_state<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ConnectionState, QueryError>> {
        Box::pin(async move {
            self.state()
                .connections
                .get(connection)
                .copied()
                .ok_or_else(|| Self::unknown_connection(connection))
        })
    }

    fn list_objects<'a>(
        &'a self,
        connection: &'a ConnectionId,
        scope: &'a ObjectScope,
    ) -> AdapterFuture<'a, Result<Vec<ObjectRef>, QueryError>> {
        Box::pin(async move {
            if !self.state().connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }

            let schema = match self.engine {
                EngineId::Postgres => {
                    Some(scope.schema.clone().unwrap_or_else(|| "public".to_string()))
                }
                _ => scope.schema.clone(),
            };
            let database = scope.database.clone();

            Ok(vec![
                ObjectRef {
                    database: database.clone(),
                    schema: schema.clone(),
                    name: "users".to_string(),
                    kind: ObjectKind::Table,
                },
                ObjectRef {
                    database,
                    schema,
                    name: "active_users".to_string(),
                    kind: ObjectKind::View,
                },
            ])
        })
    }

    fn list_scopes<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ScopeListing, QueryError>> {
        Box::pin(async move {
            if !self.state().connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }

            let listing = ScopeListing {
                databases: if self.capabilities.multiple_databases {
                    vec!["app".to_string()]
                } else {
                    Vec::new()
                },
                schemas: if self.capabilities.schemas {
                    vec!["public".to_string()]
                } else {
                    Vec::new()
                },
            };

            if listing.databases.is_empty() && listing.schemas.is_empty() {
                return Err(QueryError::new(
                    ErrorCategory::Unsupported,
                    "this engine does not expose database or schema scopes",
                ));
            }

            Ok(listing)
        })
    }

    fn describe_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        _object: &'a ObjectRef,
    ) -> AdapterFuture<'a, Result<TableDescription, QueryError>> {
        Box::pin(async move {
            if !self.state().connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }

            let table = &self.state().table;
            Ok(
                TableDescription::new(table.columns.clone(), table.primary_key.clone())
                    .with_indexes(table.indexes.clone())
                    .with_constraints(table.constraints.clone()),
            )
        })
    }

    fn fetch_table_page<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: TablePageRequest,
    ) -> AdapterFuture<'a, Result<TablePage, QueryError>> {
        Box::pin(async move {
            let state = self.state();
            if !state.connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }
            if request.limit == 0 {
                return Err(validation_error(
                    "a table page limit must be greater than zero",
                ));
            }

            let table = &state.table;
            let mut rows = table.rows.clone();

            for filter in &request.filters {
                if column_index(&table.columns, &filter.column).is_none() {
                    return Err(validation_error(format!(
                        "unknown filter column `{}`",
                        filter.column
                    )));
                }
                validate_filter_values(filter)?;
            }
            for key in &request.sort {
                if column_index(&table.columns, &key.column).is_none() {
                    return Err(validation_error(format!(
                        "unknown sort column `{}`",
                        key.column
                    )));
                }
            }

            rows.retain(|row| {
                request.filters.iter().all(|filter| {
                    let index = column_index(&table.columns, &filter.column)
                        .expect("filter column validated before matching");
                    let cell = row.get(index).unwrap_or(&CellValue::Null);
                    matches_filter(cell, filter)
                })
            });

            if !request.sort.is_empty() {
                rows.sort_by(|left, right| {
                    for key in &request.sort {
                        let index = column_index(&table.columns, &key.column)
                            .expect("sort column validated before sorting");
                        let left = left.get(index).unwrap_or(&CellValue::Null);
                        let mut ordering = compare_values(left, right.get(index).unwrap_or(&CellValue::Null))
                            .unwrap_or(Ordering::Equal);
                        if key.direction == SortDirection::Descending {
                            ordering = ordering.reverse();
                        }
                        if ordering != Ordering::Equal {
                            return ordering;
                        }
                    }
                    Ordering::Equal
                });
            }

            let total = rows.len() as u64;
            let offset = request.offset.min(total) as usize;
            let limit = request.limit as usize;
            let page_rows: Vec<Row> = rows
                .into_iter()
                .skip(offset)
                .take(limit)
                .collect();
            let next_offset = offset as u64 + page_rows.len() as u64;
            let truncated = next_offset < total;

            Ok(TablePage {
                operation_id: request.operation_id,
                columns: table.columns.clone(),
                rows: page_rows,
                row_identity: table.primary_key.clone(),
                offset: request.offset,
                limit: request.limit,
                total_rows: Some(total),
                truncated,
                next_offset: if truncated {
                    Some(next_offset)
                } else {
                    None
                },
            })
        })
    }

    fn execute<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: QueryRequest,
    ) -> AdapterFuture<'a, Result<QueryResult, QueryError>> {
        Box::pin(async move {
            {
                let mut state = self.state();
                state.execute_calls += 1;
                if !state.connections.contains_key(connection) {
                    return Err(Self::unknown_connection(connection));
                }
            }

            let operation_id = request.operation_id.clone();
            let sql = request.sql.trim();
            let upper = sql.to_ascii_uppercase();

            if upper.starts_with("SELECT") {
                let mut result = QueryResult::succeeded(operation_id);

                if upper.contains("WHERE 0") || upper.contains("EMPTY") {
                    result.columns = vec![ColumnInfo::named("id")];
                    return Ok(result);
                }

                let rows: Vec<Row> = vec![
                    vec![CellValue::Integer(1), CellValue::Text("alice".to_string())],
                    vec![CellValue::Integer(2), CellValue::Text("bob".to_string())],
                ];
                let cap = request.max_rows.map(|max| max as usize);
                let truncated = cap.is_some_and(|max| max < rows.len());
                let rows = match cap {
                    Some(max) => rows.into_iter().take(max).collect(),
                    None => rows,
                };

                result.columns = vec![
                    ColumnInfo {
                        name: "id".to_string(),
                        type_name: Some("INTEGER".to_string()),
                        nullable: Some(false),
                    },
                    ColumnInfo {
                        name: "name".to_string(),
                        type_name: Some("TEXT".to_string()),
                        nullable: Some(true),
                    },
                ];
                result.rows = rows;
                result.duration_ms = Some(1);
                result.truncated = truncated;
                return Ok(result);
            }

            if upper.starts_with("INSERT") || upper.starts_with("UPDATE") || upper.starts_with("DELETE")
            {
                if upper.contains("CONSTRAINT") {
                    return Ok(QueryResult::failed(
                        operation_id,
                        QueryError::new(
                            ErrorCategory::Constraint,
                            "a unique or foreign-key constraint was violated",
                        )
                        .with_code("23505"),
                    ));
                }
                if upper.contains("LOCK") {
                    return Ok(QueryResult::failed(
                        operation_id,
                        QueryError::new(
                            ErrorCategory::Locking,
                            "the row is locked by another transaction",
                        ),
                    ));
                }
                if upper.contains("TRANSPORT") || upper.contains("DISCONNECT") {
                    let mut result = QueryResult::outcome_unknown(operation_id);
                    result.error = Some(QueryError::new(
                        ErrorCategory::Transport,
                        "the connection was lost before commit status could be confirmed",
                    ));
                    return Ok(result);
                }

                let mut result = QueryResult::succeeded(operation_id);
                result.affected_rows = Some(1);
                result.duration_ms = Some(2);
                return Ok(result);
            }

            if upper.contains("SYNTAX") {
                return Ok(QueryResult::failed(
                    operation_id,
                    QueryError::new(ErrorCategory::Syntax, "near \"?\": syntax error"),
                ));
            }

            Ok(QueryResult::succeeded(operation_id))
        })
    }

    fn apply_change<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: ChangeRequest,
    ) -> AdapterFuture<'a, Result<ChangeResult, QueryError>> {
        Box::pin(async move {
            let mut state = self.state();
            if !state.connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }
            ensure_write_target(&request.object)?;
            if state.uncertain_writes {
                return Ok(ChangeResult::outcome_unknown(request.operation_id.clone()));
            }

            let table = &mut state.table;
            match request.change {
                PendingChange::Insert { values } => {
                    let mut row = vec![CellValue::Null; table.columns.len()];
                    for key in &values {
                        let column = column_index(&table.columns, &key.column).ok_or_else(|| {
                            validation_error(format!("unknown insert column `{}`", key.column))
                        })?;
                        row[column] = key.value.clone();
                    }
                    if let Some(primary) = table.primary_key.first().cloned() {
                        if let Some(column) = column_index(&table.columns, &primary) {
                            if matches!(row[column], CellValue::Null) {
                                loop {
                                    let candidate = CellValue::Integer(table.next_id);
                                    table.next_id += 1;
                                    let mut probe = row.clone();
                                    probe[column] = candidate.clone();
                                    if find_primary_key_row(table, &probe).is_none() {
                                        row[column] = candidate;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if find_primary_key_row(table, &row).is_some() {
                        return Ok(ChangeResult::failed(
                            request.operation_id.clone(),
                            QueryError::new(
                                ErrorCategory::Constraint,
                                "a row with the same primary key already exists in `users`",
                            )
                            .with_code("23505"),
                        ));
                    }
                    table.rows.push(row);
                    Ok(ChangeResult::applied(request.operation_id.clone(), 1))
                }
                PendingChange::Update { identity, values } => {
                    let index = match locate_row(table, &identity)? {
                        RowLocation::Found(index) => index,
                        RowLocation::Conflict(columns) => {
                            return Ok(ChangeResult::conflict(request.operation_id.clone(), columns));
                        }
                    };
                    for key in &values {
                        let column = column_index(&table.columns, &key.column).ok_or_else(|| {
                            validation_error(format!("unknown update column `{}`", key.column))
                        })?;
                        table.rows[index][column] = key.value.clone();
                    }
                    Ok(ChangeResult::applied(request.operation_id.clone(), 1))
                }
                PendingChange::Delete { identity } => match locate_row(table, &identity)? {
                    RowLocation::Found(index) => {
                        table.rows.remove(index);
                        Ok(ChangeResult::applied(request.operation_id.clone(), 1))
                    }
                    RowLocation::Conflict(columns) => {
                        Ok(ChangeResult::conflict(request.operation_id.clone(), columns))
                    }
                },
            }
        })
    }

    fn cancel<'a>(
        &'a self,
        connection: &'a ConnectionId,
        operation: &'a OperationId,
    ) -> AdapterFuture<'a, Result<CancelOutcome, QueryError>> {
        Box::pin(async move {
            if !self.capabilities.cancellation {
                return Err(QueryError::new(
                    ErrorCategory::Unsupported,
                    "this engine does not support query cancellation",
                ));
            }

            let mut state = self.state();
            if !state.connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }

            if state.running_operations.remove(operation) {
                Ok(CancelOutcome::Requested)
            } else {
                Ok(CancelOutcome::NotRunning)
            }
        })
    }

    fn begin_transaction<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<TransactionId, QueryError>> {
        Box::pin(async move {
            if !self.capabilities.transactions {
                return Err(QueryError::new(
                    ErrorCategory::Unsupported,
                    "this engine does not support explicit transactions",
                ));
            }

            let mut state = self.state();
            if !state.connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }

            state.begin_transaction_calls += 1;
            state.next_transaction += 1;
            let id = TransactionId::new(format!("tx-{}", state.next_transaction));
            state.open_transactions.insert(id.clone());
            Ok(id)
        })
    }

    fn commit<'a>(
        &'a self,
        connection: &'a ConnectionId,
        transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            if !self.capabilities.transactions {
                return Err(QueryError::new(
                    ErrorCategory::Unsupported,
                    "this engine does not support explicit transactions",
                ));
            }

            let mut state = self.state();
            if !state.connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }
            if !state.open_transactions.remove(transaction) {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!("transaction `{transaction}` is not open"),
                ));
            }
            state.commit_calls += 1;
            Ok(())
        })
    }

    fn rollback<'a>(
        &'a self,
        connection: &'a ConnectionId,
        transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>> {
        Box::pin(async move {
            if !self.capabilities.transactions {
                return Err(QueryError::new(
                    ErrorCategory::Unsupported,
                    "this engine does not support explicit transactions",
                ));
            }

            let mut state = self.state();
            if !state.connections.contains_key(connection) {
                return Err(Self::unknown_connection(connection));
            }
            if !state.open_transactions.remove(transaction) {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!("transaction `{transaction}` is not open"),
                ));
            }
            state.rollback_calls += 1;
            Ok(())
        })
    }
}

#[cfg(test)]
mod contract_tests {
    use std::future::Future;
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    use super::FakeAdapter;
    use crate::database::{
        CancelOutcome, ChangeOutcome, ChangeRequest, ConnectionId, ConnectionSecret,
        ConnectionState, ConstraintKind, DatabaseAdapter, FilterOperator, ObjectKind, ObjectRef,
        ObjectScope, PendingChange, RowIdentity, RowKey, SortDirection, SortKey, TableFilter,
        TablePageRequest,
    };
    use crate::domain::connection::{ServerConnection, SqliteConnection, TlsMode};
    use crate::domain::{
        CellValue, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory, OperationId,
        OperationState, QueryError, QueryRequest,
    };

    /// Minimal executor for the immediately-ready futures a fake returns.
    ///
    /// No async runtime dependency is added; the fake never yields `Pending`,
    /// so this polls to completion without a reactor.
    fn block_on<F: Future>(future: F) -> F::Output {
        struct NoopWaker;
        impl Wake for NoopWaker {
            fn wake(self: Arc<Self>) {}
        }

        let waker: Waker = Arc::new(NoopWaker).into();
        let mut context = Context::from_waker(&waker);
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

    fn postgres_descriptor() -> ConnectionDescriptor {
        ConnectionDescriptor::Postgres(ServerConnection {
            host: "localhost".to_string(),
            port: 5432,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
        })
    }

    fn mysql_descriptor() -> ConnectionDescriptor {
        ConnectionDescriptor::MySql(ServerConnection {
            host: "localhost".to_string(),
            port: 3306,
            database: Some("app".to_string()),
            username: "app_user".to_string(),
            tls: TlsMode::Preferred,
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

    fn connected(engine: EngineId, descriptor: &ConnectionDescriptor) -> (FakeAdapter, ConnectionId) {
        let adapter = FakeAdapter::new(engine);
        let secret = ConnectionSecret::new("correct-horse");
        let connection = block_on(adapter.connect(
            descriptor,
            if descriptor.server().is_some() {
                Some(&secret)
            } else {
                None
            },
        ))
        .expect("fake connect should succeed");
        (adapter, connection)
    }

    #[test]
    fn capabilities_match_engine_defaults() {
        for engine in [EngineId::Sqlite, EngineId::MySql, EngineId::Postgres] {
            let adapter = FakeAdapter::new(engine);
            assert_eq!(adapter.engine(), engine);
            assert_eq!(adapter.capabilities(), engine.capabilities());
        }
    }

    #[test]
    fn adapter_rejects_a_descriptor_for_another_engine() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let error = block_on(adapter.connect(&postgres_descriptor(), None))
            .expect_err("mismatched descriptor must fail");

        assert_eq!(error.category, ErrorCategory::Configuration);
    }

    #[test]
    fn server_engines_require_valid_credentials() {
        let adapter = FakeAdapter::new(EngineId::Postgres);
        let descriptor = postgres_descriptor();

        let missing = block_on(adapter.test_connection(&descriptor, None))
            .expect_err("missing credentials must fail");
        assert_eq!(missing.category, ErrorCategory::Authentication);

        let empty_secret = ConnectionSecret::new("");
        let empty = block_on(adapter.test_connection(&descriptor, Some(&empty_secret)))
            .expect_err("empty credentials must fail");
        assert_eq!(empty.category, ErrorCategory::Authentication);

        let bad_secret = ConnectionSecret::new("bad");
        let rejected = block_on(adapter.test_connection(&descriptor, Some(&bad_secret)))
            .expect_err("rejected credentials must fail");
        assert_eq!(rejected.category, ErrorCategory::Authentication);

        let good_secret = ConnectionSecret::new("correct-horse");
        let test = block_on(adapter.test_connection(&descriptor, Some(&good_secret)))
            .expect("valid credentials should succeed");
        assert_eq!(test.engine, EngineId::Postgres);
        assert!(test.server_version.is_some());
    }

    #[test]
    fn sqlite_connect_and_disconnect_report_state() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let descriptor = sqlite_descriptor();

        let connection = block_on(adapter.connect(&descriptor, None)).expect("connect should work");
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("state should resolve"),
            ConnectionState::Connected
        );

        block_on(adapter.disconnect(&connection)).expect("disconnect should work");
        assert_eq!(
            block_on(adapter.connection_state(&connection)).expect("state should resolve"),
            ConnectionState::Disconnected
        );
    }

    #[test]
    fn unknown_connections_are_errors_not_results() {
        let adapter = FakeAdapter::new(EngineId::Sqlite);
        let unknown = ConnectionId::new("does-not-exist");

        let state_error = block_on(adapter.connection_state(&unknown))
            .expect_err("unknown connection state must error");
        assert_eq!(state_error.category, ErrorCategory::Connection);

        let execute_error = block_on(adapter.execute(
            &unknown,
            QueryRequest::new("op-unknown", "SELECT 1"),
        ))
        .expect_err("executing on an unknown connection must error");
        assert_eq!(execute_error.category, ErrorCategory::Connection);
        assert_eq!(adapter.execute_call_count(), 1);
    }

    #[test]
    fn select_returns_normalized_columns_and_rows() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-select", "SELECT id, name FROM users"),
        ))
        .expect("select should return a result");

        assert_eq!(result.state, OperationState::Succeeded);
        assert!(result.state.is_success());
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.columns[0].name, "id");
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][0], crate::domain::CellValue::Integer(1));
        assert!(!result.truncated);
    }

    #[test]
    fn empty_select_is_succeeded_with_no_rows() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-empty", "SELECT id FROM users WHERE 0"),
        ))
        .expect("empty select should return a result");

        assert_eq!(result.state, OperationState::Succeeded);
        assert!(result.rows.is_empty());
        assert_eq!(result.columns.len(), 1);
    }

    #[test]
    fn max_rows_truncates_deterministically() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-cap", "SELECT id, name FROM users").with_max_rows(1),
        ))
        .expect("capped select should return a result");

        assert!(result.truncated);
        assert_eq!(result.rows.len(), 1);
    }

    #[test]
    fn syntax_error_is_a_failed_result_not_an_err() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-syntax", "SYNTAX ERROR HERE"),
        ))
        .expect("a failed statement still produces a result");

        assert_eq!(result.state, OperationState::Failed);
        assert!(!result.state.is_success());
        let error = result.error.expect("failed result should carry an error");
        assert_eq!(error.category, ErrorCategory::Syntax);
    }

    #[test]
    fn constraint_violation_is_a_failed_result() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-constraint", "INSERT INTO users VALUES (1) -- CONSTRAINT"),
        ))
        .expect("a constraint failure still produces a result");

        assert_eq!(result.state, OperationState::Failed);
        let error = result.error.expect("failed result should carry an error");
        assert_eq!(error.category, ErrorCategory::Constraint);
        assert_eq!(error.code.as_deref(), Some("23505"));
    }

    #[test]
    fn transport_failure_on_write_is_uncertain_and_not_retried() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let result = block_on(adapter.execute(
            &connection,
            QueryRequest::new("op-uncertain", "UPDATE users SET name = 'x' -- TRANSPORT"),
        ))
        .expect("an uncertain write still produces a result");

        assert_eq!(result.state, OperationState::OutcomeUnknown);
        assert!(!result.state.is_success());
        assert!(result.state.is_terminal());
        let error = result.error.expect("uncertain result should explain the cause");
        assert_eq!(error.category, ErrorCategory::Transport);
        assert_eq!(
            adapter.execute_call_count(),
            1,
            "a write with an uncertain outcome must not be retried automatically"
        );
    }

    #[test]
    fn cancellation_respects_capability() {
        let unsupported = FakeAdapter::new(EngineId::Sqlite);
        let error = block_on(unsupported.cancel(&ConnectionId::new("c"), &OperationId::new("op")))
            .expect_err("SQLite must report cancellation as unsupported");
        assert_eq!(error.category, ErrorCategory::Unsupported);

        let descriptor = postgres_descriptor();
        let (adapter, connection) = connected(EngineId::Postgres, &descriptor);
        let adapter = adapter.with_running_operation("op-running");

        assert_eq!(
            block_on(adapter.cancel(&connection, &OperationId::new("op-running")))
                .expect("running operation should accept cancellation"),
            CancelOutcome::Requested
        );
        assert_eq!(
            block_on(adapter.cancel(&connection, &OperationId::new("op-idle")))
                .expect("idle operation should not accept cancellation"),
            CancelOutcome::NotRunning
        );
    }

    #[test]
    fn transactions_are_gated_by_capability() {
        let descriptor = postgres_descriptor();
        let (adapter, connection) = connected(EngineId::Postgres, &descriptor);

        let transaction = block_on(adapter.begin_transaction(&connection))
            .expect("PostgreSQL should begin a transaction");
        block_on(adapter.commit(&connection, &transaction)).expect("commit should succeed");
        let stale = block_on(adapter.rollback(&connection, &transaction))
            .expect_err("committed transaction must not roll back");
        assert_eq!(stale.category, ErrorCategory::Validation);

        let no_transactions = FakeAdapter::new(EngineId::Postgres)
            .with_capabilities(EngineCapabilities::default());
        let error = block_on(no_transactions.begin_transaction(&connection))
            .expect_err("transaction-less adapter must reject begin");
        assert_eq!(error.category, ErrorCategory::Unsupported);
    }

    #[test]
    fn metadata_listing_and_description_are_deterministic() {
        let descriptor = postgres_descriptor();
        let (adapter, connection) = connected(EngineId::Postgres, &descriptor);

        let objects = block_on(adapter.list_objects(&connection, &ObjectScope::default()))
            .expect("listing should succeed");
        let names: Vec<&str> = objects.iter().map(|object| object.name.as_str()).collect();
        assert_eq!(names, ["users", "active_users"]);
        assert_eq!(objects[0].kind, ObjectKind::Table);
        assert_eq!(objects[1].kind, ObjectKind::View);
        assert_eq!(objects[0].schema.as_deref(), Some("public"));

        let description = block_on(adapter.describe_table(&connection, &objects[0]))
            .expect("description should succeed");
        assert_eq!(description.columns[0].name, "id");
        assert_eq!(description.primary_key_columns, ["id"]);

        let indexes = description
            .indexes
            .expect("the fake adapter must report inspected index metadata");
        assert!(indexes
            .iter()
            .any(|index| index.name == "users_pkey" && index.primary));
        assert!(indexes
            .iter()
            .any(|index| index.name == "users_name_idx"));

        let constraints = description
            .constraints
            .expect("the fake adapter must report inspected constraint metadata");
        assert!(constraints
            .iter()
            .any(|constraint| constraint.kind == ConstraintKind::PrimaryKey));
    }

    #[test]
    fn fake_errors_never_include_the_secret() {
        let secret_value = "hunter2-super-secret";
        let secret = ConnectionSecret::new(secret_value);
        let adapter = FakeAdapter::new(EngineId::Postgres).with_connect_error(QueryError::new(
            ErrorCategory::Authentication,
            "the supplied credentials were rejected",
        ));

        let error = block_on(adapter.connect(&postgres_descriptor(), Some(&secret)))
            .expect_err("configured connect failure should surface");
        let rendered = format!("{error} {error:?}");

        assert!(!rendered.contains(secret_value));
        assert_eq!(error.category, ErrorCategory::Authentication);
    }

    #[test]
    fn table_description_type_is_serializable() {
        let object = ObjectRef {
            database: None,
            schema: None,
            name: "users".to_string(),
            kind: ObjectKind::Table,
        };
        let encoded = serde_json::to_string(&object).expect("object should serialize");
        assert!(encoded.contains("\"kind\":\"table\""));
        assert!(!encoded.to_lowercase().contains("password"));
    }

    #[test]
    fn scope_listing_reports_supported_scopes_and_unsupported_engines() {
        let sqlite = FakeAdapter::new(EngineId::Sqlite);
        let connection = block_on(sqlite.connect(&sqlite_descriptor(), None)).expect("connect");
        let error =
            block_on(sqlite.list_scopes(&connection)).expect_err("SQLite exposes no scopes");
        assert_eq!(error.category, ErrorCategory::Unsupported);

        let descriptor = postgres_descriptor();
        let (adapter, connection) = connected(EngineId::Postgres, &descriptor);
        let listing = block_on(adapter.list_scopes(&connection)).expect("PostgreSQL scopes");
        assert!(listing.databases.is_empty());
        assert_eq!(listing.schemas, ["public"]);

        let descriptor = mysql_descriptor();
        let (adapter, connection) = connected(EngineId::MySql, &descriptor);
        let listing = block_on(adapter.list_scopes(&connection)).expect("MySQL scopes");
        assert_eq!(listing.databases, ["app"]);
    }

    #[test]
    fn table_pages_are_bounded_and_deterministically_sorted() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);
        let descending = vec![SortKey {
            column: "name".to_string(),
            direction: SortDirection::Descending,
        }];

        let first = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-1", users_object(), 2).with_sort(descending.clone()),
        ))
        .expect("first page should succeed");

        assert_eq!(first.rows.len(), 2);
        assert_eq!(first.total_rows, Some(3));
        assert_eq!(first.row_identity, ["id"]);
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(first.rows[0][1], CellValue::Text("carol".to_string()));
        assert_eq!(first.rows[1][1], CellValue::Text("bob".to_string()));

        let second = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-2", users_object(), 2)
                .with_offset(2)
                .with_sort(descending),
        ))
        .expect("second page should succeed");

        assert_eq!(second.rows.len(), 1);
        assert!(!second.truncated);
        assert_eq!(second.next_offset, None);
        assert_eq!(second.rows[0][1], CellValue::Text("alice".to_string()));
    }

    #[test]
    fn filters_bind_values_and_validate_identifier_columns() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("filter-1", users_object(), 10).with_filters(vec![
                TableFilter {
                    column: "name".to_string(),
                    operator: FilterOperator::Equal,
                    values: vec![CellValue::Text("bob".to_string())],
                },
                TableFilter {
                    column: "id".to_string(),
                    operator: FilterOperator::GreaterThanOrEqual,
                    values: vec![CellValue::Integer(2)],
                },
            ]),
        ))
        .expect("valid filters should succeed");

        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0][0], CellValue::Integer(2));
        assert_eq!(page.rows[0][1], CellValue::Text("bob".to_string()));

        let error = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("filter-2", users_object(), 10).with_filters(vec![
                TableFilter {
                    column: "name = 'bob'".to_string(),
                    operator: FilterOperator::Equal,
                    values: vec![CellValue::Text("bob".to_string())],
                },
            ]),
        ))
        .expect_err("identifier columns outside table metadata must be rejected");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn parameterized_changes_apply_and_are_visible_in_later_pages() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let insert = ChangeRequest::new(
            "chg-insert",
            users_object(),
            PendingChange::insert(vec![
                RowKey::new("id", CellValue::Integer(4)),
                RowKey::new("name", CellValue::Text("dave".to_string())),
            ]),
        );
        let result = block_on(adapter.apply_change(&connection, insert)).expect("insert");
        assert_eq!(result.outcome, ChangeOutcome::Applied);
        assert_eq!(result.affected_rows, Some(1));

        let update = ChangeRequest::new(
            "chg-update",
            users_object(),
            PendingChange::update(
                RowIdentity::key("id", CellValue::Integer(1)),
                vec![RowKey::new(
                    "name",
                    CellValue::Text("alice-updated".to_string()),
                )],
            ),
        );
        let result = block_on(adapter.apply_change(&connection, update)).expect("update");
        assert_eq!(result.outcome, ChangeOutcome::Applied);

        let delete = ChangeRequest::new(
            "chg-delete",
            users_object(),
            PendingChange::delete(RowIdentity::key("id", CellValue::Integer(2))),
        );
        let result = block_on(adapter.apply_change(&connection, delete)).expect("delete");
        assert_eq!(result.outcome, ChangeOutcome::Applied);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-after", users_object(), 10),
        ))
        .expect("page should succeed");

        assert_eq!(page.rows.len(), 3);
        assert!(page
            .rows
            .iter()
            .any(|row| row[1] == CellValue::Text("alice-updated".to_string())));
        assert!(page
            .rows
            .iter()
            .any(|row| row[1] == CellValue::Text("dave".to_string())));
        assert!(page
            .rows
            .iter()
            .all(|row| row[1] != CellValue::Text("bob".to_string())));
    }

    #[test]
    fn stale_original_value_yields_a_conflict_without_overwriting() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let stale = PendingChange::update(
            RowIdentity::new(
                vec![RowKey::new("id", CellValue::Integer(1))],
                vec![RowKey::new(
                    "name",
                    CellValue::Text("someone-elses-value".to_string()),
                )],
            ),
            vec![RowKey::new("name", CellValue::Text("clobbered".to_string()))],
        );

        let result = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-stale", users_object(), stale),
        ))
        .expect("a stale update should still produce a result");

        assert_eq!(result.outcome, ChangeOutcome::Conflict);
        assert!(!result.outcome.is_applied());
        assert_eq!(result.conflicted_columns, ["name"]);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-stale", users_object(), 10).with_filters(vec![
                TableFilter {
                    column: "id".to_string(),
                    operator: FilterOperator::Equal,
                    values: vec![CellValue::Integer(1)],
                },
            ]),
        ))
        .expect("page should succeed");
        assert_eq!(page.rows[0][1], CellValue::Text("alice".to_string()));
    }

    #[test]
    fn changes_without_a_safe_row_identity_are_unsupported() {
        let descriptor = sqlite_descriptor();
        let adapter = FakeAdapter::new(EngineId::Sqlite).without_primary_key();
        let connection = block_on(adapter.connect(&descriptor, None)).expect("connect");

        let change = PendingChange::update(
            RowIdentity::key("id", CellValue::Integer(1)),
            vec![RowKey::new("name", CellValue::Text("x".to_string()))],
        );
        let error = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-unsafe", users_object(), change),
        ))
        .expect_err("a table without a primary key cannot target a row safely");
        assert_eq!(error.category, ErrorCategory::Unsupported);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-unsafe", users_object(), 10),
        ))
        .expect("paging should still work");
        assert!(
            page.row_identity.is_empty(),
            "missing identity must be surfaced rather than hidden"
        );
    }

    #[test]
    fn change_identifiers_are_validated_against_the_table() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let change = PendingChange::insert(vec![RowKey::new(
            "name); DROP TABLE users; --",
            CellValue::Text("x".to_string()),
        )]);
        let error = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-inject", users_object(), change),
        ))
        .expect_err("an unknown identifier must be rejected, not concatenated");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn uncertain_writes_are_reported_and_not_retried() {
        let descriptor = sqlite_descriptor();
        let adapter = FakeAdapter::new(EngineId::Sqlite).with_uncertain_write();
        let connection = block_on(adapter.connect(&descriptor, None)).expect("connect");

        let change = PendingChange::delete(RowIdentity::key("id", CellValue::Integer(1)));
        let result = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-uncertain", users_object(), change),
        ))
        .expect("an uncertain write should still produce a result");

        assert_eq!(result.outcome, ChangeOutcome::OutcomeUnknown);
        assert!(!result.outcome.is_applied());
        assert!(result.error.is_some());
    }

    #[test]
    fn write_targets_other_than_the_users_base_table_are_rejected() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let targets = [
            ObjectRef {
                database: None,
                schema: None,
                name: "active_users".to_string(),
                kind: ObjectKind::View,
            },
            ObjectRef {
                database: None,
                schema: None,
                name: "users".to_string(),
                kind: ObjectKind::View,
            },
            ObjectRef {
                database: None,
                schema: None,
                name: "orders".to_string(),
                kind: ObjectKind::Table,
            },
        ];

        for target in targets {
            let change = PendingChange::insert(vec![
                RowKey::new("id", CellValue::Integer(99)),
                RowKey::new("name", CellValue::Text("mallory".to_string())),
            ]);
            let operation = format!("chg-{}", target.name);
            let error = block_on(adapter.apply_change(
                &connection,
                ChangeRequest::new(operation, target, change),
            ))
            .expect_err("a change targeting another object must be rejected");
            assert_eq!(error.category, ErrorCategory::Validation);
        }

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-target", users_object(), 10),
        ))
        .expect("page should succeed");
        assert_eq!(page.rows.len(), 3, "rejected writes must not mutate rows");
    }

    #[test]
    fn row_identity_must_match_the_full_primary_key() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let cases = [
            (
                "non-primary-key",
                RowIdentity::key("name", CellValue::Text("alice".to_string())),
            ),
            (
                "duplicate",
                RowIdentity::new(
                    vec![
                        RowKey::new("id", CellValue::Integer(1)),
                        RowKey::new("id", CellValue::Integer(1)),
                    ],
                    Vec::new(),
                ),
            ),
            ("missing", RowIdentity::new(Vec::new(), Vec::new())),
            (
                "unknown",
                RowIdentity::key("nope", CellValue::Integer(1)),
            ),
        ];

        for (label, identity) in cases {
            let change = PendingChange::update(
                identity,
                vec![RowKey::new("name", CellValue::Text("x".to_string()))],
            );
            let operation = format!("chg-{label}");
            let error = block_on(adapter.apply_change(
                &connection,
                ChangeRequest::new(operation, users_object(), change),
            ))
            .expect_err("an identity that does not match the primary key must be rejected");
            assert_eq!(error.category, ErrorCategory::Validation, "case: {label}");
        }
    }

    #[test]
    fn composite_primary_key_requires_every_key_column() {
        let descriptor = sqlite_descriptor();
        let adapter = FakeAdapter::new(EngineId::Sqlite).with_primary_key(["id", "name"]);
        let connection = block_on(adapter.connect(&descriptor, None)).expect("connect");

        let partial = PendingChange::update(
            RowIdentity::key("id", CellValue::Integer(1)),
            vec![RowKey::new("name", CellValue::Text("x".to_string()))],
        );
        let error = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-partial", users_object(), partial),
        ))
        .expect_err("a partial composite identity must be rejected");
        assert_eq!(error.category, ErrorCategory::Validation);

        let full = PendingChange::delete(RowIdentity::new(
            vec![
                RowKey::new("id", CellValue::Integer(2)),
                RowKey::new("name", CellValue::Text("bob".to_string())),
            ],
            Vec::new(),
        ));
        let result = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-full", users_object(), full),
        ))
        .expect("a full composite identity should apply");
        assert_eq!(result.outcome, ChangeOutcome::Applied);
        assert_eq!(result.affected_rows, Some(1));
    }

    #[test]
    fn filter_value_cardinality_is_validated_per_operator() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let cases: Vec<(&str, FilterOperator, Vec<CellValue>)> = vec![
            ("equal-none", FilterOperator::Equal, Vec::new()),
            (
                "equal-many",
                FilterOperator::Equal,
                vec![CellValue::Integer(1), CellValue::Integer(2)],
            ),
            (
                "like-many",
                FilterOperator::Like,
                vec![
                    CellValue::Text("%a%".to_string()),
                    CellValue::Text("%b%".to_string()),
                ],
            ),
            ("in-none", FilterOperator::In, Vec::new()),
            ("is-null-value", FilterOperator::IsNull, vec![CellValue::Null]),
            (
                "is-not-null-value",
                FilterOperator::IsNotNull,
                vec![CellValue::Integer(1)],
            ),
        ];

        for (label, operator, values) in cases {
            let request = TablePageRequest::new(
                format!("bad-{label}"),
                users_object(),
                10,
            )
            .with_filters(vec![TableFilter {
                column: "id".to_string(),
                operator,
                values,
            }]);
            let error = block_on(adapter.fetch_table_page(&connection, request))
                .expect_err("an invalid filter cardinality must be rejected");
            assert_eq!(error.category, ErrorCategory::Validation, "case: {label}");
        }

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("in-many", users_object(), 10).with_filters(vec![TableFilter {
                column: "id".to_string(),
                operator: FilterOperator::In,
                values: vec![CellValue::Integer(1), CellValue::Integer(3)],
            }]),
        ))
        .expect("`in` with several values should be accepted");
        assert_eq!(page.rows.len(), 2);

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("is-null", users_object(), 10).with_filters(vec![TableFilter {
                column: "name".to_string(),
                operator: FilterOperator::IsNull,
                values: Vec::new(),
            }]),
        ))
        .expect("`is null` with no values should be accepted");
        assert_eq!(page.rows.len(), 0);
    }

    #[test]
    fn duplicate_primary_key_insert_is_a_constraint_failure_without_mutation() {
        let descriptor = sqlite_descriptor();
        let (adapter, connection) = connected(EngineId::Sqlite, &descriptor);

        let duplicate = PendingChange::insert(vec![
            RowKey::new("id", CellValue::Integer(1)),
            RowKey::new("name", CellValue::Text("impostor".to_string())),
        ]);
        let result = block_on(adapter.apply_change(
            &connection,
            ChangeRequest::new("chg-duplicate", users_object(), duplicate),
        ))
        .expect("a duplicate insert should produce a failed outcome");

        assert_eq!(result.outcome, ChangeOutcome::Failed);
        assert!(!result.outcome.is_applied());
        let error = result
            .error
            .expect("a constraint failure should carry an error");
        assert_eq!(error.category, ErrorCategory::Constraint);
        assert_eq!(error.code.as_deref(), Some("23505"));

        let page = block_on(adapter.fetch_table_page(
            &connection,
            TablePageRequest::new("page-duplicate", users_object(), 10),
        ))
        .expect("page should succeed");
        assert_eq!(page.rows.len(), 3, "a rejected insert must not mutate rows");
        assert!(page
            .rows
            .iter()
            .all(|row| row[1] != CellValue::Text("impostor".to_string())));
    }
}
