use serde::{Deserialize, Serialize};

use super::errors::QueryError;

/// Stable identifier for a long-running operation (query, metadata fetch, or
/// table mutation).
///
/// The identifier is minted once and echoed through every state update so the
/// UI can track an operation without creating duplicates. Serialized as a plain
/// string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperationId(String);

impl OperationId {
    /// Wraps an identifier string.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrows the identifier as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for OperationId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for OperationId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl std::fmt::Display for OperationId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// State of a long-running operation.
///
/// Serialized values are lower-case `snake_case`. `OutcomeUnknown` represents a
/// transport/disconnect failure during a write where commit status cannot be
/// confirmed; callers must not treat it as success or retry it automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    /// Accepted but not yet started.
    Queued,
    /// Currently executing.
    Running,
    /// Completed successfully.
    Succeeded,
    /// Completed with an error.
    Failed,
    /// Cancelled before completion.
    Cancelled,
    /// The write may or may not have committed.
    OutcomeUnknown,
}

impl OperationState {
    /// Whether no further state updates are expected.
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::OutcomeUnknown
        )
    }

    /// Whether the operation is definitively confirmed as successful.
    ///
    /// `OutcomeUnknown` is intentionally not success.
    pub const fn is_success(self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

/// Normalized scalar value used for result cells and bound query parameters.
///
/// Variants are JSON-friendly tagged objects (`{"type":"integer","value":42}`)
/// so no driver-native value objects cross the IPC boundary. Adapters should
/// map temporal/UUID/structured values to `Text` and exact numerics to
/// `Decimal`; note that `Integer(i64)` values beyond JavaScript's safe integer
/// range should be exposed as `Decimal` text to avoid precision loss.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CellValue {
    /// SQL `NULL`.
    Null,
    /// Boolean value.
    Boolean(bool),
    /// 64-bit signed integer.
    Integer(i64),
    /// Floating-point value.
    Float(f64),
    /// Exact numeric value preserved as text (for example, `NUMERIC`/`DECIMAL`).
    Decimal(String),
    /// Text value.
    Text(String),
    /// Binary value as raw bytes; JSON serializes this as an array of numbers.
    Bytes(Vec<u8>),
}

/// A single result row, one cell per column.
pub type Row = Vec<CellValue>;

/// Normalized column metadata for a query result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    /// Column label as returned by the engine.
    pub name: String,
    /// Engine-reported type name, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    /// Whether the column is nullable; `None` when the engine does not report it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
}

impl ColumnInfo {
    /// Creates column metadata with only a name.
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            type_name: None,
            nullable: None,
        }
    }
}

/// A request to execute SQL through an adapter.
///
/// The connection itself is supplied to the adapter separately; this request
/// carries only the SQL, optional bound parameters, and the result bound. It
/// must never contain credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    /// Caller-supplied stable identifier echoed in the result and state updates.
    pub operation_id: OperationId,
    /// SQL text to execute.
    pub sql: String,
    /// Bound parameter values, in placeholder order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<CellValue>,
    /// Optional maximum number of rows to return.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rows: Option<u32>,
}

impl QueryRequest {
    /// Creates a request with no parameters and no row bound.
    pub fn new(operation_id: impl Into<OperationId>, sql: impl Into<String>) -> Self {
        Self {
            operation_id: operation_id.into(),
            sql: sql.into(),
            parameters: Vec::new(),
            max_rows: None,
        }
    }

    /// Adds bound parameter values.
    pub fn with_parameters(mut self, parameters: Vec<CellValue>) -> Self {
        self.parameters = parameters;
        self
    }

    /// Sets the maximum number of rows to return.
    pub fn with_max_rows(mut self, max_rows: u32) -> Self {
        self.max_rows = Some(max_rows);
        self
    }
}

/// Normalized outcome of a query or operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    /// Stable identifier matching the originating request.
    pub operation_id: OperationId,
    /// Terminal (or, for streamed updates, current) operation state.
    pub state: OperationState,
    /// Result column metadata.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<ColumnInfo>,
    /// Returned rows; empty for non-row results or when nothing was returned.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rows: Vec<Row>,
    /// Number of rows affected by a DML statement, when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affected_rows: Option<u64>,
    /// Execution duration in milliseconds, when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Whether the result was cut off by a row cap or adapter limit.
    #[serde(default)]
    pub truncated: bool,
    /// Normalized error when `state` is `failed` or `outcome_unknown`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
}

impl QueryResult {
    fn empty(operation_id: OperationId, state: OperationState) -> Self {
        Self {
            operation_id,
            state,
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: None,
            duration_ms: None,
            truncated: false,
            error: None,
        }
    }

    /// Creates a successful result with no rows or columns.
    pub fn succeeded(operation_id: impl Into<OperationId>) -> Self {
        Self::empty(operation_id.into(), OperationState::Succeeded)
    }

    /// Creates a failed result carrying a normalized error.
    pub fn failed(operation_id: impl Into<OperationId>, error: QueryError) -> Self {
        let mut result = Self::empty(operation_id.into(), OperationState::Failed);
        result.error = Some(error);
        result
    }

    /// Creates a cancelled result.
    pub fn cancelled(operation_id: impl Into<OperationId>) -> Self {
        Self::empty(operation_id.into(), OperationState::Cancelled)
    }

