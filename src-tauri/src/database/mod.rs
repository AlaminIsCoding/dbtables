//! Database adapter boundary.
//!
//! This module defines the asynchronous contract that every database engine
//! adapter implements behind the application services, together with the
//! normalized, frontend-safe types exchanged across that boundary.
//!
//! Design rules:
//!
//! - Driver-native connection/pool/row objects stay inside an adapter. The
//!   shared boundary exposes only serializable tokens ([`ConnectionId`],
//!   [`TransactionId`], `OperationId`) and normalized data.
//! - Secrets are supplied to an adapter separately from a descriptor through
//!   [`ConnectionSecret`], which is neither serializable nor printed in full.
//! - [`DatabaseAdapter::execute`] reports completed outcomes — including
//!   `failed`, `cancelled`, and `outcome_unknown` — as `Ok(QueryResult)`. This
//!   ensures an uncertain write is never confused with a definite transport
//!   error that a caller might retry. `Err(QueryError)` is reserved for
//!   failures that prevent producing a result at all, such as using an unknown
//!   or disconnected connection.
//!
//! Table paging and staged mutations live on this same boundary. Their request
//! types keep **identifiers** (column names) separate from **bound values**
//! ([`CellValue`]): callers must never pass raw SQL fragments, and adapters must
//! validate and quote identifiers with engine-specific rules instead of
//! interpolating untrusted text into SQL. Writes report an explicit
//! [`ChangeOutcome`] so a stale-row conflict is never mistaken for a
//! successful update. The capability flags on [`EngineCapabilities`] state
//! whether an engine supports transactions, savepoints, and cancellation.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

use crate::domain::{
    CellValue, ColumnInfo, ConnectionDescriptor, EngineCapabilities, EngineId, ErrorCategory,
    OperationId, QueryError, QueryRequest, QueryResult, Row,
};

pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod testing;

pub use mysql::MySqlAdapter;
pub use postgres::PostgresAdapter;
pub use sqlite::SqliteAdapter;

/// Future returned by every adapter operation.
///
/// Adapters are asynchronous because real drivers perform network or file I/O.
/// Returning a boxed `Send` future keeps the trait object-safe without adding
/// an async-trait dependency.
pub type AdapterFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Opaque, serializable handle for an open adapter connection.
///
/// The value contains no driver-native objects; it is only a token the adapter
/// maps to its internal pool/handle. Adapters must not expose those internals
/// across the boundary. Serialized as a plain string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(String);

impl ConnectionId {
    /// Wraps a connection token.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrows the token as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for ConnectionId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for ConnectionId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl std::fmt::Display for ConnectionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Opaque, serializable handle for an open explicit transaction.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TransactionId(String);

impl TransactionId {
    /// Wraps a transaction token.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrows the token as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for TransactionId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for TransactionId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl std::fmt::Display for TransactionId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A resolved credential passed to an adapter at connect time.
///
/// This is the only place a secret enters the adapter boundary. It is
/// deliberately not serializable and never appears in `Debug` output, so it
/// cannot travel across Tauri IPC, be persisted, or be captured in a test
/// snapshot. Adapters should take the value with [`ConnectionSecret::expose`]
/// and must not copy it into logs or errors.
pub struct ConnectionSecret(String);

impl ConnectionSecret {
    /// Wraps a secret value resolved from protected storage.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrows the secret for the duration of a driver call.
    ///
    /// Named `expose` rather than a plain accessor to make the trust boundary
    /// explicit at every call site.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether the secret is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for ConnectionSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConnectionSecret([redacted])")
    }
}

/// Reported state of a connection known to an adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    /// The connection has been closed or was never established.
    Disconnected,
    /// A connect attempt is in progress.
    Connecting,
    /// The connection is open and usable.
    Connected,
    /// The connection failed or was lost and is not usable.
    Failed,
}

/// Kind of database object exposed by metadata listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    /// A base table.
    Table,
    /// A view.
    View,
}

/// Stable, engine-neutral reference to a database object.
///
/// `database` and `schema` are optional because engines differ: SQLite has
/// neither, PostgreSQL has schemas, and MySQL treats databases as catalogs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    /// Database/catalog that contains the object, when the engine exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// Schema that contains the object, when the engine exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// Object name.
    pub name: String,
    /// Whether the object is a table or a view.
    pub kind: ObjectKind,
}

/// Scope used when listing objects.
///
/// Both fields are optional; `None` means "the connection's default
/// database/schema" or "all of them", depending on engine capability.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectScope {
    /// Database/catalog to list, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// Schema to list, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

/// Kind of table constraint reported by metadata inspection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintKind {
    /// The table's primary key.
    PrimaryKey,
    /// A foreign key referencing another table.
    ForeignKey,
    /// A unique constraint.
    Unique,
    /// A check constraint.
    Check,
}

/// Normalized description of a table index.
///
/// `columns` is in index order. Expression indexes (where an engine exposes no
/// column name for a key part) keep their ordinal position by using the
/// adapter's placeholder text, so the list length still reflects the width.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    /// Index name as reported by the engine.
    pub name: String,
    /// Indexed columns in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
    /// Whether the index enforces uniqueness.
    pub unique: bool,
    /// Whether the index backs the primary key.
    #[serde(default)]
    pub primary: bool,
}

impl IndexInfo {
    /// Creates index metadata.
    pub fn new(name: impl Into<String>, columns: Vec<String>, unique: bool, primary: bool) -> Self {
        Self {
            name: name.into(),
            columns,
            unique,
            primary,
        }
    }
}

/// Normalized description of a table constraint.
///
/// A foreign key carries the referenced table/columns so the UI can show a
/// relationship without a second engine call. `definition` carries engine text
/// for check constraints and expression details when the engine reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    /// Constraint name as reported by the engine, or a deterministic label the
    /// adapter generates when the engine does not name it.
    pub name: String,
    /// Kind of constraint.
    pub kind: ConstraintKind,
    /// Constrained columns in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
    /// For a foreign key: referenced schema, when the engine reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referenced_schema: Option<String>,
    /// For a foreign key: referenced table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referenced_table: Option<String>,
    /// For a foreign key: referenced columns, in the same order as `columns`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub referenced_columns: Vec<String>,
    /// Engine text for a check constraint, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
}

impl ConstraintInfo {
    /// Creates a constraint of `kind` with its columns and no extra details.
    ///
    /// Used for kinds whose engine metadata carries nothing beyond name and
    /// columns (for example a MySQL `CHECK` constraint when the engine does not
    /// expose its clause through the queried view).
    pub fn of_kind(name: impl Into<String>, kind: ConstraintKind, columns: Vec<String>) -> Self {
        Self {
            name: name.into(),
            kind,
            columns,
            referenced_schema: None,
            referenced_table: None,
            referenced_columns: Vec::new(),
            definition: None,
        }
    }

