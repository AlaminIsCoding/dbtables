import type { EngineId, ObjectRef } from "@/domain";

/**
 * Quotes an identifier for `engine`'s SQL dialect.
 *
 * MySQL uses backticks (double quotes are string literals there); SQLite and
 * PostgreSQL use ANSI double quotes. This is for SQL the app suggests to the
 * user; the backend independently validates and quotes identifiers it executes.
 */
export function quoteIdentifierFor(
  engine: EngineId | null | undefined,
  identifier: string,
): string {
  if (engine === "mysql") {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Quotes a possibly-qualified object reference for `engine`'s dialect. */
export function quotedObjectName(
  engine: EngineId | null | undefined,
  object: ObjectRef,
): string {
  return [object.database, object.schema, object.name]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .map((part) => quoteIdentifierFor(engine, part))
    .join(".");
}
