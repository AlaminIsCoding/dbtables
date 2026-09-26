import type { CellValue, ColumnInfo } from "../../domain";

/** Whether a value can be edited as text in the value editor. */
export function isEditableValue(value: CellValue): boolean {
  return value.type !== "bytes";
}

/**
 * Text shown in the editor for a normalized value.
 *
 * Nulls edit as an empty string; every other scalar uses its natural textual
 * form. Binary values are not editable and should not reach here.
 */
export function cellValueToEditText(value: CellValue): string {
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
        .join(" ");
  }
}

/** Result of parsing editor text into a normalized value. */
export type EditParseResult =
  | { ok: true; value: CellValue }
  | { ok: false; message: string };

function numericText(value: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

/**
 * Parses editor text using the value's current type so editing a numeric or
 * boolean column does not silently become free text.
 *
 * A blank string on a nullable value becomes SQL `NULL`. Unparseable input is
 * rejected with a message rather than coerced.
 */
export function parseEditedCellValue(
  raw: string,
  previous: CellValue,
): EditParseResult {
  const text = raw;
  const trimmed = text.trim();

  switch (previous.type) {
    case "null":
      return trimmed.length === 0
        ? { ok: true, value: { type: "null" } }
        : { ok: true, value: { type: "text", value: text } };
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (lowered === "true" || lowered === "1") {
        return { ok: true, value: { type: "boolean", value: true } };
      }
      if (lowered === "false" || lowered === "0") {
        return { ok: true, value: { type: "boolean", value: false } };
      }
      return { ok: false, message: "Enter true or false." };
    }
    case "integer": {
      if (!/^[+-]?\d+$/.test(trimmed)) {
        return { ok: false, message: "Enter a whole number." };
      }
      if (!Number.isSafeInteger(Number(trimmed))) {
        return { ok: true, value: { type: "decimal", value: trimmed } };
      }
      return { ok: true, value: { type: "integer", value: Number(trimmed) } };
    }
    case "float": {
      if (!numericText(trimmed)) {
        return { ok: false, message: "Enter a number." };
      }
      return { ok: true, value: { type: "float", value: Number(trimmed) } };
    }
    case "decimal": {
      if (!numericText(trimmed)) {
        return { ok: false, message: "Enter a number." };
      }
      return { ok: true, value: { type: "decimal", value: trimmed } };
    }
    case "text":
      return { ok: true, value: { type: "text", value: text } };
    case "bytes":
      return {
        ok: false,
        message: "Binary values cannot be edited in this view.",
      };
  }
}

/**
 * A neutral value of the closest normalized type for a column, used as the
 * parse context when creating a brand-new value with no previous row value.
 *
 * Only the type matters here; the value is a placeholder replaced by parsing
 * the user's text. Unknown types fall back to text.
 */
export function baseValueForColumn(column: ColumnInfo): CellValue {
  const type = (column.typeName ?? "").toLowerCase();
  if (type.includes("bool")) {
    return { type: "boolean", value: false };
  }
  if (type.includes("int") || type.includes("serial")) {
    return { type: "integer", value: 0 };
  }
  if (type.includes("decimal") || type.includes("numeric") || type.includes("money")) {
    return { type: "decimal", value: "0" };
  }
  if (type.includes("float") || type.includes("double") || type.includes("real")) {
    return { type: "float", value: 0 };
  }
  return { type: "text", value: "" };
}

/**
 * Parses text typed for a column using the column's declared type, so a value
 * entered for a new row keeps the column's numeric/boolean shape.
 *
 * An empty string on a nullable column is SQL `NULL`; on a required column it
 * is rejected so the caller can ask for a value instead of writing garbage.
 */
export function parseColumnText(
  raw: string,
  column: ColumnInfo,
): EditParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (column.nullable === false) {
      return { ok: false, message: `${column.name} is required.` };
    }
    return { ok: true, value: { type: "null" } };
  }
  return parseEditedCellValue(raw, baseValueForColumn(column));
}
