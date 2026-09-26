pub mod application;
pub mod commands;
pub mod database;
pub mod domain;
pub mod persistence;

use database::SqliteAdapter;

/// Product name, used as the desktop window title and in diagnostics.
pub const APP_NAME: &str = "dbtables";

/// Starts the desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The adapter owns the open connections for the process lifetime.
        // Tauri manages it so command handlers can share one registry without
        // exposing driver-native handles to the frontend.
        .manage(SqliteAdapter::new())
        .invoke_handler(tauri::generate_handler![
            commands::status::app_status,
            commands::connections::connect_sqlite,
            commands::connections::disconnect_connection,
            commands::connections::connection_state,
            commands::metadata::list_objects,
            commands::queries::execute_query,
            commands::queries::query_capabilities,
            commands::queries::cancel_query,
            commands::export::export_query_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the dbtables application");
}

#[cfg(test)]
mod tests {
    use super::APP_NAME;

    #[test]
    fn app_name_is_set() {
        assert_eq!(APP_NAME, "dbtables");
    }
}
