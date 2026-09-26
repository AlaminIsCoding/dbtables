//! CSV generation and export use cases.
//!
//! The backend owns CSV serialization so escaping rules and encoding are
//! consistent across engines and are covered by unit tests instead of being
//! reimplemented in the UI. The frontend sends only the bounded rows it has
//! already loaded; the file write happens here so a failure surfaces as an
//! actionable normalized error rather than a silently incomplete file.
//!
//! Format decisions:
//! - RFC 4180 quoting: a field is quoted when it contains the delimiter, a
//!   double quote, `\r`, or `\n`; embedded quotes are doubled.
//! - Records end with CRLF (`\r\n`) so spreadsheet tools detect the line
//!   boundaries predictably.
//! - SQL `NULL` is an empty, unquoted field. An empty string (or empty binary
//!   value) is written as `""` so the two cases remain distinguishable.
//! - Output is UTF-8 with a leading byte-order mark so spreadsheet applications
//!   detect the encoding and render non-ASCII text correctly.

use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::domain::{CellValue, ColumnInfo, ErrorCategory, QueryError, Row};

/// UTF-8 byte-order mark written at the start of every exported file.
pub const CSV_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Record separator between CSV lines.
const CRLF: &str = "\r\n";

/// Normalized outcome of a successful CSV export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvExportSummary {
    /// Path the file was written to, as supplied by the caller.
    pub path: String,
    /// Data rows written, excluding the header.
    pub rows: u64,
    /// Columns written.
    pub columns: u64,
    /// Bytes written, including the UTF-8 byte-order mark.
    pub bytes_written: u64,
}

/// Canonical CSV text for a cell, or `None` for SQL `NULL`.
///
/// Bytes are written as unpadded lowercase hex, matching the grid's copy
/// behavior. Floats use Rust's shortest round-trippable representation.
fn nullable_text(value: &CellValue) -> Option<String> {
    match value {
        CellValue::Null => None,
        CellValue::Boolean(value) => Some(if *value { "true" } else { "false" }.to_string()),
        CellValue::Integer(value) => Some(value.to_string()),
        CellValue::Float(value) => Some(value.to_string()),
        CellValue::Decimal(value) | CellValue::Text(value) => Some(value.clone()),
        CellValue::Bytes(bytes) => Some(
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        ),
    }
}

/// Applies RFC 4180 quoting to a non-null field.
///
/// An empty string is written as `""` rather than an empty field so it is not
/// confused with `NULL`.
fn escape_field(text: &str) -> String {
    if text.is_empty() {
        return "\"\"".to_string();
    }

    let needs_quotes = text.contains(|character| matches!(character, ',' | '"' | '\r' | '\n'));

    if !needs_quotes {
        return text.to_string();
    }

    let mut escaped = String::with_capacity(text.len() + 2);
    escaped.push('"');
    for character in text.chars() {
        if character == '"' {
            escaped.push('"');
        }
        escaped.push(character);
    }
    escaped.push('"');
    escaped
}

/// Serializes one normalized cell to a CSV field.
pub fn csv_field(value: &CellValue) -> String {
    match nullable_text(value) {
        None => String::new(),
        Some(text) => escape_field(&text),
    }
}

/// Serializes a normalized result to CSV text (without the byte-order mark).
///
/// Rows are padded with `NULL` when they are shorter than the header so the
/// export always has a consistent column count.
pub fn to_csv(columns: &[ColumnInfo], rows: &[Row]) -> String {
    let mut output = String::new();

    let header = columns
        .iter()
        .map(|column| escape_field(&column.name))
        .collect::<Vec<_>>()
        .join(",");
    output.push_str(&header);
    output.push_str(CRLF);

    for row in rows {
        let line = (0..columns.len())
            .map(|index| {
                row.get(index)
                    .map(csv_field)
                    .unwrap_or_else(|| csv_field(&CellValue::Null))
            })
            .collect::<Vec<_>>()
            .join(",");
        output.push_str(&line);
        output.push_str(CRLF);
    }

    output
}

