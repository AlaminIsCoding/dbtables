import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../domain";
import { cellCopyText, resultCopyText, rowCopyText } from "./copy";

function result(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op-1",
    state: "succeeded",
    truncated: false,
    ...overrides,
  };
}

describe("cellCopyText", () => {
  it("copies null as an empty string and scalars as plain text", () => {
    expect(cellCopyText({ type: "null" })).toBe("");
    expect(cellCopyText({ type: "boolean", value: false })).toBe("false");
    expect(cellCopyText({ type: "integer", value: 42 })).toBe("42");
    expect(cellCopyText({ type: "decimal", value: "12.500" })).toBe("12.500");
    expect(cellCopyText({ type: "bytes", value: [0x0a, 0xff] })).toBe("0aff");
  });

  it("preserves newlines for a single-cell copy", () => {
    expect(cellCopyText({ type: "text", value: "a\nb" })).toBe("a\nb");
  });
});

describe("rowCopyText", () => {
  it("joins one row with tabs and flattens embedded whitespace", () => {
    const value = result({
      columns: [{ name: "id" }, { name: "notes" }],
      rows: [
        [{ type: "integer", value: 1 }, { type: "text", value: "a\tb\nc" }],
        [{ type: "integer", value: 2 }, { type: "null" }],
      ],
    });

    expect(rowCopyText(value, 0)).toBe("1\ta b c");
    expect(rowCopyText(value, 1)).toBe("2\t");
  });

  it("returns an empty string for an out-of-range row", () => {
    expect(rowCopyText(result({ rows: [] }), 3)).toBe("");
  });
});

describe("resultCopyText", () => {
  it("includes a header row and every loaded row by default", () => {
    const value = result({
      columns: [{ name: "id" }, { name: "name" }],
      rows: [
        [
          { type: "integer", value: 1 },
          { type: "text", value: "alice" },
        ],
        [
          { type: "integer", value: 2 },
          { type: "text", value: "bob" },
        ],
      ],
    });

    expect(resultCopyText(value)).toBe("id\tname\n1\talice\n2\tbob");
  });

  it("can omit the header for a data-only copy", () => {
    const value = result({
      columns: [{ name: "id" }],
      rows: [[{ type: "integer", value: 1 }]],
    });

    expect(resultCopyText(value, { includeHeader: false })).toBe("1");
  });

  it("uses copy semantics for nulls, bytes, and empty strings", () => {
    const value = result({
      columns: [{ name: "a" }, { name: "b" }, { name: "c" }],
      rows: [
        [
          { type: "null" },
          { type: "bytes", value: [0x01] },
          { type: "text", value: "" },
        ],
      ],
    });

    expect(resultCopyText(value, { includeHeader: false })).toBe("\t01\t");
  });

  it("copies only the loaded rows of a partial result", () => {
    const value = result({
      columns: [{ name: "id" }],
      rows: [[{ type: "integer", value: 1 }]],
      truncated: true,
    });

    expect(resultCopyText(value)).toBe("id\n1");
  });

  it("sanitizes header names that contain separators", () => {
    const value = result({
      columns: [{ name: "first\tname" }],
      rows: [],
    });

    expect(resultCopyText(value)).toBe("first name");
  });
});
