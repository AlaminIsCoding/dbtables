import type { CellValue, QueryResult } from "../../domain";
import { cellValueToCopyString } from "./cellValue";

/**
 * Builds clipboard text for the explicit copy flows.
 *
 * Single-cell copy keeps the exact value (including newlines), matching the
 * grid's per-cell copy. Multi-cell copies are tab-separated (one line per row)
 * so pasting into a spreadsheet keeps the table shape; tabs and newlines inside
 * a value are collapsed to a single space because they would otherwise break
 * that shape.
 */

/** Field text for a tab/newline-separated multi-cell copy. */
function clipboardField(value: CellValue): string {
  return cellValueToCopyString(value).replace(/[\t\r\n]+/g, " ");
}

/** Header field text, collapsed the same way as data fields. */
function headerField(name: string): string {
  return name.replace(/[\t\r\n]+/g, " ");
}

/** Clipboard text for a single cell; nulls copy as an empty string. */
export function cellCopyText(value: CellValue): string {
  return cellValueToCopyString(value);
}

/** Tab-separated clipboard text for one row, or `""` when out of range. */
export function rowCopyText(result: QueryResult, rowIndex: number): string {
  const row = result.rows?.[rowIndex];
  if (!row) {
    return "";
  }
  return row.map(clipboardField).join("\t");
}

/** Options for {@link resultCopyText}. */
export interface ResultCopyOptions {
  /** Prepend a tab-separated header of column names. Defaults to `true`. */
  includeHeader?: boolean;
}

/**
 * Clipboard text for every loaded row of `result`.
 *
 * Only the bounded rows already fetched are copied; the caller should not
 * assume this is the full database result for a truncated query.
 */
export function resultCopyText(
  result: QueryResult,
  options: ResultCopyOptions = {},
): string {
  const includeHeader = options.includeHeader ?? true;
  const lines: string[] = [];

  if (includeHeader) {
    lines.push((result.columns ?? []).map((column) => headerField(column.name)).join("\t"));
  }

  for (const row of result.rows ?? []) {
    lines.push(row.map(clipboardField).join("\t"));
  }

  return lines.join("\n");
}