    /// Creates a result whose write outcome could not be confirmed.
    pub fn outcome_unknown(operation_id: impl Into<OperationId>) -> Self {
        Self::empty(operation_id.into(), OperationState::OutcomeUnknown)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CellValue, ColumnInfo, OperationId, OperationState, QueryRequest, QueryResult, Row,
    };
    use crate::domain::errors::{ErrorCategory, QueryError};

    #[test]
    fn operation_id_serializes_as_a_plain_string() {
        let id = OperationId::new("op-123");

        assert_eq!(id.as_str(), "op-123");
        assert_eq!(id.to_string(), "op-123");
        assert_eq!(
            serde_json::to_value(&id).expect("operation id should serialize"),
            serde_json::json!("op-123")
        );
    }

    #[test]
    fn operation_states_use_snake_case_wire_values() {
        let cases = [
            (OperationState::Queued, "queued"),
            (OperationState::Running, "running"),
            (OperationState::Succeeded, "succeeded"),
            (OperationState::Failed, "failed"),
            (OperationState::Cancelled, "cancelled"),
            (OperationState::OutcomeUnknown, "outcome_unknown"),
        ];

        for (state, expected) in cases {
            assert_eq!(
                serde_json::to_value(state).expect("state should serialize"),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn terminal_and_success_states_are_distinct() {
        assert!(!OperationState::Queued.is_terminal());
        assert!(!OperationState::Running.is_terminal());
        assert!(OperationState::Succeeded.is_terminal());
        assert!(OperationState::Failed.is_terminal());
        assert!(OperationState::Cancelled.is_terminal());
        assert!(OperationState::OutcomeUnknown.is_terminal());

        assert!(OperationState::Succeeded.is_success());
        assert!(!OperationState::OutcomeUnknown.is_success());
        assert!(!OperationState::Cancelled.is_success());
        assert!(!OperationState::Failed.is_success());
    }

    #[test]
    fn cell_values_serialize_as_tagged_json_objects() {
        assert_eq!(
            serde_json::to_value(CellValue::Null).expect("null should serialize"),
            serde_json::json!({ "type": "null" })
        );
        assert_eq!(
            serde_json::to_value(CellValue::Boolean(true)).expect("boolean should serialize"),
            serde_json::json!({ "type": "boolean", "value": true })
        );
        assert_eq!(
            serde_json::to_value(CellValue::Integer(42)).expect("integer should serialize"),
            serde_json::json!({ "type": "integer", "value": 42 })
        );
        assert_eq!(
            serde_json::to_value(CellValue::Decimal("12.500".to_string()))
                .expect("decimal should serialize"),
            serde_json::json!({ "type": "decimal", "value": "12.500" })
        );
        assert_eq!(
            serde_json::to_value(CellValue::Bytes(vec![1, 2, 3]))
                .expect("bytes should serialize"),
            serde_json::json!({ "type": "bytes", "value": [1, 2, 3] })
        );
    }

    #[test]
    fn query_request_uses_camel_case_and_omits_empty_optional_fields() {
        let request = QueryRequest::new("op-1", "SELECT 1");

        let value = serde_json::to_value(&request).expect("request should serialize");

        assert_eq!(value["operationId"], "op-1");
        assert_eq!(value["sql"], "SELECT 1");
        assert!(value.get("parameters").is_none());
        assert!(value.get("maxRows").is_none());
    }

    #[test]
    fn query_request_includes_provided_parameters_and_bound() {
        let request = QueryRequest::new("op-2", "SELECT * FROM t WHERE id = ?")
            .with_parameters(vec![CellValue::Integer(7), CellValue::Text("x".to_string())])
            .with_max_rows(100);

        let value = serde_json::to_value(&request).expect("request should serialize");

        assert_eq!(value["parameters"][0]["type"], "integer");
        assert_eq!(value["parameters"][1]["value"], "x");
        assert_eq!(value["maxRows"], 100);
    }

    #[test]
    fn query_result_constructors_set_expected_state() {
        assert_eq!(
            QueryResult::succeeded("op").state,
            OperationState::Succeeded
        );
        assert_eq!(QueryResult::cancelled("op").state, OperationState::Cancelled);
        assert_eq!(
            QueryResult::outcome_unknown("op").state,
            OperationState::OutcomeUnknown
        );

        let error = QueryError::new(ErrorCategory::Syntax, "bad sql");
        let failed = QueryResult::failed("op", error.clone());
        assert_eq!(failed.state, OperationState::Failed);
        assert_eq!(failed.error, Some(error));
    }

    #[test]
    fn query_result_serializes_rows_and_error_with_camel_case_fields() {
        let mut result = QueryResult::succeeded("op-9");
        result.columns = vec![ColumnInfo::named("id")];
        let row: Row = vec![CellValue::Integer(1)];
        result.rows = vec![row];
        result.affected_rows = Some(1);
        result.duration_ms = Some(3);
        result.truncated = true;

        let value = serde_json::to_value(&result).expect("result should serialize");

        assert_eq!(value["operationId"], "op-9");
        assert_eq!(value["state"], "succeeded");
        assert_eq!(value["columns"][0]["name"], "id");
        assert_eq!(value["rows"][0][0]["value"], 1);
        assert_eq!(value["affectedRows"], 1);
        assert_eq!(value["durationMs"], 3);
        assert_eq!(value["truncated"], true);
        assert!(value.get("error").is_none());
    }
}
