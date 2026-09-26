import { describe, expect, it } from "vitest";

import { emptyResultSet, isResultSetEmpty, queryResultToResultSet } from "./resultSet";
import type { QueryResult } from "../../domain";

const baseResult: QueryResult = {
  operationId: "op-1",
  state: "succeeded",
  truncated: false,
};

describe("queryResultToResultSet", () => {
  it("normalizes missing columns and rows to empty arrays", () => {
    const result = queryResultToResultSet(baseResult);

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(isResultSetEmpty(result)).toBe(true);
  });

  it("passes through columns, rows, and the truncated flag", () => {
    const result = queryResultToResultSet({
      ...baseResult,
      columns: [{ name: "id" }],
      rows: [[{ type: "integer", value: 1 }]],
      truncated: true,
    });

    expect(result.columns).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(isResultSetEmpty(result)).toBe(false);
  });
});

describe("emptyResultSet", () => {
  it("has no columns or rows", () => {
    const result = emptyResultSet();

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(isResultSetEmpty(result)).toBe(true);
  });
});
