import type { ObjectRef } from "../../domain";

/**
 * Quotes a SQLite identifier with double quotes.
 *
 * Embedded double quotes are doubled so a name containing quotes cannot break
 * out of the identifier.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Builds the starter `SELECT` shown when a user picks a table or view. */
export function selectStatementFor(object: ObjectRef): string {
  return `SELECT * FROM ${quoteIdentifier(object.name)};`;
}
