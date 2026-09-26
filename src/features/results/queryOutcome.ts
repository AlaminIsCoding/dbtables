import type { QueryError, QueryResult } from "../../domain";

/**
 * Fallback error for a failed result that arrives without a normalized error.
 *
 * A failed operation must never be rendered as successful, so the UI still has
 * something explainable to show.
 */
export const FALLBACK_QUERY_ERROR: QueryError = {
  category: "internal",
  message: "The query failed without a normalized error.",
};

/**
 * Everything the results pane needs to render one query outcome.
 *
 * `grid`, `empty`, and `statement` are all successful terminal results; they are
 * separated so the UI can distinguish a row-returning success from a statement
 * that only reports affected rows. `failed`/`error` are distinct: `failed` came
 * from a normalized {@link QueryResult}, while `error` is a command-level
 * failure such as a lost connection or an invalid cap.
 */
export type QueryOutcome =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "grid"; result: QueryResult }
  | { kind: "empty"; result: QueryResult }
  | { kind: "statement"; result: QueryResult }
  | { kind: "failed"; error: QueryError }
  | { kind: "error"; error: QueryError }
  | { kind: "cancelled" }
  | { kind: "outcome_unknown"; error?: QueryError };

/** The initial outcome before any query is run. */
export function idleOutcome(): QueryOutcome {
  return { kind: "idle" };
}

/** The outcome for a query that is executing. */
export function runningOutcome(): QueryOutcome {
  return { kind: "running" };
}

/** The outcome for a command-level failure (no normalized result). */
export function commandErrorOutcome(error: QueryError): QueryOutcome {
  return { kind: "error", error };
}

/** Whether a result carries display columns (a row-returning statement). */
export function hasResultColumns(result: QueryResult): boolean {
  return (result.columns?.length ?? 0) > 0;
}

/** Whether a successful result has columns but no rows. */
export function isEmptyResult(result: QueryResult): boolean {
  return (
    result.state === "succeeded" &&
    hasResultColumns(result) &&
    (result.rows?.length ?? 0) === 0
  );
}

/** Classifies a normalized backend result into a renderable outcome. */
export function resultOutcome(result: QueryResult): QueryOutcome {
  switch (result.state) {
    case "succeeded":
      if (!hasResultColumns(result)) {
        return { kind: "statement", result };
      }
      return isEmptyResult(result)
        ? { kind: "empty", result }
        : { kind: "grid", result };

    case "failed":
      return { kind: "failed", error: result.error ?? FALLBACK_QUERY_ERROR };

    case "cancelled":
      return { kind: "cancelled" };

    case "outcome_unknown":
      return { kind: "outcome_unknown", error: result.error };

    case "queued":
    case "running":
      return runningOutcome();
  }
}

/** Compact, display-ready summary of a normalized result. */
export interface QuerySummary {
  rows: number;
  columns: number;
  truncated: boolean;
  durationMs?: number;
  affectedRows?: number;
}

/** Extracts the display summary from a normalized result. */
export function summarizeResult(result: QueryResult): QuerySummary {
  return {
    rows: result.rows?.length ?? 0,
    columns: result.columns?.length ?? 0,
    truncated: result.truncated,
    durationMs: result.durationMs,
    affectedRows: result.affectedRows,
  };
}
