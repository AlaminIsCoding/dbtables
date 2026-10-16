import type { EngineId } from "@/domain";

/**
 * Column type choices offered by the schema editors.
 *
 * Each engine accepts a different vocabulary: MySQL has no `UUID` type, and
 * PostgreSQL has neither `BLOB` nor `DATETIME`. Offering the wrong names makes
 * a generated `CREATE TABLE`/`ADD COLUMN` fail at the server, so the list is
 * chosen from the active connection's engine.
 */
const SQLITE_TYPES = [
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
] as const;

const MYSQL_TYPES = [
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "BOOLEAN",
  "VARCHAR(255)",
  "CHAR(36)",
  "TEXT",
  "LONGTEXT",
  "DECIMAL(10,2)",
  "DOUBLE",
  "FLOAT",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "YEAR",
  "JSON",
  "BLOB",
  "LONGBLOB",
] as const;

const POSTGRES_TYPES = [
  "INTEGER",
  "BIGINT",
  "SMALLINT",
  "SERIAL",
  "BIGSERIAL",
  "TEXT",
  "VARCHAR(255)",
  "CHAR(36)",
  "BOOLEAN",
  "NUMERIC(10,2)",
  "DECIMAL(10,2)",
  "REAL",
  "DOUBLE PRECISION",
  "DATE",
  "TIME",
  "TIMESTAMP",
  "TIMESTAMPTZ",
  "JSON",
  "JSONB",
  "UUID",
  "BYTEA",
] as const;

/** Type options for an engine; falls back to the SQLite list when unknown. */
export function typeOptionsFor(
  engine: EngineId | null | undefined,
): readonly string[] {
  switch (engine) {
    case "mysql":
      return MYSQL_TYPES;
    case "postgres":
      return POSTGRES_TYPES;
    default:
      return SQLITE_TYPES;
  }
}

/** Sentinel for a "none" choice, because Radix Select forbids empty values. */
export const NONE = "__none__";
