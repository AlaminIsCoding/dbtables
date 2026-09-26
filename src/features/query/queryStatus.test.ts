import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../domain";
import type { QueryOutcome } from "../results/queryOutcome";
import { describeQueryStatus, formatQueryStatus } from "./queryStatus";

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op",
    state: "succeeded",
    truncated: false,
    ...overrides,
  };
}

describe("describeQueryStatus", () => {
  it("distinguishes idle, running, cancelled, and uncertain states", () => {
    expect(describeQueryStatus({ kind: "idle" }).state).toBe("idle");
    expect(describeQueryStatus({ kind: "running" }).state).toBe("running");
    expect(describeQueryStatus({ kind: "cancelled" }).state).toBe("cancelled");
    expect(
      describeQueryStatus({
        kind: "outcome_unknown",
        error: { category: "transport", message: "lost" },
      }),
    ).toEqual({ state: "uncertain", errorCategory: "transport" });
  });

  it("reports duration and affected rows for a statement", () => {
    const outcome: QueryOutcome = {
      kind: "statement",
      result: result({ affectedRows: 3, durationMs: 12 }),
    };

    expect(describeQueryStatus(outcome)).toEqual({
      state: "succeeded",
      durationMs: 12,
      affectedRows: 3,
    });
  });

  it("reports duration and row count for a grid result", () => {
    const outcome: QueryOutcome = {
      kind: "grid",
      result: result({
        rows: [[{ type: "integer", value: 1 }]],
        durationMs: 4,
      }),
    };

    expect(describeQueryStatus(outcome)).toEqual({
      state: "succeeded",
      durationMs: 4,
      rows: 1,
    });
  });

  it("reports a failure category without claiming success", () => {
    expect(
      describeQueryStatus({
        kind: "failed",
        error: { category: "syntax", message: "bad sql" },
      }),
    ).toEqual({ state: "failed", errorCategory: "syntax" });

    expect(
      describeQueryStatus({
        kind: "error",
        error: { category: "connection", message: "not open" },
      }),
    ).toEqual({ state: "failed", errorCategory: "connection" });
  });
});

describe("formatQueryStatus", () => {
  it("formats success details compactly", () => {
    expect(
      formatQueryStatus({
        state: "succeeded",
        durationMs: 12,
        affectedRows: 3,
      }),
    ).toBe("succeeded · 3 rows affected · 12 ms");

    expect(
      formatQueryStatus({ state: "succeeded", rows: 1, durationMs: 4 }),
    ).toBe("succeeded · 1 row · 4 ms");
  });

  it("formats long durations in seconds", () => {
    expect(formatQueryStatus({ state: "succeeded", durationMs: 1500 })).toBe(
      "succeeded · 1.50 s",
    );
  });

  it("formats failure and plain states", () => {
    expect(formatQueryStatus({ state: "running" })).toBe("running");
    expect(
      formatQueryStatus({ state: "failed", errorCategory: "syntax" }),
    ).toBe("failed · syntax");
  });
});
