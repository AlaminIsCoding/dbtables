import { invoke } from "@tauri-apps/api/core";

import type { TablePage, TablePageRequest } from "../domain";

/** Keep the command name in sync with `src-tauri/src/commands/table_data.rs`. */
export const FETCH_TABLE_PAGE_COMMAND = "fetch_table_page";

/**
 * Fetches one bounded, filtered, sorted page of a table or view.
 *
 * The request carries column identifiers and bound values separately; the
 * backend validates every identifier against table metadata and binds
 * comparison values, so no caller text becomes SQL. The returned page reports
 * the columns, the effective window, and the row identity the backend could
 * establish (absent when the object has no primary key or safe row identifier).
 */
export async function fetchTablePage(
  connectionId: string,
  request: TablePageRequest,
): Promise<TablePage> {
  return invoke<TablePage>(FETCH_TABLE_PAGE_COMMAND, {
    connectionId,
    request,
  });
}
