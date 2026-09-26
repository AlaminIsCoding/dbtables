import type { QueryResult } from "../../domain";

/**
 * Bounded result paging policy for arbitrary SQL results.
 *
 * The backend caps every execution (see `DEFAULT_MAX_ROWS`/`HARD_MAX_ROWS` in
 * `src-tauri/src/application/queries.rs`). A "fetch more" request re-runs the
 * same statement with a larger cap; this module only decides how much larger
 * the next request may be and when the bounded flow is exhausted. It never
 * builds SQL and never assumes an engine-specific paging syntax.
 */

/** Rows added to the request each time the user asks for more of a result.
 *
 * Mirrors `FETCH_MORE_STEP` in `src-tauri/src/application/queries.rs`. The
 * backend still clamps every request to its own hard ceiling, so a stale value
 * here can change how fast a result grows but never the bound.
 */
export const FETCH_MORE_STEP = 500;

/** The next row cap to request after a fetch requested `requestedLimit` rows. */
export function nextFetchLimit(requestedLimit: number): number {
  return requestedLimit + FETCH_MORE_STEP;
}

/**
 * Whether a truncated result can be extended further.
 *
 * `requestedLimit` is the cap used for the fetch that produced `result`. If the
 * backend returned fewer rows than requested while still marking the result
 * truncated, a lower hard ceiling was reached and another request would make no
 * progress, so "fetch more" must not be offered.
 */
export function canFetchMore(
  result: QueryResult,
  requestedLimit: number,
): boolean {
  return (
    result.state === "succeeded" &&
    result.truncated &&
    (result.rows?.length ?? 0) >= requestedLimit
  );
}
