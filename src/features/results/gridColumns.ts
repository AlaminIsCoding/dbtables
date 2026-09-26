import type { GridColumn } from "@glideapps/glide-data-grid";

import type { ColumnInfo } from "../../domain";

const BOOLEAN_WIDTH = 84;
const INTEGER_WIDTH = 96;
const ID_WIDTH = 96;
const FLOAT_WIDTH = 112;
const DECIMAL_WIDTH = 132;
const TEXT_WIDTH = 168;
const TEMPORAL_WIDTH = 188;
const STRUCTURED_WIDTH = 300;
const WIDE_TEXT_WIDTH = 320;

/**
 * Chooses a starting column width from the engine-reported type and the column
 * name. This is a heuristic for the prototype; database-backed browsing can
 * replace it with saved widths from result metadata.
 */
export function columnWidthFor(column: ColumnInfo): number {
  const name = column.name.toLowerCase();
  const type = (column.typeName ?? "").toLowerCase();

  if (type.includes("bool")) {
    return BOOLEAN_WIDTH;
  }
  if (type.includes("json") || type.includes("struct") || type.includes("array")) {
    return STRUCTURED_WIDTH;
  }
  if (type.includes("int") || type.includes("serial")) {
    return INTEGER_WIDTH;
  }
  if (type.includes("decimal") || type.includes("numeric") || type.includes("money")) {
    return DECIMAL_WIDTH;
  }
  if (type.includes("float") || type.includes("double") || type.includes("real")) {
    return FLOAT_WIDTH;
  }
  if (type.includes("date") || type.includes("time")) {
    return TEMPORAL_WIDTH;
  }
  if (/(notes?|description|comment|body|content|message)/.test(name)) {
    return WIDE_TEXT_WIDTH;
  }
  if (name === "id" || name.endsWith("_id") || name.endsWith("id")) {
    return ID_WIDTH;
  }
  if (type.includes("char") || type.includes("text") || type.includes("clob")) {
    return TEXT_WIDTH;
  }

  return TEXT_WIDTH;
}

/**
 * Builds Glide columns from normalized `ColumnInfo`.
 *
 * Titles are de-duplicated because engines can return repeated labels (for
 * example, two joined `id` columns) and Glide expects stable, unique titles.
 */
export function columnsToGridColumns(columns: ColumnInfo[]): GridColumn[] {
  const seen = new Map<string, number>();

  return columns.map((column, index) => {
    const count = seen.get(column.name) ?? 0;
    seen.set(column.name, count + 1);
    const title = count === 0 ? column.name : `${column.name} (${count + 1})`;

    return {
      id: `${column.name}-${index}`,
      title,
      width: columnWidthFor(column),
    };
  });
}
