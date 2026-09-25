use crate::application::status::{
    app_status as build_app_status, AppStatusRequest, AppStatusResponse,
};

/// Thin Tauri command: deserialize the typed request, delegate to the
/// application function, and return the normalized response.
#[tauri::command]
pub fn app_status(request: AppStatusRequest) -> AppStatusResponse {
    build_app_status(request)
}
