import { invoke } from "@tauri-apps/api/core";

import type { ColumnInfo, CsvExportSummary, QueryResult, Row } from "../domain";

/** Keep the command name in sync with `src-tauri/src/commands/export.rs`. */
export const EXPORT_QUERY_CSV_COMMAND = "export_query_csv";

/**
 * Writes the loaded result rows to `path` as UTF-8 CSV.
 *
 * Only the bounded rows already held by the frontend are sent, so exporting
 * never triggers an eager full-result load. The backend owns escaping and
 * encoding and rejects with a normalized `QueryError` (for example, a
 * permission failure) rather than producing an incomplete file.
 */
export async function exportQueryCsv(
  path: string,
  result: QueryResult,
): Promise<CsvExportSummary> {
  return invoke<CsvExportSummary>(EXPORT_QUERY_CSV_COMMAND, {
    path,
    columns: (result.columns ?? []) as ColumnInfo[],
    rows: (result.rows ?? []) as Row[],
  });
}
