import { describe, expect, it } from "vitest";

import type { ColumnInfo } from "../../domain";
import {
  baseValueForColumn,
  cellValueToEditText,
  isEditableValue,
  parseColumnText,
  parseEditedCellValue,
} from "./editorValue";

describe("editorValue", () => {
  it("marks every value but binary as editable", () => {
    expect(isEditableValue({ type: "text", value: "x" })).toBe(true);
    expect(isEditableValue({ type: "null" })).toBe(true);
    expect(isEditableValue({ type: "bytes", value: [1, 2] })).toBe(false);
  });

  it("renders each value type as editor text", () => {
    expect(cellValueToEditText({ type: "null" })).toBe("");
    expect(cellValueToEditText({ type: "boolean", value: true })).toBe("true");
    expect(cellValueToEditText({ type: "integer", value: 42 })).toBe("42");
    expect(cellValueToEditText({ type: "float", value: 1.5 })).toBe("1.5");
    expect(cellValueToEditText({ type: "decimal", value: "10.00" })).toBe("10.00");
    expect(cellValueToEditText({ type: "text", value: "hello" })).toBe("hello");
    expect(cellValueToEditText({ type: "bytes", value: [10, 255] })).toBe("0a ff");
  });
});

describe("parseEditedCellValue", () => {
  it("turns a blank nullable value into NULL and non-blank into text", () => {
    expect(parseEditedCellValue("", { type: "null" })).toEqual({
      ok: true,
      value: { type: "null" },
    });
    expect(parseEditedCellValue("bob", { type: "null" })).toEqual({
      ok: true,
      value: { type: "text", value: "bob" },
    });
  });

  it("parses booleans and rejects other text", () => {
    expect(parseEditedCellValue("true", { type: "boolean", value: false })).toEqual({
      ok: true,
      value: { type: "boolean", value: true },
    });
    expect(parseEditedCellValue("0", { type: "boolean", value: true })).toEqual({
      ok: true,
      value: { type: "boolean", value: false },
    });
    expect(parseEditedCellValue("maybe", { type: "boolean", value: true })).toEqual({
      ok: false,
      message: "Enter true or false.",
    });
  });

  it("keeps integers in range and widens larger ones to decimal text", () => {
    expect(parseEditedCellValue("7", { type: "integer", value: 1 })).toEqual({
      ok: true,
      value: { type: "integer", value: 7 },
    });
    expect(
      parseEditedCellValue("99999999999999999999", { type: "integer", value: 1 }),
    ).toEqual({
      ok: true,
      value: { type: "decimal", value: "99999999999999999999" },
    });
    expect(parseEditedCellValue("x", { type: "integer", value: 1 })).toEqual({
      ok: false,
      message: "Enter a whole number.",
    });
  });

  it("parses floats and decimals and rejects non-numbers", () => {
    expect(parseEditedCellValue("1.25", { type: "float", value: 0 })).toEqual({
      ok: true,
      value: { type: "float", value: 1.25 },
    });
    expect(parseEditedCellValue("1.25", { type: "decimal", value: "0" })).toEqual({
      ok: true,
      value: { type: "decimal", value: "1.25" },
    });
    expect(parseEditedCellValue("nope", { type: "float", value: 0 }).ok).toBe(false);
    expect(parseEditedCellValue("nope", { type: "decimal", value: "0" }).ok).toBe(false);
  });

  it("keeps text verbatim and refuses binary edits", () => {
    expect(parseEditedCellValue("a\nb", { type: "text", value: "" })).toEqual({
      ok: true,
      value: { type: "text", value: "a\nb" },
    });
    expect(parseEditedCellValue("0a", { type: "bytes", value: [1] }).ok).toBe(false);
  });
});

describe("column insert parsing", () => {
  const numeric: ColumnInfo = { name: "age", typeName: "integer", nullable: true };
  const text: ColumnInfo = { name: "name", typeName: "text", nullable: true };
  const required: ColumnInfo = { name: "id", typeName: "integer", nullable: false };

  it("infers a parse base from the declared column type", () => {
    expect(baseValueForColumn({ name: "b", typeName: "boolean" }).type).toBe("boolean");
    expect(baseValueForColumn(numeric).type).toBe("integer");
    expect(baseValueForColumn({ name: "p", typeName: "numeric" }).type).toBe("decimal");
    expect(baseValueForColumn({ name: "f", typeName: "double" }).type).toBe("float");
    expect(baseValueForColumn(text).type).toBe("text");
    expect(baseValueForColumn({ name: "x" }).type).toBe("text");
  });

  it("treats a blank nullable field as NULL and a blank required field as an error", () => {
    expect(parseColumnText("", numeric)).toEqual({
      ok: true,
      value: { type: "null" },
    });
    expect(parseColumnText("  ", text)).toEqual({
      ok: true,
      value: { type: "null" },
    });
    expect(parseColumnText("", required).ok).toBe(false);
  });

  it("parses typed values for a new row", () => {
    expect(parseColumnText("31", numeric)).toEqual({
      ok: true,
      value: { type: "integer", value: 31 },
    });
    expect(parseColumnText("alice", text)).toEqual({
      ok: true,
      value: { type: "text", value: "alice" },
    });
    expect(parseColumnText("later", required)).toEqual({
      ok: false,
      message: "Enter a whole number.",
    });
  });
});
