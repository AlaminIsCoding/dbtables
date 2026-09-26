import { invoke } from "@tauri-apps/api/core";

import type {
  CancelOutcome,
  EngineCapabilities,
  QueryRequest,
  QueryResult,
} from "../domain";

/** Keep command names in sync with `src-tauri/src/commands/queries.rs`. */
export const EXECUTE_QUERY_COMMAND = "execute_query";
export const CANCEL_QUERY_COMMAND = "cancel_query";
export const QUERY_CAPABILITIES_COMMAND = "query_capabilities";

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

/**
 * Requests cancellation of a running operation.
 *
 * Cancellation is a request, not proof of the final outcome: a `requested`
 * result only means the driver accepted it. The operation's own result reports
 * whether it succeeded, failed, was cancelled, or ended uncertainly. Adapters
 * without cancellation capability reject with an `unsupported` `QueryError`.
 */
export async function cancelQuery(
  connectionId: string,
  operationId: string,
): Promise<CancelOutcome> {
  return invoke<CancelOutcome>(CANCEL_QUERY_COMMAND, {
    connectionId,
    operationId,
  });
}

/**
 * Reports the driver capabilities for a connection's engine.
 *
 * Capabilities are per-connection because each engine's adapter differs; the UI
 * uses this to gate engine-specific behavior such as cancellation instead of
 * assuming every engine supports it.
 */
export async function getQueryCapabilities(
  connectionId: string,
): Promise<EngineCapabilities> {
  return invoke<EngineCapabilities>(QUERY_CAPABILITIES_COMMAND, { connectionId });
}
