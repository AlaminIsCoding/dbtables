import { invoke } from "@tauri-apps/api/core";

import type { QueryRequest, QueryResult } from "../domain";

/** Keep the command name in sync with `src-tauri/src/commands/queries.rs`. */
export const EXECUTE_QUERY_COMMAND = "execute_query";

/**
 * Executes one SQL statement through the backend adapter.
 *
 * Completed outcomes (success, empty, failed) resolve with a normalized
 * {@link QueryResult}; only precondition failures reject with a `QueryError`.
 */
export async function executeQuery(
  connectionId: string,
  request: QueryRequest,
): Promise<QueryResult> {
  return invoke<QueryResult>(EXECUTE_QUERY_COMMAND, { connectionId, request });
}
