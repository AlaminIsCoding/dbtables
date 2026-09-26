import { describe, expect, it } from "vitest";

import { columnsToGridColumns, columnWidthFor } from "./gridColumns";

describe("columnWidthFor", () => {
  it("sizes columns from type and name heuristics", () => {
    expect(columnWidthFor({ name: "active", typeName: "BOOLEAN" })).toBe(84);
    expect(columnWidthFor({ name: "id", typeName: "INTEGER" })).toBe(96);
    expect(columnWidthFor({ name: "balance", typeName: "DECIMAL(12, 2)" })).toBe(132);
    expect(columnWidthFor({ name: "rating", typeName: "REAL" })).toBe(112);
    expect(columnWidthFor({ name: "metadata", typeName: "JSON" })).toBe(300);
    expect(columnWidthFor({ name: "notes", typeName: "TEXT" })).toBe(320);
    expect(columnWidthFor({ name: "email", typeName: "TEXT" })).toBe(168);
  });
});

describe("columnsToGridColumns", () => {
  it("builds Glide columns from normalized column info", () => {
    const columns = columnsToGridColumns([
      { name: "id", typeName: "INTEGER" },
      { name: "name", typeName: "TEXT" },
    ]);

    expect(columns.map((column) => column.title)).toEqual(["id", "name"]);
    expect((columns[0] as { width: number }).width).toBe(96);
    expect((columns[1] as { width: number }).width).toBe(168);
  });

  it("de-duplicates repeated column labels", () => {
    const columns = columnsToGridColumns([{ name: "id" }, { name: "id" }]);

    expect(columns.map((column) => column.title)).toEqual(["id", "id (2)"]);
    expect(columns[0].id).toBe("id-0");
    expect(columns[1].id).toBe("id-1");
  });
});
