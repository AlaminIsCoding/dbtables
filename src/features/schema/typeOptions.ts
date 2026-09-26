/** Column type choices offered by the schema editors. */
export const TYPE_OPTIONS = [
  "INTEGER",
  "TEXT",
  "REAL",
  "BLOB",
  "NUMERIC",
  "BOOLEAN",
  "VARCHAR(255)",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "DECIMAL(10,2)",
  "JSON",
  "UUID",
];

/** Sentinel for a "none" choice, because Radix Select forbids empty values. */
export const NONE = "__none__";
