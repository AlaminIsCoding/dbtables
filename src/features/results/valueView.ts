import type { CellValue } from "../../domain";
import { NULL_DISPLAY } from "./cellValue";

/**
 * Display-ready content for the cell value viewer.
 *
 * The grid flattens newlines and elides long/binary values so a cell stays one
 * line. The viewer is the unbounded counterpart: it preserves the full text and
 * pretty-prints JSON-like structured values so they remain inspectable.
 */
export interface ViewerContent {
  /** Full text to render (newlines preserved). */
  text: string;
  /** Whether the text was recognized as JSON and pretty-printed. */
  structured: boolean;
  /** Byte length for binary values, when applicable. */
  byteLength?: number;
}

function bytesToSpacedHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** Whether a text value is a JSON object/array worth pretty-printing. */
export function isStructuredText(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Full text for a cell value, pretty-printing top-level JSON objects/arrays.
 *
 * A JSON value that cannot be parsed is shown as-is rather than being dropped,
 * so a viewer never hides a value it does not understand.
 */
export function formatValueForViewer(value: CellValue): ViewerContent {
  switch (value.type) {
    case "null":
      return { text: NULL_DISPLAY, structured: false };
    case "boolean":
      return { text: value.value ? "true" : "false", structured: false };
    case "integer":
      return { text: String(value.value), structured: false };
    case "float":
      return {
        text: Number.isFinite(value.value) ? String(value.value) : "NaN",
        structured: false,
      };
    case "decimal":
      return { text: value.value, structured: false };
    case "bytes":
      return {
        text: bytesToSpacedHex(value.value),
        structured: false,
        byteLength: value.value.length,
      };
    case "text": {
      if (isStructuredText(value.value)) {
        return {
          text: JSON.stringify(JSON.parse(value.value), null, 2),
          structured: true,
        };
      }
      return { text: value.value, structured: false };
    }
  }
}
