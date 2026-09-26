import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../domain";
import {
  FALLBACK_QUERY_ERROR,
  idleOutcome,
  isEmptyResult,
  resultOutcome,
  runningOutcome,
  summarizeResult,
} from "./queryOutcome";

function succeeded(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op-1",
    state: "succeeded",
    truncated: false,
    ...overrides,
  };
}

describe("query outcome helpers", () => {
  it("exposes idle and running outcomes", () => {
    expect(idleOutcome()).toEqual({ kind: "idle" });
    expect(runningOutcome()).toEqual({ kind: "running" });
  });

  it("classifies a populated success as a grid", () => {
    const result = succeeded({
      columns: [{ name: "id" }],
      rows: [[{ type: "integer", value: 1 }]],
    });

    expect(resultOutcome(result)).toEqual({ kind: "grid", result });
    expect(isEmptyResult(result)).toBe(false);
  });

  it("classifies a success with columns but no rows as empty", () => {
    const result = succeeded({ columns: [{ name: "id" }], rows: [] });

    expect(resultOutcome(result)).toEqual({ kind: "empty", result });
    expect(isEmptyResult(result)).toBe(true);
  });

  it("classifies a success without result columns as a statement", () => {
    const result = succeeded({ affectedRows: 3 });

    expect(resultOutcome(result)).toEqual({ kind: "statement", result });
  });

  it("classifies failed, cancelled, and uncertain states distinctly", () => {
    const failed = succeeded({
      state: "failed",
      error: { category: "syntax", message: "bad sql" },
    });
    expect(resultOutcome(failed)).toEqual({
      kind: "failed",
      error: { category: "syntax", message: "bad sql" },
    });

    expect(
      resultOutcome(succeeded({ state: "cancelled" })),
    ).toEqual({ kind: "cancelled" });

    expect(
      resultOutcome(succeeded({ state: "outcome_unknown" })),
    ).toEqual({ kind: "outcome_unknown", error: undefined });
  });

  it("supplies a fallback error when a failed result has none", () => {
    const failed = succeeded({ state: "failed" });

    expect(resultOutcome(failed)).toEqual({
      kind: "failed",
      error: FALLBACK_QUERY_ERROR,
    });
  });

  it("treats queued and running backend states as running", () => {
    expect(resultOutcome(succeeded({ state: "queued" }))).toEqual({
      kind: "running",
    });
    expect(resultOutcome(succeeded({ state: "running" }))).toEqual({
      kind: "running",
    });
  });

  it("summarizes rows, columns, truncation, and duration", () => {
    const summary = summarizeResult(
      succeeded({
        columns: [{ name: "id" }, { name: "name" }],
        rows: [[{ type: "integer", value: 1 }]],
        truncated: true,
        durationMs: 12,
      }),
    );

    expect(summary).toEqual({
      rows: 1,
      columns: 2,
      truncated: true,
      durationMs: 12,
      affectedRows: undefined,
    });
  });
});