    /// Creates a primary-key constraint.
    pub fn primary_key(name: impl Into<String>, columns: Vec<String>) -> Self {
        Self::of_kind(name, ConstraintKind::PrimaryKey, columns)
    }

    /// Creates a unique constraint.
    pub fn unique(name: impl Into<String>, columns: Vec<String>) -> Self {
        Self::of_kind(name, ConstraintKind::Unique, columns)
    }

    /// Creates a foreign-key constraint with its referenced target.
    pub fn foreign_key(
        name: impl Into<String>,
        columns: Vec<String>,
        referenced_schema: Option<String>,
        referenced_table: impl Into<String>,
        referenced_columns: Vec<String>,
    ) -> Self {
        Self {
            name: name.into(),
            kind: ConstraintKind::ForeignKey,
            columns,
            referenced_schema,
            referenced_table: Some(referenced_table.into()),
            referenced_columns,
            definition: None,
        }
    }

    /// Creates a check constraint carrying its engine text.
    pub fn check(name: impl Into<String>, definition: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind: ConstraintKind::Check,
            columns: Vec::new(),
            referenced_schema: None,
            referenced_table: None,
            referenced_columns: Vec::new(),
            definition: Some(definition.into()),
        }
    }
}

/// Normalized description of a table or view.
///
/// `indexes` and `constraints` distinguish "not supported" from "none exist":
/// `None` means the adapter does not expose that metadata for the object, while
/// `Some(vec![])` means it was inspected and the engine reported none. An
/// adapter must never return an empty vector to imply support it does not have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDescription {
    /// Column metadata in ordinal order.
    pub columns: Vec<ColumnInfo>,
    /// Column names that make up the primary key, empty when unknown or absent.
    ///
    /// A non-empty value is the minimum stable row identity table browsing
    /// needs before it may offer safe row targeting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub primary_key_columns: Vec<String>,
    /// Indexes when the adapter can report them; `None` when unsupported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<IndexInfo>>,
    /// Constraints when the adapter can report them; `None` when unsupported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Vec<ConstraintInfo>>,
}

impl TableDescription {
    /// Creates a description with columns and primary key and no optional
    /// metadata. An adapter that inspected indexes/constraints attaches them
    /// with [`TableDescription::with_indexes`]/[`TableDescription::with_constraints`].
    pub fn new(columns: Vec<ColumnInfo>, primary_key_columns: Vec<String>) -> Self {
        Self {
            columns,
            primary_key_columns,
            indexes: None,
            constraints: None,
        }
    }

    /// Attaches inspected index metadata.
    pub fn with_indexes(mut self, indexes: Vec<IndexInfo>) -> Self {
        self.indexes = Some(indexes);
        self
    }

    /// Attaches inspected constraint metadata.
    pub fn with_constraints(mut self, constraints: Vec<ConstraintInfo>) -> Self {
        self.constraints = Some(constraints);
        self
    }
}

/// Database/catalog and schema names a connection can address.
///
/// Engines differ: SQLite exposes neither, PostgreSQL exposes schemas, and
/// MySQL exposes databases/catalogs. Adapters report only what they actually
/// expose; an empty vector means "not applicable", not "none exist". Adapters
/// that expose neither return [`crate::domain::ErrorCategory::Unsupported`] so
/// the UI can hide scope pickers instead of guessing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeListing {
    /// Database/catalog names, when the engine exposes separate catalogs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub databases: Vec<String>,
    /// Schema names, when the engine exposes named schemas.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schemas: Vec<String>,
}

/// Comparison used by a [`TableFilter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOperator {
    /// `column = value`.
    Equal,
    /// `column <> value`.
    NotEqual,
    /// `column < value`.
    LessThan,
    /// `column <= value`.
    LessThanOrEqual,
    /// `column > value`.
    GreaterThan,
    /// `column >= value`.
    GreaterThanOrEqual,
    /// SQL `LIKE`/text pattern match.
    Like,
    /// `column IN (values...)`.
    In,
    /// `column IS NULL`; requires no value.
    IsNull,
    /// `column IS NOT NULL`; requires no value.
    IsNotNull,
}

/// A single table filter: an identifier column plus bound comparison values.
///
/// `column` is an **identifier** an adapter must validate against the table's
/// known columns and quote with engine-specific rules. `values` are **bound
/// parameters** and must never be concatenated into SQL text. One value is
/// expected for the comparison operators, one or more for [`FilterOperator::In`],
/// and none for the null checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    /// Column identifier to compare.
    pub column: String,
    /// Comparison to apply.
    pub operator: FilterOperator,
    /// Bound values for the comparison.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<CellValue>,
}

/// Sort direction for a [`SortKey`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
    /// Ascending order.
    Ascending,
    /// Descending order.
    Descending,
}

/// A sort instruction: an identifier column plus a direction.
///
/// As with [`TableFilter`], `column` is an identifier the adapter validates and
/// quotes; it is not interpolated from untrusted text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    /// Column identifier to order by.
    pub column: String,
    /// Direction to sort in.
    pub direction: SortDirection,
}

/// Request for one bounded page of table rows.
///
/// `limit` bounds how many rows an adapter may return; `offset` selects the
/// window. Filters and sorts use validated identifiers with separately bound
/// values so no caller-controlled SQL is constructed for either.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageRequest {
    /// Caller-supplied stable identifier echoed in the page.
    pub operation_id: OperationId,
    /// Table or view to page.
    pub object: ObjectRef,
    /// Maximum rows to return. Adapters should enforce their own upper bound.
    pub limit: u32,
    /// Rows to skip before the returned window.
    #[serde(default)]
    pub offset: u64,
    /// Filters applied with engine-side semantics where possible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filters: Vec<TableFilter>,
    /// Deterministic ordering, applied in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<SortKey>,
}

impl TablePageRequest {
    /// Creates a request for one page of `limit` rows starting at offset `0`.
    pub fn new(
        operation_id: impl Into<OperationId>,
        object: ObjectRef,
        limit: u32,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            object,
            limit,
            offset: 0,
            filters: Vec::new(),
            sort: Vec::new(),
        }
    }

    /// Sets how many matching rows to skip.
    pub fn with_offset(mut self, offset: u64) -> Self {
        self.offset = offset;
        self
    }

    /// Sets the page size, replacing the value passed to the constructor.
    pub fn with_limit(mut self, limit: u32) -> Self {
        self.limit = limit;
        self
    }

    /// Sets the filters to apply.
    pub fn with_filters(mut self, filters: Vec<TableFilter>) -> Self {
        self.filters = filters;
        self
    }

    /// Sets the deterministic ordering.
    pub fn with_sort(mut self, sort: Vec<SortKey>) -> Self {
        self.sort = sort;
        self
    }
}

