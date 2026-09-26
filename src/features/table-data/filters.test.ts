import { describe, expect, it } from "vitest";

import type { ColumnInfo } from "../../domain";
import {
  createTableFilter,
  describeFilter,
  operatorNeedsValue,
  operatorTakesList,
  parseFilterCellValue,
  singleSortKey,
  sortColumnOf,
  sortDirectionOf,
} from "./filters";

const integerColumn: ColumnInfo = { name: "id", typeName: "INTEGER" };
const decimalColumn: ColumnInfo = { name: "amount", typeName: "numeric(10,2)" };
const booleanColumn: ColumnInfo = { name: "active", typeName: "boolean" };
const textColumn: ColumnInfo = { name: "email", typeName: "text" };

describe("table data filters", () => {
  it("reports which operators need a value", () => {
    expect(operatorNeedsValue("equal")).toBe(true);
    expect(operatorNeedsValue("in")).toBe(true);
    expect(operatorNeedsValue("is_null")).toBe(false);
    expect(operatorTakesList("in")).toBe(true);
    expect(operatorTakesList("equal")).toBe(false);
  });

  it("parses values using the engine-reported column type", () => {
    expect(parseFilterCellValue("42", integerColumn)).toEqual({
      type: "integer",
      value: 42,
    });
    expect(parseFilterCellValue("12.50", decimalColumn)).toEqual({
      type: "decimal",
      value: "12.50",
    });
    expect(parseFilterCellValue("true", booleanColumn)).toEqual({
      type: "boolean",
      value: true,
    });
    expect(parseFilterCellValue("bob", textColumn)).toEqual({
      type: "text",
      value: "bob",
    });
    // Unparseable numeric input falls back to text rather than guessing.
    expect(parseFilterCellValue("42abc", integerColumn)).toEqual({
      type: "text",
      value: "42abc",
    });
  });

  it("builds value and null-check filters", () => {
    expect(createTableFilter(textColumn, "like", "%bob%")).toEqual({
      column: "email",
      operator: "like",
      values: [{ type: "text", value: "%bob%" }],
    });

    expect(createTableFilter(textColumn, "is_null", "")).toEqual({
      column: "email",
      operator: "is_null",
    });

    expect(createTableFilter(textColumn, "in", "a, b ,, c")).toEqual({
      column: "email",
      operator: "in",
      values: [
        { type: "text", value: "a" },
        { type: "text", value: "b" },
        { type: "text", value: "c" },
      ],
    });
  });

  it("rejects incomplete filters", () => {
    expect(createTableFilter(textColumn, "equal", "   ")).toBeNull();
    expect(createTableFilter(textColumn, "in", " , ")).toBeNull();
  });

  it("describes active filters for the chip list", () => {
    expect(
      describeFilter({ column: "id", operator: "equal", values: [{ type: "integer", value: 7 }] }),
    ).toBe("id = 7");
    expect(describeFilter({ column: "email", operator: "is_null" })).toBe(
      "email is null",
    );
  });

  it("normalizes a single sort key", () => {
    expect(singleSortKey("id", "descending")).toEqual([
      { column: "id", direction: "descending" },
    ]);
    expect(singleSortKey("", "ascending")).toEqual([]);
    expect(sortColumnOf([{ column: "id", direction: "ascending" }])).toBe("id");
    expect(sortColumnOf([])).toBeNull();
    expect(sortDirectionOf([])).toBe("ascending");
  });
});