/// Writes `contents` to `path`, returning the number of bytes written.
///
/// File-system failures are mapped to actionable normalized errors: a missing
/// folder and a directory path are `validation`, a permission failure is
/// `permission`, and anything else is `internal`. The underlying OS message is
/// preserved as engine detail for diagnostics.
pub fn write_csv(path: &Path, contents: &[u8]) -> Result<u64, QueryError> {
    std::fs::write(path, contents).map_err(|error| write_error(path, &error))?;
    Ok(contents.len() as u64)
}

fn write_error(path: &Path, error: &std::io::Error) -> QueryError {
    let (category, message) = match error.kind() {
        ErrorKind::NotFound => (
            ErrorCategory::Validation,
            format!(
                "the folder for `{}` does not exist; create it or choose another path",
                path.display()
            ),
        ),
        ErrorKind::PermissionDenied => (
            ErrorCategory::Permission,
            format!(
                "permission was denied writing `{}`; choose another location or close the file if it is open",
                path.display()
            ),
        ),
        ErrorKind::IsADirectory => (
            ErrorCategory::Validation,
            format!("`{}` is a directory, not a file path", path.display()),
        ),
        _ => (
            ErrorCategory::Internal,
            format!("could not write the CSV file at `{}`", path.display()),
        ),
    };

    QueryError::new(category, message).with_engine_detail(error.to_string())
}

