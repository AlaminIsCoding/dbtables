/// Product name, used as the desktop window title and in diagnostics.
pub const APP_NAME: &str = "dbtables";

/// Starts the desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
