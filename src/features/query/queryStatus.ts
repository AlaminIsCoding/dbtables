import type { QueryOutcome } from "../results/queryOutcome";

/**
 * Display-ready execution status for the query workspace.
 *
 * The results pane renders the outcome body; this summary is the compact
 * one-line state shown next to the Run controls so the target and query state
 * stay obvious. It keeps the terminal categories distinct and surfaces the
 * duration/affected-row metadata the backend reports.
 */

/** Coarse state word shown to the user. */
export type QueryStateWord =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain";

/** Structured status extracted from a {@link QueryOutcome}. */
export interface QueryStatusSummary {
  /** Coarse state of the last run. */
  state: QueryStateWord;
  /** Execution duration in milliseconds, when reported. */
  durationMs?: number;
  /** Affected rows for a non-row statement, when reported. */
  affectedRows?: number;
  /** Returned rows for a row-returning result, when applicable. */
  rows?: number;
  /** Normalized error category for a failure. */
  errorCategory?: string;
}

/** Extracts a compact status summary from a query outcome. */
export function describeQueryStatus(outcome: QueryOutcome): QueryStatusSummary {
  switch (outcome.kind) {
    case "idle":
      return { state: "idle" };
    case "running":
      return { state: "running" };
    case "cancelled":
      return { state: "cancelled" };
    case "outcome_unknown":
      return {
        state: "uncertain",
        errorCategory: outcome.error?.category,
      };
    case "failed":
      return { state: "failed", errorCategory: outcome.error.category };
    case "error":
      return { state: "failed", errorCategory: outcome.error.category };
    case "statement":
      return {
        state: "succeeded",
        durationMs: outcome.result.durationMs,
        affectedRows: outcome.result.affectedRows,
      };
    case "grid":
    case "partial":
    case "empty":
      return {
        state: "succeeded",
        durationMs: outcome.result.durationMs,
        rows: outcome.result.rows?.length ?? 0,
      };
  }
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000
    ? `${durationMs} ms`
    : `${(durationMs / 1000).toFixed(2)} s`;
}

/**
 * Renders a status summary as a compact string such as
 * `succeeded · 12 ms · 3 rows affected`.
 */
export function formatQueryStatus(summary: QueryStatusSummary): string {
  const parts: string[] = [summary.state];

  if (summary.rows !== undefined) {
    parts.push(`${summary.rows} row${summary.rows === 1 ? "" : "s"}`);
  }
  if (summary.affectedRows !== undefined) {
    parts.push(
      `${summary.affectedRows} row${summary.affectedRows === 1 ? "" : "s"} affected`,
    );
  }
  if (summary.durationMs !== undefined) {
    parts.push(formatDuration(summary.durationMs));
  }
  if (summary.state === "failed" && summary.errorCategory) {
    parts.push(summary.errorCategory);
  }

  return parts.join(" · ");
}