/// One bounded page of rows from a table or view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    /// Stable identifier matching the originating request.
    pub operation_id: OperationId,
    /// Column metadata in result order.
    pub columns: Vec<ColumnInfo>,
    /// Rows in the requested window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<Row>,
    /// Column names forming a safe row identity (primary key preferred).
    ///
    /// Empty means the adapter could not determine one, and callers must not
    /// offer safe update/delete for these rows.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub row_identity: Vec<String>,
    /// Offset of the first returned row.
    pub offset: u64,
    /// Requested limit echoed for the caller.
    pub limit: u32,
    /// Total matching rows when the engine can report it without a full scan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_rows: Option<u64>,
    /// Whether a further page may exist beyond this window.
    #[serde(default)]
    pub truncated: bool,
    /// Offset to request next, when more rows may exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

impl TablePage {
    /// Whether the returned rows carry a stable identity for later targeting.
    ///
    /// `false` means the adapter could not determine a primary key or other safe
    /// row identifier, so callers must not offer row-targeted actions for these
    /// rows. An empty identity is surfaced honestly rather than hidden.
    pub fn has_row_identity(&self) -> bool {
        !self.row_identity.is_empty()
    }
}

/// Upper bound on rows an adapter returns for one table page.
///
/// The application applies its own (smaller) policy cap; this ceiling keeps a
/// caller that bypasses the application from pulling an unbounded page. An
/// adapter clamps a larger request and echoes the effective limit in the page.
pub const MAX_TABLE_PAGE_ROWS: u32 = 1_000;

/// Resolves the page size an adapter will actually use.
///
/// A `0` limit is rejected rather than treated as "unlimited" or "empty"; a
/// request above [`MAX_TABLE_PAGE_ROWS`] is clamped to that ceiling. The
/// effective value is what the returned [`TablePage`] echoes.
pub fn effective_table_page_limit(limit: u32) -> Result<u32, QueryError> {
    if limit == 0 {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "a table page limit must be greater than zero",
        ));
    }
    Ok(limit.min(MAX_TABLE_PAGE_ROWS))
}

/// Position of a known column by exact name, or `None` when it is not a column.
///
/// Identifier validation is exact so a caller cannot address a column the
/// adapter did not report from table metadata.
pub fn column_position(columns: &[ColumnInfo], name: &str) -> Option<usize> {
    columns.iter().position(|column| column.name == name)
}

/// Quotes a validated SQL identifier with ANSI double quotes.
///
/// Embedded double quotes are doubled. This is defense in depth: callers must
/// still validate the identifier against table metadata before quoting it.
pub fn quote_identifier(identifier: &str) -> String {
    let mut quoted = String::with_capacity(identifier.len() + 2);
    quoted.push('"');
    for character in identifier.chars() {
        if character == '"' {
            quoted.push('"');
        }
        quoted.push(character);
    }
    quoted.push('"');
    quoted
}

/// Quotes a validated SQL identifier with MySQL backticks.
///
/// Embedded backticks are doubled. As with [`quote_identifier`], validation
/// against table metadata is still required first.
pub fn quote_identifier_backtick(identifier: &str) -> String {
    let mut quoted = String::with_capacity(identifier.len() + 2);
    quoted.push('`');
    for character in identifier.chars() {
        if character == '`' {
            quoted.push('`');
        }
        quoted.push(character);
    }
    quoted.push('`');
    quoted
}

/// SQL keyword for a sort direction.
pub fn sort_direction_sql(direction: SortDirection) -> &'static str {
    match direction {
        SortDirection::Ascending => "ASC",
        SortDirection::Descending => "DESC",
    }
}

/// Builds an `ORDER BY` body from validated sort keys, quoting identifiers.
pub fn build_order_clause(order: &[SortKey], quote: impl Fn(&str) -> String) -> String {
    order
        .iter()
        .map(|key| format!("{} {}", quote(&key.column), sort_direction_sql(key.direction)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Builds the bounded single-relation `SELECT` used to fetch one table page.
///
/// `from` is the already-validated, engine-quoted table reference (including any
/// database/schema qualifier). The projection is `columns` quoted in order, so
/// the result shape always matches the metadata the caller was shown. Every
/// filter and sort column is checked against `columns` before it is quoted, and
/// comparison values are collected separately for parameter binding, so no
/// caller-controlled text can reach the statement as SQL. `limit` and `offset`
/// are numeric and are inlined (never identifiers).
///
/// Returns the statement and the bound values in placeholder order. The caller
/// owns the driver-specific fetch and value conversion.
pub fn build_table_page_query(
    from: &str,
    columns: &[ColumnInfo],
    filters: &[TableFilter],
    order: &[SortKey],
    limit: u32,
    offset: u64,
    mut placeholder: impl FnMut(usize) -> String,
    quote: impl Fn(&str) -> String,
) -> Result<(String, Vec<CellValue>), QueryError> {
    for key in order {
        if column_position(columns, &key.column).is_none() {
            return Err(QueryError::new(
                ErrorCategory::Validation,
                format!("unknown sort column `{}`", key.column),
            ));
        }
    }

    let projection = columns
        .iter()
        .map(|column| quote(&column.name))
        .collect::<Vec<_>>()
        .join(", ");
    let (where_clause, values) = build_filter_clause(filters, columns, &mut placeholder, &quote)?;
    let order_clause = build_order_clause(order, &quote);

    let mut sql = format!("SELECT {projection} FROM {from}");
    if !where_clause.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&where_clause);
    }
    if !order_clause.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&order_clause);
    }
    sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

    Ok((sql, values))
}

