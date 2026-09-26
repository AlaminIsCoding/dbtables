import type { ColumnInfo, QueryResult, Row } from "../../domain";

/**
 * Normalized tabular data for the results grid.
 *
 * This is the seam between query results (mock or, later, backend-normalized)
 * and Glide. The grid only ever sees this shape, so replacing mock rows with
 * real query results is a data change, not a grid change.
 */
export interface ResultSet {
  /** Result columns in display order. */
  columns: ColumnInfo[];
  /** Result rows; each row has one cell per column. */
  rows: Row[];
  /** Whether the source capped the rows it returned. */
  truncated: boolean;
}

/** An empty result set with no columns or rows. */
export function emptyResultSet(): ResultSet {
  return { columns: [], rows: [], truncated: false };
}

/**
 * Adapts a normalized `QueryResult` (the backend-facing contract) into the
 * grid-facing `ResultSet`. Missing columns/rows are treated as empty rather
 * than undefined so the grid can render partial or non-row results safely.
 */
export function queryResultToResultSet(result: QueryResult): ResultSet {
  return {
    columns: result.columns ?? [],
    rows: result.rows ?? [],
    truncated: result.truncated,
  };
}

/** Whether a result set has no rows to show. */
export function isResultSetEmpty(result: ResultSet): boolean {
  return result.rows.length === 0;
}
