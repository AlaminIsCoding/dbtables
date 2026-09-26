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
 * markers so long/structured values stay readable.
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