/// Validates how many bound values a filter operator accepts.
///
/// Scalar comparisons and `LIKE` take exactly one value, `IN` takes one or
/// more, and the null checks take none. Cardinality is checked independently of
/// the identifier so no caller-authored predicate can reach the engine.
pub fn validate_filter_values(filter: &TableFilter) -> Result<(), QueryError> {
    let count = filter.values.len();
    match filter.operator {
        FilterOperator::IsNull | FilterOperator::IsNotNull => {
            if count != 0 {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!(
                        "filter on `{}` with a null check must not carry bound values",
                        filter.column
                    ),
                ));
            }
        }
        FilterOperator::In => {
            if count == 0 {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!(
                        "filter on `{}` with `in` requires at least one bound value",
                        filter.column
                    ),
                ));
            }
        }
        _ => {
            if count != 1 {
                return Err(QueryError::new(
                    ErrorCategory::Validation,
                    format!(
                        "filter on `{}` requires exactly one bound value for this operator",
                        filter.column
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Builds a SQL predicate from filters with validated identifiers.
///
/// Every filter column is checked against `columns` before it is quoted with
/// `quote`. Comparison values are collected for parameter binding and never
/// concatenated into the statement. `placeholder` receives the 1-based position
/// of the next bound parameter and returns its token (`?` or `$n`). Returns an
/// empty predicate and no values when there are no filters.
pub fn build_filter_clause(
    filters: &[TableFilter],
    columns: &[ColumnInfo],
    mut placeholder: impl FnMut(usize) -> String,
    quote: impl Fn(&str) -> String,
) -> Result<(String, Vec<CellValue>), QueryError> {
    let mut clauses = Vec::with_capacity(filters.len());
    let mut values: Vec<CellValue> = Vec::new();

    for filter in filters {
        if column_position(columns, &filter.column).is_none() {
            return Err(QueryError::new(
                ErrorCategory::Validation,
                format!("unknown filter column `{}`", filter.column),
            ));
        }
        validate_filter_values(filter)?;

        let column = quote(&filter.column);
        let clause = match filter.operator {
            FilterOperator::Equal => {
                values.push(filter.values[0].clone());
                format!("{column} = {}", placeholder(values.len()))
            }
            FilterOperator::NotEqual => {
                values.push(filter.values[0].clone());
                format!("{column} <> {}", placeholder(values.len()))
            }
            FilterOperator::LessThan => {
                values.push(filter.values[0].clone());
                format!("{column} < {}", placeholder(values.len()))
            }
            FilterOperator::LessThanOrEqual => {
                values.push(filter.values[0].clone());
                format!("{column} <= {}", placeholder(values.len()))
            }
            FilterOperator::GreaterThan => {
                values.push(filter.values[0].clone());
                format!("{column} > {}", placeholder(values.len()))
            }
            FilterOperator::GreaterThanOrEqual => {
                values.push(filter.values[0].clone());
                format!("{column} >= {}", placeholder(values.len()))
            }
            FilterOperator::Like => {
                values.push(filter.values[0].clone());
                format!("{column} LIKE {}", placeholder(values.len()))
            }
            FilterOperator::In => {
                let mut tokens = Vec::with_capacity(filter.values.len());
                for value in &filter.values {
                    values.push(value.clone());
                    tokens.push(placeholder(values.len()));
                }
                format!("{column} IN ({})", tokens.join(", "))
            }
            FilterOperator::IsNull => format!("{column} IS NULL"),
            FilterOperator::IsNotNull => format!("{column} IS NOT NULL"),
        };
        clauses.push(clause);
    }

    Ok((clauses.join(" AND "), values))
}

/// Effective ordering for a page: the caller's sort plus any missing row
/// identity columns appended ascending as deterministic tie-breakers.
///
/// Appending the identity columns keeps offset paging stable when the requested
/// sort is not unique. Columns are matched by exact name so a sort that already
/// names an identity column is never duplicated.
pub fn effective_sort_order(sort: &[SortKey], row_identity: &[String]) -> Vec<SortKey> {
    let mut effective = sort.to_vec();
    for column in row_identity {
        if !effective.iter().any(|key| &key.column == column) {
            effective.push(SortKey {
                column: column.clone(),
                direction: SortDirection::Ascending,
            });
        }
    }
    effective
}

/// A column identifier paired with a bound value.
///
/// The two halves are deliberately separate: `column` is an identifier the
/// adapter must validate and quote, while `value` is a [`CellValue`] that must
/// be bound as a parameter. Callers must not place SQL or a `column = value`
/// expression in either field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowKey {
    /// Column identifier.
    pub column: String,
    /// Bound value for the column.
    pub value: CellValue,
}

impl RowKey {
    /// Creates a column/value pair.
    pub fn new(column: impl Into<String>, value: CellValue) -> Self {
        Self {
            column: column.into(),
            value,
        }
    }
}

/// Stable identity for an existing row plus optional original values.
///
/// `keys` is the primary key (or another safe identity) and its original
/// values. `original_values` optionally carries the pre-edit values of the
/// columns being changed so an adapter can include them in the predicate and
/// report a conflict when the row changed since it was read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowIdentity {
    /// Identity columns and their original values.
    pub keys: Vec<RowKey>,
    /// Original values of edited columns, used for stale-row detection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub original_values: Vec<RowKey>,
}

impl RowIdentity {
    /// Creates an identity from key columns and stale-check original values.
    pub fn new(keys: Vec<RowKey>, original_values: Vec<RowKey>) -> Self {
        Self {
            keys,
            original_values,
        }
    }

    /// Creates a single-column identity with no stale-check values.
    pub fn key(column: impl Into<String>, value: CellValue) -> Self {
        Self {
            keys: vec![RowKey::new(column, value)],
            original_values: Vec::new(),
        }
    }
}

/// A staged change to apply to a table row.
///
/// Variants carry identifiers and bound values only; no SQL text or raw
/// predicate is ever supplied by a caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingChange {
    /// Insert a row from column/value pairs.
    Insert {
        /// Columns and bound values for the new row.
        values: Vec<RowKey>,
    },
    /// Update the row identified by `identity` with `values`.
    Update {
        /// Stable identity of the row to update.
        identity: RowIdentity,
        /// Columns and bound replacement values.
        values: Vec<RowKey>,
    },
    /// Delete the row identified by `identity`.
    Delete {
        /// Stable identity of the row to delete.
        identity: RowIdentity,
    },
}

impl PendingChange {
    /// Creates an insert from column/value pairs.
    pub fn insert(values: Vec<RowKey>) -> Self {
        Self::Insert { values }
    }

    /// Creates an update for the identified row.
    pub fn update(identity: RowIdentity, values: Vec<RowKey>) -> Self {
        Self::Update { identity, values }
    }

    /// Creates a delete for the identified row.
    pub fn delete(identity: RowIdentity) -> Self {
        Self::Delete { identity }
    }
}

/// Terminal outcome of applying a [`PendingChange`].
///
/// `Conflict` is intentionally distinct from both success and failure: the
/// change did not overwrite a row that no longer matched the caller's identity
/// or original values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOutcome {
    /// The engine confirmed the change.
    Applied,
    /// No row matched the identity or the original values were stale, so
    /// nothing was overwritten.
    Conflict,
    /// The change failed; see the accompanying error.
    Failed,
    /// A transport failure left commit status unconfirmed. Never treat this as
    /// success or retry it automatically.
    OutcomeUnknown,
}

impl ChangeOutcome {
    /// Whether the engine definitively applied the change.
    pub const fn is_applied(self) -> bool {
        matches!(self, Self::Applied)
    }
}

/// Result of applying a [`PendingChange`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeResult {
    /// Stable identifier matching the originating request.
    pub operation_id: OperationId,
    /// Outcome of the change.
    pub outcome: ChangeOutcome,
    /// Rows affected when the change was applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affected_rows: Option<u64>,
    /// Columns whose original values no longer matched, when `outcome` is
    /// [`ChangeOutcome::Conflict`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicted_columns: Vec<String>,
    /// Normalized error for failed or uncertain outcomes. Must not contain
    /// secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
}

