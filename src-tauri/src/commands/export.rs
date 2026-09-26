use std::path::PathBuf;

use crate::application::export::{self, CsvExportSummary};
use crate::domain::{ColumnInfo, QueryError, Row};

/// Writes a bounded query result to `path` as UTF-8 CSV.
///
/// The frontend sends only the rows it has already loaded, so the app never
/// eagerly materializes an unbounded result just to export it. The write is
/// explicit and is never retried: a file-system failure returns an actionable
/// normalized error instead of a silently incomplete file.
#[tauri::command]
pub async fn export_query_csv(
    path: String,
    columns: Vec<ColumnInfo>,
    rows: Vec<Row>,
) -> Result<CsvExportSummary, QueryError> {
    export::export_csv(&PathBuf::from(path), &columns, &rows)
}
