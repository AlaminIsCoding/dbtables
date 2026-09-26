import {
  GridCellKind,
  type EditableGridCell,
  type GridCell,
} from "@glideapps/glide-data-grid";

import type { CellValue } from "../../domain";

/** Placeholder shown for SQL `NULL`; copying a null still copies an empty string. */
export const NULL_DISPLAY = "NULL";

/** Number of leading bytes rendered for binary values before eliding. */
const BYTE_PREVIEW_LENGTH = 8;

function bytesToHexPreview(bytes: number[]): string {
  if (bytes.length === 0) {
    return "0x";
  }

  const head = bytes
    .slice(0, BYTE_PREVIEW_LENGTH)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");

  return bytes.length > BYTE_PREVIEW_LENGTH
    ? `0x${head} … (${bytes.length} bytes)`
    : `0x${head}`;
}

/**
 * Makes text safe for a single grid line: newlines and tabs become visible
 * markers so long/structured values stay readable until the overlay is opened.
 */
function toDisplayText(value: string): string {
  return value.replace(/\r?\n/g, "⏎ ").replace(/\t/g, "→");
}

/** Human-readable display string for a normalized cell value. */
export function formatCellValue(value: CellValue): string {
  switch (value.type) {
    case "null":
      return NULL_DISPLAY;
    case "boolean":
      return value.value ? "true" : "false";
    case "integer":
      return String(value.value);
    case "float":
      return Number.isFinite(value.value) ? String(value.value) : "NaN";
    case "decimal":
      return value.value;
    case "text":
      return toDisplayText(value.value);
    case "bytes":
      return bytesToHexPreview(value.value);
  }
}

/**
 * Text used for the clipboard when a cell is copied.
 *
 * Nulls copy as an empty string and binary values as an unpadded hex string so
 * pasting elsewhere does not inherit grid-only presentation glyphs.
 */
export function cellValueToCopyString(value: CellValue): string {
  switch (value.type) {
    case "null":
      return "";
    case "boolean":
      return value.value ? "true" : "false";
    case "integer":
      return String(value.value);
    case "float":
      return Number.isFinite(value.value) ? String(value.value) : "";
    case "decimal":
      return value.value;
    case "text":
      return value.value;
    case "bytes":
      return value.value
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
  }
}

/** Maps a normalized cell value onto a Glide cell for rendering. */
export function cellValueToGridCell(value: CellValue): GridCell {
  const copyData = cellValueToCopyString(value);

  switch (value.type) {
    case "null":
      return {
        kind: GridCellKind.Text,
        data: "",
        displayData: NULL_DISPLAY,
        allowOverlay: true,
        style: "faded",
        copyData,
      };
    case "boolean":
      return {
        kind: GridCellKind.Boolean,
        data: value.value,
        allowOverlay: false,
        copyData,
      };
    case "integer":
      return {
        kind: GridCellKind.Number,
        data: value.value,
        displayData: String(value.value),
        allowOverlay: true,
        contentAlign: "right",
        copyData,
      };
    case "float":
      return {
        kind: GridCellKind.Number,
        data: Number.isFinite(value.value) ? value.value : undefined,
        displayData: formatCellValue(value),
        allowOverlay: true,
        contentAlign: "right",
        copyData,
      };
    case "decimal":
      // Decimals can exceed JS safe-integer precision, so they stay text.
      return {
        kind: GridCellKind.Text,
        data: value.value,
        displayData: value.value,
        allowOverlay: true,
        contentAlign: "right",
        copyData,
      };
    case "text":
      return {
        kind: GridCellKind.Text,
        data: value.value,
        displayData: toDisplayText(value.value),
        allowOverlay: true,
        copyData,
      };
    case "bytes":
      return {
        kind: GridCellKind.Text,
        data: bytesToHexPreview(value.value),
        displayData: bytesToHexPreview(value.value),
        allowOverlay: true,
        copyData,
      };
  }
}

/**
 * Converts an edited Glide cell back into a normalized cell value.
 *
 * The prototype keeps edits in memory only. The previous value's normalized
 * type decides how the parsed text is interpreted, so editing a numeric column
 * does not silently turn it into free text.
 */
export function gridCellToCellValue(
  cell: EditableGridCell,
  previous: CellValue,
): CellValue {
  switch (cell.kind) {
    case GridCellKind.Boolean:
      return { type: "boolean", value: cell.data === true };
    case GridCellKind.Number:
      if (typeof cell.data !== "number") {
        return previous;
      }
      if (previous.type === "float" || previous.type === "decimal") {
        return { type: "decimal", value: String(cell.data) };
      }
      return { type: "integer", value: Math.trunc(cell.data) };
    case GridCellKind.Text:
    case GridCellKind.Uri:
    case GridCellKind.Markdown: {
      if (previous.type === "bytes") {
        // Binary editing is not part of the prototype.
        return previous;
      }
      if (
        previous.type === "integer" ||
        previous.type === "float" ||
        previous.type === "decimal"
      ) {
        return { type: "decimal", value: cell.data };
      }
      if (previous.type === "null" && cell.data.length === 0) {
        return { type: "null" };
      }
      return { type: "text", value: cell.data };
    }
    default:
      return previous;
  }
}