impl ChangeResult {
    /// Creates an applied result.
    pub fn applied(operation_id: impl Into<OperationId>, affected_rows: u64) -> Self {
        Self {
            operation_id: operation_id.into(),
            outcome: ChangeOutcome::Applied,
            affected_rows: Some(affected_rows),
            conflicted_columns: Vec::new(),
            error: None,
        }
    }

    /// Creates a stale-row/not-found conflict result.
    pub fn conflict(
        operation_id: impl Into<OperationId>,
        conflicted_columns: Vec<String>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            outcome: ChangeOutcome::Conflict,
            affected_rows: None,
            conflicted_columns,
            error: None,
        }
    }

    /// Creates a failed result.
    pub fn failed(operation_id: impl Into<OperationId>, error: QueryError) -> Self {
        Self {
            operation_id: operation_id.into(),
            outcome: ChangeOutcome::Failed,
            affected_rows: None,
            conflicted_columns: Vec::new(),
            error: Some(error),
        }
    }

    /// Creates a result whose write outcome could not be confirmed.
    pub fn outcome_unknown(operation_id: impl Into<OperationId>) -> Self {
        Self {
            operation_id: operation_id.into(),
            outcome: ChangeOutcome::OutcomeUnknown,
            affected_rows: None,
            conflicted_columns: Vec::new(),
            error: Some(QueryError::new(
                crate::domain::ErrorCategory::Transport,
                "the connection was lost before the write outcome could be confirmed",
            )),
        }
    }
}

/// A request to apply one staged change to a table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    /// Caller-supplied stable identifier echoed in the result.
    pub operation_id: OperationId,
    /// Table the change targets.
    pub object: ObjectRef,
    /// Staged change to apply.
    pub change: PendingChange,
}

impl ChangeRequest {
    /// Creates a request for one staged change.
    pub fn new(
        operation_id: impl Into<OperationId>,
        object: ObjectRef,
        change: PendingChange,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            object,
            change,
        }
    }
}

/// Normalized result of a connection test.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    /// Engine that accepted the connection.
    pub engine: EngineId,
    /// Server/driver version string when the engine reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
}

/// Outcome of a cancellation request.
///
/// Cancellation is a request, not proof that a server-side write was rolled
/// back. A `Requested` outcome only means the driver accepted the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    /// The cancellation request was delivered for a running operation.
    Requested,
    /// The operation was not running (already finished or never started).
    NotRunning,
}

/// Asynchronous contract implemented by every database engine adapter.
///
/// Implementations own their driver pools/connections internally and map the
/// opaque tokens in this module onto them. All methods are side-effect
/// reporting: a data-changing operation must never report success without the
/// driver confirming it, and must never be retried automatically when its
/// outcome is uncertain.
pub trait DatabaseAdapter: Send + Sync {
    /// Engine this adapter serves.
    fn engine(&self) -> EngineId;

    /// Capabilities actually available through this adapter's configuration.
    fn capabilities(&self) -> EngineCapabilities;

    /// Verifies that a descriptor and credential can reach the database without
    /// retaining a connection.
    fn test_connection<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionTest, QueryError>>;

    /// Opens a connection and returns its opaque handle.
    fn connect<'a>(
        &'a self,
        descriptor: &'a ConnectionDescriptor,
        secret: Option<&'a ConnectionSecret>,
    ) -> AdapterFuture<'a, Result<ConnectionId, QueryError>>;

    /// Closes a connection previously returned by [`DatabaseAdapter::connect`].
    fn disconnect<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>>;

    /// Reports the current state of a known connection.
    fn connection_state<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ConnectionState, QueryError>>;

    /// Lists tables and views in the requested scope.
    fn list_objects<'a>(
        &'a self,
        connection: &'a ConnectionId,
        scope: &'a ObjectScope,
    ) -> AdapterFuture<'a, Result<Vec<ObjectRef>, QueryError>>;

    /// Lists the database/catalog and schema scopes a connection can address.
    ///
    /// Adapters whose engine exposes neither return
    /// [`crate::domain::ErrorCategory::Unsupported`] so the UI can omit the
    /// scope picker rather than inventing names.
    fn list_scopes<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<ScopeListing, QueryError>>;

    /// Describes the columns, primary key, indexes, and constraints of a table
    /// or view.
    ///
    /// [`TableDescription::indexes`] and [`TableDescription::constraints`] are
    /// `None` when the adapter cannot inspect that category and `Some(vec![])`
    /// when it did and found none, so unsupported metadata is never presented
    /// as an empty success.
    fn describe_table<'a>(
        &'a self,
        connection: &'a ConnectionId,
        object: &'a ObjectRef,
    ) -> AdapterFuture<'a, Result<TableDescription, QueryError>>;

    /// Fetches one bounded page of rows with validated filter/sort inputs.
    ///
    /// The request carries identifiers and bound values separately; adapters
    /// must validate identifier columns against table metadata and bind the
    /// values rather than building predicates from caller-controlled text.
    fn fetch_table_page<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: TablePageRequest,
    ) -> AdapterFuture<'a, Result<TablePage, QueryError>>;

    /// Executes SQL and returns a normalized result.
    ///
    /// Completed operations (including failures) come back as `Ok(QueryResult)`
    /// carrying an [`crate::domain::OperationState`]; see the module docs.
    fn execute<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: QueryRequest,
    ) -> AdapterFuture<'a, Result<QueryResult, QueryError>>;

    /// Applies one parameterized insert/update/delete as a staged change.
    ///
    /// The change carries column identifiers and bound [`CellValue`]s only.
    /// Precondition failures that prevent a safe write (unknown connection, no
    /// safe row identity, an unknown column) return `Err(QueryError)` with a
    /// normalized category. Executed changes return `Ok(ChangeResult)` with an
    /// explicit [`ChangeOutcome`] so a stale-row [`ChangeOutcome::Conflict`] is
    /// never reported as applied.
    fn apply_change<'a>(
        &'a self,
        connection: &'a ConnectionId,
        request: ChangeRequest,
    ) -> AdapterFuture<'a, Result<ChangeResult, QueryError>>;

    /// Requests cancellation of a running operation.
    ///
    /// Adapters whose capability set reports `cancellation = false` return an
    /// `Unsupported` error rather than silently ignoring the request.
    fn cancel<'a>(
        &'a self,
        connection: &'a ConnectionId,
        operation: &'a OperationId,
    ) -> AdapterFuture<'a, Result<CancelOutcome, QueryError>>;

    /// Begins an explicit transaction when the engine supports transactions.
    fn begin_transaction<'a>(
        &'a self,
        connection: &'a ConnectionId,
    ) -> AdapterFuture<'a, Result<TransactionId, QueryError>>;

    /// Commits an explicit transaction.
    fn commit<'a>(
        &'a self,
        connection: &'a ConnectionId,
        transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>>;

    /// Rolls back an explicit transaction.
    fn rollback<'a>(
        &'a self,
        connection: &'a ConnectionId,
        transaction: &'a TransactionId,
    ) -> AdapterFuture<'a, Result<(), QueryError>>;
}

