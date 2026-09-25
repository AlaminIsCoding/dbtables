use serde::{Deserialize, Serialize};

/// Typed request sent by the frontend `app_status` service.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatusRequest {
    /// Optional caller label, echoed back for round-trip visibility.
    #[serde(default)]
    pub requested_by: Option<String>,
}

/// Harmless status value returned by the sample command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatusResponse {
    /// Product name, shared with the window title and diagnostics.
    pub app: String,
    /// Status marker; always `ok` for this harmless sample.
    pub status: String,
    /// Human-readable status message.
    pub message: String,
}

/// Builds the sample status response without touching any external resource.
pub fn app_status(request: AppStatusRequest) -> AppStatusResponse {
    let message = match request.requested_by.as_deref() {
        Some(who) if !who.trim().is_empty() => {
            format!("{} backend is ready for {}.", crate::APP_NAME, who.trim())
        }
        _ => format!("{} backend is ready.", crate::APP_NAME),
    };

    AppStatusResponse {
        app: crate::APP_NAME.to_string(),
        status: "ok".to_string(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::{app_status, AppStatusRequest};

    #[test]
    fn returns_ok_status_without_a_caller() {
        let response = app_status(AppStatusRequest::default());

        assert_eq!(response.app, crate::APP_NAME);
        assert_eq!(response.status, "ok");
        assert_eq!(response.message, "dbtables backend is ready.");
    }

    #[test]
    fn echoes_a_trimmed_caller_label() {
        let response = app_status(AppStatusRequest {
            requested_by: Some("  contributor  ".to_string()),
        });

        assert_eq!(response.message, "dbtables backend is ready for contributor.");
    }

    #[test]
    fn ignores_blank_caller_labels() {
        let response = app_status(AppStatusRequest {
            requested_by: Some("   ".to_string()),
        });

        assert_eq!(response.message, "dbtables backend is ready.");
    }

    #[test]
    fn serializes_with_camel_case_fields() {
        let response = app_status(AppStatusRequest::default());
        let value = serde_json::to_value(&response).expect("response should serialize");

        assert_eq!(value["app"], "dbtables");
        assert_eq!(value["status"], "ok");
        assert_eq!(value["message"], "dbtables backend is ready.");
    }
}
