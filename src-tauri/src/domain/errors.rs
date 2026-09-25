use serde::{Deserialize, Serialize};

/// Normalized category for a database or application error.
///
/// Adapters map driver-specific failures onto these categories so the UI can
/// react consistently. Serialized values are lower-case `snake_case`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    /// The server/file could not be reached.
    Connection,
    /// Credentials were rejected by the server.
    Authentication,
    /// The connection configuration or options are invalid or unsupported.
    Configuration,
    /// The SQL could not be parsed or prepared.
    Syntax,
    /// A request/field/value failed application-level validation.
    Validation,
    /// The current role/user lacks permission for the operation.
    Permission,
    /// A constraint (unique/foreign key/check/not-null) was violated.
    Constraint,
    /// A lock, deadlock, or serialization conflict blocked the operation.
    Locking,
    /// The operation exceeded a timeout.
    Timeout,
    /// The operation was cancelled.
    Cancelled,
    /// A transport-level failure occurred; completion may be unknown.
    Transport,
    /// The adapter does not support the requested capability.
    Unsupported,
    /// An unexpected internal application error.
    Internal,
}

impl ErrorCategory {
    /// Stable wire/diagnostic value for this category.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Connection => "connection",
            Self::Authentication => "authentication",
            Self::Configuration => "configuration",
            Self::Syntax => "syntax",
            Self::Validation => "validation",
            Self::Permission => "permission",
            Self::Constraint => "constraint",
            Self::Locking => "locking",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Transport => "transport",
            Self::Unsupported => "unsupported",
            Self::Internal => "internal",
        }
    }

    /// Whether an error category can leave a data-changing outcome uncertain.
    ///
    /// A transport failure may occur after the server committed a write but
    /// before the client received confirmation. Callers must not report success
    /// or retry automatically when this is `true`.
    pub const fn may_have_unknown_outcome(self) -> bool {
        matches!(self, Self::Transport)
    }
}

impl std::fmt::Display for ErrorCategory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Normalized error returned for a failed database operation.
///
/// `message` is a safe, user-facing explanation. `engine_detail` preserves the
/// engine's own message for diagnostics but must be redacted by the adapter so
/// it never contains credentials, tokens, or other secret material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryError {
    /// Normalized category for UI behavior and messaging.
    pub category: ErrorCategory,
    /// Safe user-facing summary. Must not contain secrets.
    pub message: String,
    /// Optional engine/provider error code (for example, a SQLSTATE value).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Optional redacted engine message for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_detail: Option<String>,
}

impl QueryError {
    /// Creates an error with a safe message and no diagnostic detail.
    pub fn new(category: ErrorCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
            code: None,
            engine_detail: None,
        }
    }

    /// Attaches an engine error code.
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }

    /// Attaches a redacted engine detail message for diagnostics.
    pub fn with_engine_detail(mut self, detail: impl Into<String>) -> Self {
        self.engine_detail = Some(detail.into());
        self
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.category, self.message)
    }
}

impl std::error::Error for QueryError {}

#[cfg(test)]
mod tests {
    use super::{ErrorCategory, QueryError};

    #[test]
    fn categories_use_snake_case_wire_values() {
        let cases = [
            (ErrorCategory::Connection, "connection"),
            (ErrorCategory::Authentication, "authentication"),
            (ErrorCategory::Configuration, "configuration"),
            (ErrorCategory::Syntax, "syntax"),
            (ErrorCategory::Validation, "validation"),
            (ErrorCategory::Permission, "permission"),
            (ErrorCategory::Constraint, "constraint"),
            (ErrorCategory::Locking, "locking"),
            (ErrorCategory::Timeout, "timeout"),
            (ErrorCategory::Cancelled, "cancelled"),
            (ErrorCategory::Transport, "transport"),
            (ErrorCategory::Unsupported, "unsupported"),
            (ErrorCategory::Internal, "internal"),
        ];

        for (category, expected) in cases {
            assert_eq!(category.as_str(), expected);
            assert_eq!(
                serde_json::to_value(category).expect("category should serialize"),
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn only_transport_failures_may_have_an_unknown_outcome() {
        assert!(ErrorCategory::Transport.may_have_unknown_outcome());
        assert!(!ErrorCategory::Constraint.may_have_unknown_outcome());
        assert!(!ErrorCategory::Connection.may_have_unknown_outcome());
    }

    #[test]
    fn query_error_serializes_with_camel_case_fields() {
        let error = QueryError::new(ErrorCategory::Constraint, "duplicate key value")
            .with_code("23505")
            .with_engine_detail("duplicate key value violates unique constraint");

        let value = serde_json::to_value(&error).expect("error should serialize");

        assert_eq!(value["category"], "constraint");
        assert_eq!(value["message"], "duplicate key value");
        assert_eq!(value["code"], "23505");
        assert_eq!(
            value["engineDetail"],
            "duplicate key value violates unique constraint"
        );
    }

    #[test]
    fn query_error_omits_absent_optional_fields() {
        let error = QueryError::new(ErrorCategory::Syntax, "near FROM: syntax error");

        let value = serde_json::to_value(&error).expect("error should serialize");

        assert!(value.get("code").is_none());
        assert!(value.get("engineDetail").is_none());
    }

    #[test]
    fn query_error_display_includes_category_and_message() {
        let error = QueryError::new(ErrorCategory::Permission, "permission denied");
        assert_eq!(error.to_string(), "permission: permission denied");
    }
}