#[cfg(test)]
mod tests {
    use super::{
        build_filter_clause, build_order_clause, build_table_page_query, column_position,
        effective_sort_order, effective_table_page_limit, quote_identifier,
        quote_identifier_backtick, sort_direction_sql, validate_filter_values, CancelOutcome,
        ChangeOutcome, ChangeRequest, ChangeResult, ConnectionId, ConnectionSecret,
        ConnectionState, ConstraintInfo, FilterOperator, IndexInfo, ObjectKind, ObjectRef,
        PendingChange, RowIdentity, RowKey, ScopeListing, SortDirection, SortKey, TableDescription,
        TableFilter, TablePage, TablePageRequest, TransactionId, MAX_TABLE_PAGE_ROWS,
    };
    use crate::domain::{CellValue, ColumnInfo, ErrorCategory, OperationId};

    #[test]
    fn connection_and_transaction_ids_serialize_as_plain_strings() {
        assert_eq!(
            serde_json::to_value(ConnectionId::new("conn-1")).expect("id should serialize"),
            serde_json::json!("conn-1")
        );
        assert_eq!(
            serde_json::to_value(TransactionId::new("tx-1")).expect("id should serialize"),
            serde_json::json!("tx-1")
        );
    }

    #[test]
    fn connection_secret_debug_output_is_redacted() {
        let secret = ConnectionSecret::new("hunter2-super-secret");
        let rendered = format!("{secret:?}");

        assert!(!rendered.contains("hunter2-super-secret"));
        assert!(rendered.contains("redacted"));
    }

