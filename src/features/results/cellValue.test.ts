import { describe, expect, it } from "vitest";

import {
  cellValueToCopyString,
  formatCellValue,
  NULL_DISPLAY,
} from "./cellValue";

describe("formatCellValue", () => {
  it("renders null as a placeholder", () => {
    expect(formatCellValue({ type: "null" })).toBe(NULL_DISPLAY);
  });

  it("formats scalar values for display", () => {
    expect(formatCellValue({ type: "boolean", value: false })).toBe("false");
    expect(formatCellValue({ type: "float", value: 1.5 })).toBe("1.5");
  });

  it("flattens newlines in the display", () => {
    expect(formatCellValue({ type: "text", value: "line one\nline two" })).not.toContain(
      "\n",
    );
  });

  it("previews bytes", () => {
    expect(formatCellValue({ type: "bytes", value: [0x00, 0xff] })).toBe("0x00 ff");
  });
});

describe("cellValueToCopyString", () => {
  it("copies nulls as empty strings", () => {
    expect(cellValueToCopyString({ type: "null" })).toBe("");
  });

  it("preserves the exact text value", () => {
    const value = "line one\nline two";
    expect(cellValueToCopyString({ type: "text", value })).toBe(value);
  });

  it("copies bytes as unpadded hex", () => {
    expect(cellValueToCopyString({ type: "bytes", value: [0x00, 0xff] })).toBe("00ff");
  });
});
