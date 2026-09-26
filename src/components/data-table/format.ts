import type { CellValue } from "@/domain";
import { formatCellValue } from "@/features/results/cellValue";
import {
  baseValueForColumn,
  cellValueToEditText,
  parseEditedCellValue,
  parseColumnText,
  type EditParseResult,
} from "@/features/table-data/editorValue";

/** Column metadata the data table renders in its header. */
export interface DataTableColumn {
  /** Column label as returned by the engine. */
  name: string;
  /** Engine-reported type name, shown muted in the header. */
  typeName?: string;
  /** Whether the column is (part of) the primary key. */
  primaryKey?: boolean;
  /** Referenced table/column, when the column is a foreign key. */
  foreignKey?: { refTable: string; refColumn: string } | null;
  /** Explicit starting width in pixels; otherwise derived from the type. */
  width?: number;
}

const BOOLEAN_WIDTH = 90;
const INTEGER_WIDTH = 110;
const FLOAT_WIDTH = 120;
const DECIMAL_WIDTH = 140;
const TEMPORAL_WIDTH = 190;
const STRUCTURED_WIDTH = 300;
const WIDE_TEXT_WIDTH = 320;
const TEXT_WIDTH = 176;

/** Heuristic starting column width from the engine type and column name. */
export function columnWidthFor(column: DataTableColumn): number {
  if (typeof column.width === "number") {
    return column.width;
  }
  const name = column.name.toLowerCase();
  const type = (column.typeName ?? "").toLowerCase();

  if (type.includes("bool")) return BOOLEAN_WIDTH;
  if (type.includes("json") || type.includes("struct") || type.includes("array")) {
    return STRUCTURED_WIDTH;
  }
  if (type.includes("int") || type.includes("serial")) return INTEGER_WIDTH;
  if (type.includes("decimal") || type.includes("numeric") || type.includes("money")) {
    return DECIMAL_WIDTH;
  }
  if (type.includes("float") || type.includes("double") || type.includes("real")) {
    return FLOAT_WIDTH;
  }
  if (type.includes("date") || type.includes("time")) return TEMPORAL_WIDTH;
  if (/(notes?|description|comment|body|content|message)/.test(name)) {
    return WIDE_TEXT_WIDTH;
  }
  if (name === "id" || name.endsWith("_id") || name.endsWith("id")) {
    return INTEGER_WIDTH;
  }
  return TEXT_WIDTH;
}

export { formatCellValue };

/** Editable text for a value as shown inside the inline cell editor. */
export function cellEditText(value: CellValue): string {
  return cellValueToEditText(value);
}

/** Parses inline editor text using the previous value's normalized type. */
export function parseCellEdit(raw: string, previous: CellValue): EditParseResult {
  return parseEditedCellValue(raw, previous);
}

/** Parses text typed for a column with no previous value (staged insert). */
export function parseColumnEdit(
  raw: string,
  column: { name: string; typeName?: string; nullable?: boolean },
): EditParseResult {
  return parseColumnText(raw, column);
}

export { baseValueForColumn };
