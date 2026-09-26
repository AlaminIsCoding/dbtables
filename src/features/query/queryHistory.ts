import type { ErrorCategory, OperationState, QueryError, QueryResult } from "../../domain";

/**
 * Bounded, local recent-query history.
 *
 * History is deliberately minimal and local to the running app: it stores the
 * SQL text that ran plus normalized outcome metadata. It never stores bound
 * parameters, connection settings, or credentials, and entries are only ever
 * appended in memory. Retention is bounded so a long session cannot grow it
 * without limit.
 */

/** Maximum number of history entries retained for one query session. */
export const MAX_QUERY_HISTORY = 20;

/** Terminal operation states that can be recorded in history. */
export type HistoryState = Extract<
  OperationState,
  "succeeded" | "failed" | "cancelled" | "outcome_unknown"
>;

/** One recorded query execution. */
export interface QueryHistoryEntry {
  /** Identifier of the originating operation. */
  id: string;
  /** SQL text that was executed. Never includes bound parameters or credentials. */
  sql: string;
  /** Terminal state of the run. */
  state: HistoryState;
  /** When the run finished, as an epoch-milliseconds timestamp. */
  at: number;
  /** Execution duration in milliseconds, when reported. */
  durationMs?: number;
  /** Rows affected by a non-row statement, when reported. */
  affectedRows?: number;
  /** Number of returned rows, when the result carried rows. */
  rows?: number;
  /** Normalized error category for a failed or uncertain run. */
  errorCategory?: ErrorCategory;
}

/** Whether an operation state is terminal and therefore recordable. */
export function isHistoryState(state: OperationState): state is HistoryState {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "outcome_unknown"
  );
}

/**
 * Prepends an entry and clamps the list to `max` entries.
 *
 * Newest entries are first; a `max` of zero (or less) keeps no history.
 */
export function prependHistoryEntry(
  entries: readonly QueryHistoryEntry[],
  entry: QueryHistoryEntry,
  max: number = MAX_QUERY_HISTORY,
): QueryHistoryEntry[] {
  if (max <= 0) {
    return [];
  }
  return [entry, ...entries].slice(0, max);
}

/**
 * Builds a history entry from a terminal normalized result.
 *
 * Returns `null` for a non-terminal result (`queued`/`running`), so an
 * in-flight run cannot be recorded before its outcome is confirmed. Only SQL
 * text and outcome metadata are copied; the result carries no credentials.
 */
export function historyEntryFromResult(
  id: string,
  sql: string,
  result: QueryResult,
  at: number = Date.now(),
): QueryHistoryEntry | null {
  if (!isHistoryState(result.state)) {
    return null;
  }

  return {
    id,
    sql,
    state: result.state,
    at,
    durationMs: result.durationMs,
    affectedRows: result.affectedRows,
    rows: result.rows?.length,
    errorCategory: result.error?.category,
  };
}

/** Builds a history entry for a command-level failure with no normalized result. */
export function historyEntryFromError(
  id: string,
  sql: string,
  error: QueryError,
  at: number = Date.now(),
): QueryHistoryEntry {
  return {
    id,
    sql,
    state: "failed",
    at,
    errorCategory: error.category,
  };
}