/// Generates and writes a CSV export of a bounded result.
///
/// Returns `validation` errors for an empty path or a result with no columns,
/// and an actionable write error when the file cannot be created.
pub fn export_csv(
    path: &Path,
    columns: &[ColumnInfo],
    rows: &[Row],
) -> Result<CsvExportSummary, QueryError> {
    if path.as_os_str().is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "enter a file path to export to",
        ));
    }

    if columns.is_empty() {
        return Err(QueryError::new(
            ErrorCategory::Validation,
            "the current result has no columns to export",
        ));
    }

    let csv = to_csv(columns, rows);
    let mut bytes = Vec::with_capacity(CSV_BOM.len() + csv.len());
    bytes.extend_from_slice(CSV_BOM);
    bytes.extend_from_slice(csv.as_bytes());

    let bytes_written = write_csv(path, &bytes)?;

    Ok(CsvExportSummary {
        path: path.to_string_lossy().into_owned(),
        rows: rows.len() as u64,
        columns: columns.len() as u64,
        bytes_written,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{csv_field, export_csv, to_csv, write_csv, CsvExportSummary, CSV_BOM};
    use crate::domain::{CellValue, ColumnInfo, ErrorCategory};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_path(name: &str) -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dbtables-export-{nanos}-{counter}"));
        fs::create_dir_all(&dir).expect("temp directory should be created");
        dir.join(name)
    }

    fn text(value: &str) -> CellValue {
        CellValue::Text(value.to_string())
    }

    #[test]
    fn nulls_are_empty_fields_and_empty_text_is_quoted() {
        assert_eq!(csv_field(&CellValue::Null), "");
        assert_eq!(csv_field(&text("")), "\"\"");
        assert_eq!(csv_field(&CellValue::Bytes(Vec::new())), "\"\"");
    }

    #[test]
    fn delimiters_quotes_and_newlines_are_escaped() {
        assert_eq!(csv_field(&text("a,b")), "\"a,b\"");
        assert_eq!(csv_field(&text("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field(&text("line1\nline2")), "\"line1\nline2\"");
        assert_eq!(csv_field(&text("line1\r\nline2")), "\"line1\r\nline2\"");
        assert_eq!(csv_field(&text("plain")), "plain");
    }

    #[test]
    fn scalar_values_use_canonical_text() {
        assert_eq!(csv_field(&CellValue::Boolean(true)), "true");
        assert_eq!(csv_field(&CellValue::Integer(-7)), "-7");
        assert_eq!(csv_field(&CellValue::Float(1.5)), "1.5");
        assert_eq!(
            csv_field(&CellValue::Decimal("12.500".to_string())),
            "12.500"
        );
        assert_eq!(csv_field(&CellValue::Bytes(vec![0x0a, 0xff])), "0aff");
    }

    #[test]
    fn to_csv_writes_a_header_and_crlf_terminated_rows() {
        let columns = vec![ColumnInfo::named("id"), ColumnInfo::named("name")];
        let rows = vec![
            vec![CellValue::Integer(1), text("alice")],
            vec![CellValue::Null, text("")],
        ];

        let csv = to_csv(&columns, &rows);

        assert_eq!(
            csv, "id,name\r\n1,alice\r\n,\"\"\r\n",
            "null stays empty while an empty string is quoted"
        );
    }

    #[test]
    fn to_csv_escapes_headers_and_short_rows() {
        let columns = vec![ColumnInfo::named("weird,name"), ColumnInfo::named("b")];
        let rows = vec![vec![text("x")]];

        let csv = to_csv(&columns, &rows);

        assert_eq!(csv, "\"weird,name\",b\r\nx,\r\n");
    }

    #[test]
    fn to_csv_preserves_non_ascii_text() {
        let columns = vec![ColumnInfo::named("greeting")];
        let rows = vec![vec![text("héllo 世界")]];

        let csv = to_csv(&columns, &rows);

        assert_eq!(csv, "greeting\r\nhéllo 世界\r\n");
    }

    #[test]
    fn export_csv_writes_utf8_with_a_bom_and_returns_a_summary() {
        let path = temp_path("results.csv");
        let columns = vec![ColumnInfo::named("id"), ColumnInfo::named("name")];
        let rows = vec![vec![CellValue::Integer(1), text("alice")]];

        let summary = export_csv(&path, &columns, &rows).expect("export should succeed");
        let written = fs::read(&path).expect("exported file should be readable");

        assert_eq!(
            summary,
            CsvExportSummary {
                path: path.to_string_lossy().into_owned(),
                rows: 1,
                columns: 2,
                bytes_written: written.len() as u64,
            }
        );
        assert!(written.starts_with(CSV_BOM), "file should start with a BOM");
        assert_eq!(
            String::from_utf8(written[CSV_BOM.len()..].to_vec()).expect("body should be UTF-8"),
            "id,name\r\n1,alice\r\n"
        );

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn export_csv_exports_headers_for_an_empty_result() {
        let path = temp_path("empty.csv");
        let columns = vec![ColumnInfo::named("id")];

        let summary = export_csv(&path, &columns, &[]).expect("empty result should still export");

        assert_eq!(summary.rows, 0);
        let written = fs::read(&path).expect("exported file should be readable");
        assert_eq!(
            String::from_utf8(written[CSV_BOM.len()..].to_vec()).unwrap(),
            "id\r\n"
        );

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn export_csv_rejects_an_empty_path_or_no_columns() {
        let empty_path = export_csv(std::path::Path::new(""), &[ColumnInfo::named("id")], &[])
            .expect_err("an empty path must be rejected");
        assert_eq!(empty_path.category, ErrorCategory::Validation);

        let path = temp_path("no-columns.csv");
        let no_columns = export_csv(&path, &[], &[]).expect_err("missing columns must be rejected");
        assert_eq!(no_columns.category, ErrorCategory::Validation);
        assert!(!path.exists(), "a rejected export must not create a file");

        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn write_csv_reports_a_missing_folder_as_actionable_validation() {
        let missing = std::env::temp_dir()
            .join("dbtables-export-missing-folder")
            .join("nested")
            .join("out.csv");

        let error = write_csv(&missing, b"x").expect_err("missing folder should fail");

        assert_eq!(error.category, ErrorCategory::Validation);
        assert!(
            error.message.contains("does not exist"),
            "message should explain the missing folder: {}",
            error.message
        );
        assert!(error.message.contains("out.csv"));
    }

    #[test]
    fn write_csv_reports_a_directory_target_as_validation() {
        let directory = temp_path("a-directory");
        fs::create_dir_all(&directory).expect("directory should be created");

        let error = write_csv(&directory, b"x").expect_err("writing a directory should fail");
        assert!(
            matches!(
                error.category,
                ErrorCategory::Validation | ErrorCategory::Permission
            ),
            "directory target should be an actionable error, got {:?}",
            error.category
        );
        assert!(error.message.contains("a-directory"));

        fs::remove_dir_all(directory.parent().unwrap()).ok();
    }
}
