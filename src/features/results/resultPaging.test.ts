import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../domain";
import {
  canFetchMore,
  FETCH_MORE_STEP,
  nextFetchLimit,
} from "./resultPaging";

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op-1",
    state: "succeeded",
    truncated: false,
    ...overrides,
  };
}

describe("nextFetchLimit", () => {
  it("grows the requested cap by the bounded fetch-more step", () => {
    expect(nextFetchLimit(0)).toBe(FETCH_MORE_STEP);
    expect(nextFetchLimit(FETCH_MORE_STEP)).toBe(FETCH_MORE_STEP * 2);
  });
});

describe("canFetchMore", () => {
  it("allows another fetch only for a truncated result that filled the cap", () => {
    const full = result({
      truncated: true,
      rows: Array.from({ length: 500 }, () => []),
    });

    expect(canFetchMore(full, 500)).toBe(true);
  });

  it("stops when the result is complete", () => {
    const complete = result({ truncated: false, rows: [[]] });

    expect(canFetchMore(complete, 500)).toBe(false);
  });

  it("stops when the backend returned fewer rows than requested", () => {
    // The backend clamped the request to its own hard ceiling, so asking again
    // would not make progress.
    const clamped = result({
      truncated: true,
      rows: Array.from({ length: 9_000 }, () => []),
    });

    expect(canFetchMore(clamped, 10_500)).toBe(false);
  });

  it("never offers more for a non-successful result", () => {
    const failed = result({ state: "failed", truncated: true });

    expect(canFetchMore(failed, 0)).toBe(false);
  });
});
