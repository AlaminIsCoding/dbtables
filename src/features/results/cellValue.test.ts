import { describe, expect, it, vi } from "vitest";
import type { GridCell } from "@glideapps/glide-data-grid";

import {
  cellValueToCopyString,
  cellValueToGridCell,
  formatCellValue,
  gridCellToCellValue,
  NULL_DISPLAY,
} from "./cellValue";

vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: {
    Text: "text",
    Number: "number",
    Boolean: "boolean",
    Uri: "uri",
    Markdown: "markdown",
  },
}));

interface InspectCell {
  kind: string;
  displayData?: string;
  copyData?: string;
  allowOverlay: boolean;
  contentAlign?: string;
  data?: unknown;
}

function inspect(cell: GridCell): InspectCell {
  return cell as unknown as InspectCell;
}

describe("cellValueToGridCell", () => {
  it("renders null as a faded placeholder that copies as empty", () => {
    const cell = inspect(cellValueToGridCell({ type: "null" }));

    expect(cell.kind).toBe("text");
    expect(cell.displayData).toBe(NULL_DISPLAY);
    expect(cell.copyData).toBe("");
  });

  it("maps booleans without an overlay", () => {
    const cell = inspect(cellValueToGridCell({ type: "boolean", value: true }));

    expect(cell.kind).toBe("boolean");
    expect(cell.data).toBe(true);
    expect(cell.allowOverlay).toBe(false);
  });

  it("maps integers to right-aligned number cells", () => {
    const cell = inspect(cellValueToGridCell({ type: "integer", value: 42 }));

    expect(cell.kind).toBe("number");
    expect(cell.contentAlign).toBe("right");
    expect(cell.copyData).toBe("42");
  });

  it("keeps large decimals as text to avoid precision loss", () => {
    const decimal = "12345678901234567890.12";
    const cell = inspect(cellValueToGridCell({ type: "decimal", value: decimal }));

    expect(cell.kind).toBe("text");
    expect(cell.displayData).toBe(decimal);
    expect(cell.copyData).toBe(decimal);
  });

  it("flattens newlines in the display but preserves the copied value", () => {
    const value = "line one\nline two";
    const cell = inspect(cellValueToGridCell({ type: "text", value }));

    expect(cell.displayData).not.toContain("\n");
    expect(cell.copyData).toBe(value);
  });

  it("previews bytes and copies unpadded hex", () => {
    const cell = inspect(cellValueToGridCell({ type: "bytes", value: [0x00, 0xff] }));

    expect(cell.displayData).toBe("0x00 ff");
    expect(cell.copyData).toBe("00ff");
  });
});

describe("formatCellValue", () => {
  it("formats scalar values for display", () => {
    expect(formatCellValue({ type: "null" })).toBe(NULL_DISPLAY);
    expect(formatCellValue({ type: "boolean", value: false })).toBe("false");
    expect(formatCellValue({ type: "float", value: 1.5 })).toBe("1.5");
  });
});

describe("cellValueToCopyString", () => {
  it("copies nulls as empty strings", () => {
    expect(cellValueToCopyString({ type: "null" })).toBe("");
  });
});

describe("gridCellToCellValue", () => {
  it("returns null when a null cell is cleared", () => {
    const cell = {
      kind: "text",
      data: "",
      displayData: "",
      allowOverlay: true,
    } as unknown as Parameters<typeof gridCellToCellValue>[0];

    expect(gridCellToCellValue(cell, { type: "null" })).toEqual({ type: "null" });
  });

  it("keeps numeric columns decimal when edited as text", () => {
    const cell = {
      kind: "text",
      data: "12.50",
      displayData: "12.50",
      allowOverlay: true,
    } as unknown as Parameters<typeof gridCellToCellValue>[0];

    expect(
      gridCellToCellValue(cell, { type: "decimal", value: "10.00" }),
    ).toEqual({ type: "decimal", value: "12.50" });
  });

  it("parses boolean edits", () => {
    const cell = {
      kind: "boolean",
      data: false,
      allowOverlay: false,
    } as unknown as Parameters<typeof gridCellToCellValue>[0];

    expect(
      gridCellToCellValue(cell, { type: "boolean", value: true }),
    ).toEqual({ type: "boolean", value: false });
  });
});
