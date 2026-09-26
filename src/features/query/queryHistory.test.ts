import { describe, expect, it } from "vitest";

import type { QueryError, QueryResult } from "../../domain";
import {
  MAX_QUERY_HISTORY,
  historyEntryFromError,
  historyEntryFromResult,
  isHistoryState,
  prependHistoryEntry,
  type QueryHistoryEntry,
} from "./queryHistory";

function succeeded(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op-1",
    state: "succeeded",
    truncated: false,
    ...overrides,
  };
}

function entry(id: string, at = 0): QueryHistoryEntry {
  return { id, sql: `SELECT ${id}`, state: "succeeded", at };
}

describe("query history", () => {
  it("recognizes only terminal operation states", () => {
    expect(isHistoryState("succeeded")).toBe(true);
    expect(isHistoryState("failed")).toBe(true);
    expect(isHistoryState("cancelled")).toBe(true);
    expect(isHistoryState("outcome_unknown")).toBe(true);
    expect(isHistoryState("queued")).toBe(false);
    expect(isHistoryState("running")).toBe(false);
  });

  it("keeps the newest entries first and bounds the list", () => {
    let entries: QueryHistoryEntry[] = [];
    for (let index = 0; index < MAX_QUERY_HISTORY + 5; index += 1) {
      entries = prependHistoryEntry(entries, entry(`e${index}`));
    }

    expect(entries).toHaveLength(MAX_QUERY_HISTORY);
    expect(entries[0].id).toBe(`e${MAX_QUERY_HISTORY + 4}`);
    expect(entries.at(-1)?.id).toBe("e5");
  });

  it("keeps no history for a non-positive cap", () => {
    expect(prependHistoryEntry([entry("a")], entry("b"), 0)).toEqual([]);
  });

  it("records outcome metadata from a terminal result", () => {
    const result = succeeded({
      state: "succeeded",
      durationMs: 12,
      affectedRows: 3,
      rows: [[{ type: "integer", value: 1 }]],
    });

    expect(historyEntryFromResult("op-1", "SELECT 1", result, 99)).toEqual({
      id: "op-1",
      sql: "SELECT 1",
      state: "succeeded",
      at: 99,
      durationMs: 12,
      affectedRows: 3,
      rows: 1,
      errorCategory: undefined,
    });
  });

  it("records an uncertain result as outcome_unknown, not success", () => {
    const result = succeeded({
      state: "outcome_unknown",
      error: { category: "transport", message: "connection lost" },
    });

    const recorded = historyEntryFromResult("op-2", "UPDATE users SET name = 'x'", result, 1);
    expect(recorded?.state).toBe("outcome_unknown");
    expect(recorded?.errorCategory).toBe("transport");
  });

  it("does not record a non-terminal result", () => {
    expect(
      historyEntryFromResult("op", "SELECT 1", succeeded({ state: "running" })),
    ).toBeNull();
    expect(
      historyEntryFromResult("op", "SELECT 1", succeeded({ state: "queued" })),
    ).toBeNull();
  });

  it("records a command failure with no extra fields", () => {
    const error: QueryError = { category: "connection", message: "not open" };
    const recorded = historyEntryFromError("op-3", "SELECT 1", error, 5);

    expect(recorded).toEqual({
      id: "op-3",
      sql: "SELECT 1",
      state: "failed",
      at: 5,
      errorCategory: "connection",
    });
  });

  it("stores only SQL and outcome fields, so secrets cannot be retained", () => {
    const result = succeeded({ durationMs: 1 });
    const fromResult = historyEntryFromResult("op", "SELECT 1", result);
    const fromError = historyEntryFromError("op", "SELECT 1", {
      category: "internal",
      message: "boom",
    });

    expect(Object.keys(fromResult ?? {}).sort()).toEqual([
      "affectedRows",
      "at",
      "durationMs",
      "errorCategory",
      "id",
      "rows",
      "sql",
      "state",
    ]);
    expect(Object.keys(fromError).sort()).toEqual([
      "at",
      "errorCategory",
      "id",
      "sql",
      "state",
    ]);
  });
});
