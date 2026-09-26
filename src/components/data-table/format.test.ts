import { describe, expect, it } from "vitest";

import { columnWidthFor, formatCellValue, parseCellEdit } from "./format";

describe("columnWidthFor", () => {
  it("sizes columns from type and name heuristics", () => {
    expect(columnWidthFor({ name: "active", typeName: "BOOLEAN" })).toBe(90);
    expect(columnWidthFor({ name: "id", typeName: "INTEGER" })).toBe(110);
    expect(columnWidthFor({ name: "balance", typeName: "DECIMAL(12, 2)" })).toBe(140);
    expect(columnWidthFor({ name: "rating", typeName: "REAL" })).toBe(120);
    expect(columnWidthFor({ name: "metadata", typeName: "JSON" })).toBe(300);
    expect(columnWidthFor({ name: "notes", typeName: "TEXT" })).toBe(320);
    expect(columnWidthFor({ name: "email", typeName: "TEXT" })).toBe(176);
  });

  it("honors an explicit width", () => {
    expect(columnWidthFor({ name: "email", typeName: "TEXT", width: 240 })).toBe(240);
  });
});

describe("formatCellValue", () => {
  it("renders NULL for null values", () => {
    expect(formatCellValue({ type: "null" })).toBe("NULL");
  });

  it("renders scalars as text", () => {
    expect(formatCellValue({ type: "integer", value: 42 })).toBe("42");
    expect(formatCellValue({ type: "boolean", value: true })).toBe("true");
    expect(formatCellValue({ type: "text", value: "hi" })).toBe("hi");
  });
});

describe("parseCellEdit", () => {
  it("parses integer edits", () => {
    const result = parseCellEdit("12", { type: "integer", value: 0 });
    expect(result).toEqual({ ok: true, value: { type: "integer", value: 12 } });
  });

  it("rejects non-numeric text for a numeric column", () => {
    const result = parseCellEdit("abc", { type: "integer", value: 0 });
    expect(result.ok).toBe(false);
  });
});