    #[test]
    fn connection_states_use_snake_case_wire_values() {
        let cases = [
            (ConnectionState::Disconnected, "disconnected"),
            (ConnectionState::Connecting, "connecting"),
            (ConnectionState::Connected, "connected"),
            (ConnectionState::Failed, "failed"),
        ];

        for (state, expected) in cases {
            assert_eq!(
                serde_json::to_value(state).expect("state should serialize"),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn cancel_outcomes_use_snake_case_wire_values() {
        assert_eq!(
            serde_json::to_value(CancelOutcome::Requested).expect("outcome should serialize"),
            serde_json::json!("requested")
        );
        assert_eq!(
            serde_json::to_value(CancelOutcome::NotRunning).expect("outcome should serialize"),
            serde_json::json!("not_running")
        );
    }

    #[test]
    fn object_refs_serialize_with_optional_scope_fields() {
        let sqlite_object = ObjectRef {
            database: None,
            schema: None,
            name: "users".to_string(),
            kind: ObjectKind::Table,
        };
        let value =
            serde_json::to_value(&sqlite_object).expect("object ref should serialize");

        assert_eq!(value["name"], "users");
        assert_eq!(value["kind"], "table");
        assert!(value.get("database").is_none());
        assert!(value.get("schema").is_none());

        let postgres_object = ObjectRef {
            database: None,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            kind: ObjectKind::View,
        };
        let value =
            serde_json::to_value(&postgres_object).expect("object ref should serialize");
        assert_eq!(value["schema"], "public");
        assert_eq!(value["kind"], "view");
    }

    #[test]
    fn table_description_uses_camel_case_and_omits_empty_primary_key() {
        let description = TableDescription::new(vec![ColumnInfo::named("id")], Vec::new());
        let value =
            serde_json::to_value(&description).expect("description should serialize");

        assert_eq!(value["columns"][0]["name"], "id");
        assert!(value.get("primaryKeyColumns").is_none());
        assert!(
            value.get("indexes").is_none(),
            "an uninspected index list must be absent, not an empty success"
        );
        assert!(
            value.get("constraints").is_none(),
            "an uninspected constraint list must be absent, not an empty success"
        );
    }

    #[test]
    fn table_description_serializes_inspected_indexes_and_constraints() {
        let description = TableDescription::new(
            vec![ColumnInfo::named("id"), ColumnInfo::named("email")],
            vec!["id".to_string()],
        )
        .with_indexes(vec![
            IndexInfo::new("users_pkey", vec!["id".to_string()], true, true),
            IndexInfo::new("users_email_idx", vec!["email".to_string()], false, false),
        ])
        .with_constraints(vec![
            ConstraintInfo::primary_key("users_pkey", vec!["id".to_string()]),
            ConstraintInfo::unique("users_email_key", vec!["email".to_string()]),
            ConstraintInfo::foreign_key(
                "users_team_fkey",
                vec!["team_id".to_string()],
                None,
                "teams",
                vec!["id".to_string()],
            ),
            ConstraintInfo::check("users_email_check", "email <> ''"),
        ]);

        let value = serde_json::to_value(&description).expect("description should serialize");

        assert_eq!(value["primaryKeyColumns"][0], "id");
        assert_eq!(value["indexes"][0]["name"], "users_pkey");
        assert_eq!(value["indexes"][0]["unique"], true);
        assert_eq!(value["indexes"][0]["primary"], true);
        assert_eq!(value["indexes"][1]["columns"][0], "email");
        assert_eq!(value["constraints"][0]["kind"], "primary_key");
        assert_eq!(value["constraints"][1]["kind"], "unique");
        assert_eq!(value["constraints"][2]["kind"], "foreign_key");
        assert_eq!(value["constraints"][2]["referencedTable"], "teams");
        assert_eq!(value["constraints"][2]["referencedColumns"][0], "id");
        assert_eq!(value["constraints"][3]["kind"], "check");
        assert_eq!(value["constraints"][3]["definition"], "email <> ''");
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
    fn scope_listing_omits_empty_vectors_and_uses_camel_case_fields() {
        let listing = ScopeListing {
            databases: vec!["app".to_string()],
            schemas: Vec::new(),
        };
        let value = serde_json::to_value(&listing).expect("listing should serialize");

        assert_eq!(value["databases"][0], "app");
        assert!(value.get("schemas").is_none());
    }

    #[test]
    fn table_page_request_keeps_identifiers_separate_from_bound_values() {
        let request = TablePageRequest::new("page-1", users_object(), 25)
            .with_offset(50)
            .with_filters(vec![TableFilter {
                column: "name".to_string(),
                operator: FilterOperator::Equal,
                values: vec![CellValue::Text("alice".to_string())],
            }])
            .with_sort(vec![SortKey {
                column: "id".to_string(),
                direction: SortDirection::Descending,
            }]);

        let value = serde_json::to_value(&request).expect("request should serialize");

        assert_eq!(value["operationId"], "page-1");
        assert_eq!(value["offset"], 50);
        assert_eq!(value["limit"], 25);
        // The identifier is a distinct field from the bound value.
        assert_eq!(value["filters"][0]["column"], "name");
        assert_eq!(value["filters"][0]["operator"], "equal");
        assert_eq!(value["filters"][0]["values"][0]["value"], "alice");
        assert_eq!(value["sort"][0]["column"], "id");
        assert_eq!(value["sort"][0]["direction"], "descending");
    }

    #[test]
    fn pending_changes_serialize_column_identifiers_and_bound_values_without_sql() {
        let change = PendingChange::update(
            RowIdentity::new(
                vec![RowKey::new("id", CellValue::Integer(1))],
                vec![RowKey::new("name", CellValue::Text("alice".to_string()))],
            ),
            vec![RowKey::new("name", CellValue::Text("bob".to_string()))],
        );
        let request = ChangeRequest::new("chg-1", users_object(), change);

        let value = serde_json::to_value(&request).expect("request should serialize");
        let text = serde_json::to_string(&request).expect("request should serialize");

        assert_eq!(value["change"]["kind"], "update");
        assert_eq!(value["change"]["identity"]["keys"][0]["column"], "id");
        assert_eq!(value["change"]["identity"]["originalValues"][0]["column"], "name");
        assert_eq!(value["change"]["values"][0]["column"], "name");
        assert_eq!(value["change"]["values"][0]["value"]["type"], "text");
        assert_eq!(value["change"]["values"][0]["value"]["value"], "bob");
        // The contract must never carry caller-authored SQL.
        assert!(!text.to_lowercase().contains("sql"));
    }

    #[test]
    fn change_outcomes_use_snake_case_wire_values() {
        let cases = [
            (ChangeOutcome::Applied, "applied"),
            (ChangeOutcome::Conflict, "conflict"),
            (ChangeOutcome::Failed, "failed"),
            (ChangeOutcome::OutcomeUnknown, "outcome_unknown"),
        ];

        for (outcome, expected) in cases {
            assert_eq!(
                serde_json::to_value(outcome).expect("outcome should serialize"),
                serde_json::json!(expected)
            );
        }
        assert!(ChangeOutcome::Applied.is_applied());
        assert!(!ChangeOutcome::Conflict.is_applied());
    }

    #[test]
    fn change_result_constructors_set_explicit_outcomes() {
        let applied = ChangeResult::applied(OperationId::new("op"), 2);
        assert_eq!(applied.outcome, ChangeOutcome::Applied);
        assert_eq!(applied.affected_rows, Some(2));

        let conflict = ChangeResult::conflict(OperationId::new("op"), vec!["name".to_string()]);
        assert_eq!(conflict.outcome, ChangeOutcome::Conflict);
        assert_eq!(conflict.conflicted_columns, ["name"]);

        let unknown = ChangeResult::outcome_unknown(OperationId::new("op"));
        assert_eq!(unknown.outcome, ChangeOutcome::OutcomeUnknown);
        assert!(!unknown.outcome.is_applied());
        assert!(unknown.error.is_some());
    }

    #[test]
    fn page_ceiling_is_a_positive_bound() {
        assert!(MAX_TABLE_PAGE_ROWS > 0);
    }

    #[test]
    fn table_page_reports_whether_a_safe_row_identity_exists() {
        let page = TablePage {
            operation_id: OperationId::new("page"),
            columns: vec![ColumnInfo::named("id")],
            rows: Vec::new(),
            row_identity: vec!["id".to_string()],
            offset: 0,
            limit: 10,
            total_rows: None,
            truncated: false,
            next_offset: None,
        };
        assert!(page.has_row_identity());

        let mut no_identity = page.clone();
        no_identity.row_identity = Vec::new();
        assert!(!no_identity.has_row_identity());
    }

    #[test]
    fn identifier_quoting_escapes_embedded_quote_characters() {
        assert_eq!(quote_identifier("plain"), "\"plain\"");
        assert_eq!(quote_identifier("we\"ird"), "\"we\"\"ird\"");

        assert_eq!(quote_identifier_backtick("plain"), "`plain`");
        assert_eq!(quote_identifier_backtick("we`ird"), "`we``ird`");
    }

    #[test]
    fn column_position_matches_exact_names_only() {
        let columns = vec![ColumnInfo::named("id"), ColumnInfo::named("Name")];
        assert_eq!(column_position(&columns, "id"), Some(0));
        assert_eq!(column_position(&columns, "Name"), Some(1));
        assert_eq!(column_position(&columns, "name"), None);
        assert_eq!(column_position(&columns, "id = 1"), None);
    }

    #[test]
    fn build_filter_clause_quotes_identifiers_and_collects_bound_values() {
        let columns = vec![ColumnInfo::named("id"), ColumnInfo::named("name")];
        let filters = vec![
            TableFilter {
                column: "name".to_string(),
                operator: FilterOperator::Equal,
                values: vec![CellValue::Text("bob".to_string())],
            },
            TableFilter {
                column: "id".to_string(),
                operator: FilterOperator::In,
                values: vec![CellValue::Integer(1), CellValue::Integer(3)],
            },
        ];

        let (clause, values) =
            build_filter_clause(&filters, &columns, |_| "?".to_string(), quote_identifier)
                .expect("valid filters should build");

        assert_eq!(clause, "\"name\" = ? AND \"id\" IN (?, ?)");
        assert_eq!(
            values,
            vec![
                CellValue::Text("bob".to_string()),
                CellValue::Integer(1),
                CellValue::Integer(3),
            ]
        );
    }

    #[test]
    fn build_filter_clause_numbers_placeholders_across_filters() {
        let columns = vec![ColumnInfo::named("id"), ColumnInfo::named("name")];
        let filters = vec![
            TableFilter {
                column: "id".to_string(),
                operator: FilterOperator::GreaterThanOrEqual,
                values: vec![CellValue::Integer(2)],
            },
            TableFilter {
                column: "name".to_string(),
                operator: FilterOperator::Like,
                values: vec![CellValue::Text("%a%".to_string())],
            },
        ];

        let (clause, values) = build_filter_clause(
            &filters,
            &columns,
            |position| format!("${position}"),
            quote_identifier,
        )
        .expect("valid filters should build");

        assert_eq!(clause, "\"id\" >= $1 AND \"name\" LIKE $2");
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn build_filter_clause_supports_null_checks_without_values() {
        let columns = vec![ColumnInfo::named("name")];
        let filters = vec![
            TableFilter {
                column: "name".to_string(),
                operator: FilterOperator::IsNull,
                values: Vec::new(),
            },
            TableFilter {
                column: "name".to_string(),
                operator: FilterOperator::IsNotNull,
                values: Vec::new(),
            },
        ];

        let (clause, values) =
            build_filter_clause(&filters, &columns, |_| "?".to_string(), quote_identifier)
                .expect("null checks should build");

        assert_eq!(clause, "\"name\" IS NULL AND \"name\" IS NOT NULL");
        assert!(values.is_empty());
    }

    #[test]
    fn build_filter_clause_rejects_unknown_identifiers_and_bad_cardinality() {
        let columns = vec![ColumnInfo::named("id")];

        let unknown = vec![TableFilter {
            column: "id = 1".to_string(),
            operator: FilterOperator::Equal,
            values: vec![CellValue::Integer(1)],
        }];
        let error =
            build_filter_clause(&unknown, &columns, |_| "?".to_string(), quote_identifier)
                .expect_err("an unknown identifier must be rejected");
        assert_eq!(error.category, ErrorCategory::Validation);

        let bad_cardinality = vec![TableFilter {
            column: "id".to_string(),
            operator: FilterOperator::Equal,
            values: Vec::new(),
        }];
        let error = build_filter_clause(
            &bad_cardinality,
            &columns,
            |_| "?".to_string(),
            quote_identifier,
        )
        .expect_err("a missing value must be rejected");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn validate_filter_values_enforces_cardinality_per_operator() {
        let filter = |operator, count| TableFilter {
            column: "id".to_string(),
            operator,
            values: vec![CellValue::Integer(1); count],
        };

        assert!(validate_filter_values(&filter(FilterOperator::Equal, 1)).is_ok());
        assert!(validate_filter_values(&filter(FilterOperator::Equal, 0)).is_err());
        assert!(validate_filter_values(&filter(FilterOperator::Like, 2)).is_err());
        assert!(validate_filter_values(&filter(FilterOperator::In, 0)).is_err());
        assert!(validate_filter_values(&filter(FilterOperator::In, 3)).is_ok());
        assert!(validate_filter_values(&filter(FilterOperator::IsNull, 0)).is_ok());
        assert!(validate_filter_values(&filter(FilterOperator::IsNull, 1)).is_err());
    }

    #[test]
    fn effective_sort_appends_missing_identity_columns_as_tie_breakers() {
        let identity = vec!["id".to_string(), "tenant".to_string()];

        let requested = vec![SortKey {
            column: "name".to_string(),
            direction: SortDirection::Descending,
        }];
        let effective = effective_sort_order(&requested, &identity);
        assert_eq!(effective.len(), 3);
        assert_eq!(effective[0].column, "name");
        assert_eq!(effective[0].direction, SortDirection::Descending);
        assert_eq!(effective[1].column, "id");
        assert_eq!(effective[1].direction, SortDirection::Ascending);
        assert_eq!(effective[2].column, "tenant");

        // A sort that already names an identity column is not duplicated.
        let requested = vec![SortKey {
            column: "id".to_string(),
            direction: SortDirection::Ascending,
        }];
        let effective = effective_sort_order(&requested, &identity);
        assert_eq!(effective.len(), 2);
        assert_eq!(effective[0].column, "id");
        assert_eq!(effective[1].column, "tenant");
    }

    #[test]
    fn build_order_clause_quotes_columns_and_directions() {
        let order = vec![
            SortKey {
                column: "id".to_string(),
                direction: SortDirection::Descending,
            },
            SortKey {
                column: "name".to_string(),
                direction: SortDirection::Ascending,
            },
        ];

        assert_eq!(
            build_order_clause(&order, quote_identifier),
            "\"id\" DESC, \"name\" ASC"
        );
        assert_eq!(sort_direction_sql(SortDirection::Ascending), "ASC");
        assert_eq!(sort_direction_sql(SortDirection::Descending), "DESC");
        assert!(build_order_clause(&[], quote_identifier).is_empty());
    }

    #[test]
    fn effective_table_page_limit_rejects_zero_and_clamps_to_the_ceiling() {
        assert_eq!(effective_table_page_limit(25), Ok(25));
        assert_eq!(
            effective_table_page_limit(MAX_TABLE_PAGE_ROWS + 1),
            Ok(MAX_TABLE_PAGE_ROWS)
        );

        let error = effective_table_page_limit(0).expect_err("zero is not a valid page size");
        assert_eq!(error.category, ErrorCategory::Validation);
    }

    #[test]
    fn table_page_query_composes_projection_where_order_and_window() {
        let columns = vec![ColumnInfo::named("id"), ColumnInfo::named("name")];
        let filters = vec![TableFilter {
            column: "name".to_string(),
            operator: FilterOperator::Like,
            values: vec![CellValue::Text("a%".to_string())],
        }];
        let order = vec![SortKey {
            column: "id".to_string(),
            direction: SortDirection::Descending,
        }];

        let (sql, values) = build_table_page_query(
            "\"users\"",
            &columns,
            &filters,
            &order,
            25,
            50,
            |_| "?".to_string(),
            quote_identifier,
        )
        .expect("a valid page query should build");

        assert_eq!(
            sql,
            "SELECT \"id\", \"name\" FROM \"users\" WHERE \"name\" LIKE ? \
             ORDER BY \"id\" DESC LIMIT 25 OFFSET 50"
        );
        assert_eq!(values, vec![CellValue::Text("a%".to_string())]);
    }

    #[test]
    fn table_page_query_omits_empty_clauses_and_never_inlines_values() {
        let columns = vec![ColumnInfo::named("id")];
        let (sql, values) = build_table_page_query(
            "\"users\"",
            &columns,
            &[],
            &[],
            10,
            0,
            |position| format!("${position}"),
            quote_identifier,
        )
        .expect("an unfiltered page query should build");

        assert_eq!(sql, "SELECT \"id\" FROM \"users\" LIMIT 10 OFFSET 0");
        assert!(values.is_empty());
    }

    #[test]
    fn table_page_query_rejects_unknown_sort_identifiers() {
        let columns = vec![ColumnInfo::named("id")];
        let order = vec![SortKey {
            column: "id); DROP TABLE users; --".to_string(),
            direction: SortDirection::Ascending,
        }];

        let error = build_table_page_query(
            "\"users\"",
            &columns,
            &[],
            &order,
            10,
            0,
            |_| "?".to_string(),
            quote_identifier,
        )
        .expect_err("an unknown sort column must be rejected before quoting");
        assert_eq!(error.category, ErrorCategory::Validation);
    }
}
