import { describe, expect, it } from "vitest";

import {
  createMockResultSet,
  MOCK_BIG_DECIMAL,
  MOCK_LONG_TEXT,
  MOCK_ROW_COUNT,
} from "./mockResult";
import { isResultSetEmpty } from "./resultSet";

const EXPECTED_COLUMNS = [
  "id",
  "name",
  "email",
  "status",
  "balance",
  "rating",
  "active",
  "metadata",
  "notes",
  "created_at",
  "avatar",
];

describe("createMockResultSet", () => {
  it("returns the documented mock shape", () => {
    const result = createMockResultSet();

    expect(result.columns.map((column) => column.name)).toEqual(EXPECTED_COLUMNS);
    expect(result.rows).toHaveLength(MOCK_ROW_COUNT);
    expect(result.rows.every((row) => row.length === EXPECTED_COLUMNS.length)).toBe(true);
    expect(result.truncated).toBe(false);
    expect(isResultSetEmpty(result)).toBe(false);
  });

  it("includes long, null, structured, large, and binary representative values", () => {
    const result = createMockResultSet();
    const first = result.rows[0];
    const second = result.rows[1];

    expect(first[8]).toEqual({ type: "text", value: MOCK_LONG_TEXT });
    expect(MOCK_LONG_TEXT.length).toBeGreaterThan(200);

    const metadata = first[7];
    expect(metadata.type).toBe("text");
    if (metadata.type === "text") {
      expect(() => JSON.parse(metadata.value) as unknown).not.toThrow();
    }

    expect(first[4]).toEqual({ type: "decimal", value: MOCK_BIG_DECIMAL });
    expect(second.filter((cell) => cell.type === "null").length).toBeGreaterThanOrEqual(4);
    expect(result.rows.some((row) => row[10].type === "bytes")).toBe(true);
  });

  it("is deterministic for a given row count", () => {
    expect(createMockResultSet(5)).toEqual(createMockResultSet(5));
  });
});
