pub mod application;
pub mod commands;
pub mod database;
pub mod domain;
pub mod persistence;

use database::DatabaseState;
use application::profiles::ProfileService;
use persistence::{FileProfileRepository, KeyringSecretStore};
use std::sync::Arc;
use tauri::Manager;

/// Product name, used as the desktop window title and in diagnostics.
pub const APP_NAME: &str = "dbtables";

/// Starts the desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // File dialogs (SQLite open/create) are provided by the dialog plugin.
        .plugin(tauri_plugin_dialog::init())
        // The registry owns one adapter per engine and maps each open
        // connection to its engine. Tauri manages it so command handlers share
        // one router without exposing driver-native handles to the frontend.
        .manage(DatabaseState::new())
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let profiles = ProfileService::new(
                Arc::new(FileProfileRepository::new(settings_path)),
                Arc::new(KeyringSecretStore::with_default_service()),
            );
            app.manage(profiles);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::app_status,
            commands::connections::connect_sqlite,
            commands::connections::disconnect_connection,
            commands::connections::connection_state,
            commands::connections::list_connection_profiles,
            commands::connections::save_connection_profile,
            commands::connections::delete_connection_profile,
            commands::connections::test_connection_profile,
            commands::connections::connect_profile,
            commands::connections::connect_profile_database,
            commands::connections::list_profile_databases,
            commands::metadata::list_objects,
            commands::metadata::list_scopes,
            commands::metadata::describe_table,
            commands::queries::execute_query,
            commands::queries::query_capabilities,
            commands::queries::cancel_query,
            commands::table_data::fetch_table_page,
            commands::table_data::apply_table_changes,
            commands::schema::create_table,
            commands::schema::drop_table,
            commands::schema::add_column,
            commands::schema::rename_column,
            commands::schema::drop_column,
            commands::schema::alter_column,
            commands::schema::add_foreign_key,
            commands::schema::drop_foreign_key,
            commands::schema::create_index,
            commands::schema::drop_index,
            commands::schema::count_table_rows,
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
