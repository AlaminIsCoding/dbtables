import type {
  CellValue,
  ColumnInfo,
  FilterOperator,
  SortKey,
  TableFilter,
} from "../../domain";

/** How many bound values an operator consumes. */
export type FilterValueArity = "none" | "one" | "many";

/** One selectable filter operator with a user-facing label. */
export interface FilterOperatorOption {
  operator: FilterOperator;
  label: string;
  arity: FilterValueArity;
}

/**
 * Operators offered by the read-only browser.
 *
 * This is intentionally a fixed list of comparisons rather than a query builder:
 * every operator maps to a backend-validated column plus bound values.
 */
export const FILTER_OPERATORS: readonly FilterOperatorOption[] = [
  { operator: "equal", label: "=", arity: "one" },
  { operator: "not_equal", label: "≠", arity: "one" },
  { operator: "less_than", label: "<", arity: "one" },
  { operator: "less_than_or_equal", label: "≤", arity: "one" },
  { operator: "greater_than", label: ">", arity: "one" },
  { operator: "greater_than_or_equal", label: "≥", arity: "one" },
  { operator: "like", label: "contains", arity: "one" },
  { operator: "in", label: "in list", arity: "many" },
  { operator: "is_null", label: "is null", arity: "none" },
  { operator: "is_not_null", label: "is not null", arity: "none" },
];

/** Looks up an operator option; unknown operators behave like a scalar compare. */
export function operatorOption(
  operator: FilterOperator,
): FilterOperatorOption {
  return (
    FILTER_OPERATORS.find((option) => option.operator === operator) ?? {
      operator,
      label: operator,
      arity: "one",
    }
  );
}

/** Whether an operator needs the user to supply a value. */
export function operatorNeedsValue(operator: FilterOperator): boolean {
  return operatorOption(operator).arity !== "none";
}

/** Whether an operator accepts a comma-separated list of values. */
export function operatorTakesList(operator: FilterOperator): boolean {
  return operatorOption(operator).arity === "many";
}

function numericText(value: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

/**
 * Converts raw filter input into a bound {@link CellValue}.
 *
 * The column's engine-reported type chooses the interpretation so a numeric
 * column is compared numerically; the parsed value is a bound parameter, never
 * interpolated SQL. Unparseable input falls back to text rather than guessing.
 */
export function parseFilterCellValue(
  raw: string,
  column: ColumnInfo,
): CellValue {
  const type = (column.typeName ?? "").toLowerCase();
  const value = raw.trim();

  if (type.includes("bool")) {
    const lowered = value.toLowerCase();
    if (lowered === "true" || lowered === "1") {
      return { type: "boolean", value: true };
    }
    if (lowered === "false" || lowered === "0") {
      return { type: "boolean", value: false };
    }
    return { type: "text", value: raw };
  }

  if (type.includes("int") || type.includes("serial")) {
    if (/^[+-]?\d+$/.test(value)) {
      if (Number.isSafeInteger(Number(value))) {
        return { type: "integer", value: Number(value) };
      }
      return { type: "decimal", value };
    }
    return { type: "text", value: raw };
  }

  if (type.includes("decimal") || type.includes("numeric") || type.includes("money")) {
    return numericText(value)
      ? { type: "decimal", value }
      : { type: "text", value: raw };
  }

  if (type.includes("float") || type.includes("double") || type.includes("real")) {
    return numericText(value)
      ? { type: "float", value: Number(value) }
      : { type: "text", value: raw };
  }

  return { type: "text", value: raw };
}

/**
 * Builds a validated {@link TableFilter}, or `null` when the input is
 * incomplete.
 *
 * The column must be a known column and the operator's value requirement must be
 * satisfied; validation here is a convenience so obviously empty filters are not
 * sent to the backend, which validates identifiers again regardless.
 */
export function createTableFilter(
  column: ColumnInfo,
  operator: FilterOperator,
  rawValue: string,
): TableFilter | null {
  if (column.name.length === 0) {
    return null;
  }

  if (!operatorNeedsValue(operator)) {
    return { column: column.name, operator };
  }

  if (operatorTakesList(operator)) {
    const parts = rawValue
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      return null;
    }
    return {
      column: column.name,
      operator,
      values: parts.map((part) => parseFilterCellValue(part, column)),
    };
  }

  if (rawValue.trim().length === 0) {
    return null;
  }

  return {
    column: column.name,
    operator,
    values: [parseFilterCellValue(rawValue, column)],
  };
}

/** Short human-readable description of a filter for the active-filter list. */
export function describeFilter(filter: TableFilter): string {
  const option = operatorOption(filter.operator);
  const values = filter.values ?? [];

  if (option.arity === "none") {
    return `${filter.column} ${option.label}`;
  }

  const rendered = values
    .map((value) => {
      switch (value.type) {
        case "null":
          return "NULL";
        case "text":
        case "decimal":
          return value.value;
        case "integer":
        case "float":
        case "boolean":
          return String(value.value);
        case "bytes":
          return `0x${value.value
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")}`;
      }
    })
    .join(", ");

  return `${filter.column} ${option.label} ${rendered}`;
}

/** The sort column currently applied, or `null` when unsorted. */
export function sortColumnOf(sort: SortKey[]): string | null {
  return sort.length > 0 ? sort[0].column : null;
}

/** The direction currently applied, defaulting to ascending. */
export function sortDirectionOf(sort: SortKey[]): "ascending" | "descending" {
  return sort.length > 0 ? sort[0].direction : "ascending";
}

/**
 * Replaces the ordering with a single key.
 *
 * The backend appends the row identity as a tie-breaker, so a single primary
 * sort key is enough for stable offset paging.
 */
export function singleSortKey(column: string, direction: "ascending" | "descending"): SortKey[] {
  if (column.length === 0) {
    return [];
  }
  return [{ column, direction }];
}
