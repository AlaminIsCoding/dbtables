import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  ObjectRef,
  TableDefinition,
} from "@/domain";

/**
 * Quotes an identifier for the generated SQL preview.
 *
 * This is display-only: the backend validates and quotes every identifier it
 * actually executes, so the preview never has to match an engine's exact
 * quoting rules. Double quotes are the SQL standard and read cleanly next to
 * the uppercase keywords.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Renders a possibly-qualified object name for the preview. */
export function quoteObject(object: ObjectRef): string {
  return [object.database, object.schema, object.name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map(quoteIdentifier)
    .join(".");
}

/** Renders a comma-separated, quoted column list. */
export function renderColumnList(columns: readonly string[]): string {
  return columns.map(quoteIdentifier).join(", ");
}

/** Renders a single column clause as used by `CREATE TABLE`/`ADD COLUMN`. */
export function renderColumnDefinition(column: ColumnDefinition): string {
  const parts = [quoteIdentifier(column.name), column.typeName.trim() || "TEXT"];
  if (!column.nullable) {
    parts.push("NOT NULL");
  }
  if (column.primaryKey) {
    parts.push("PRIMARY KEY");
  }
  const fallback = column.default?.trim();
  if (fallback) {
    parts.push(`DEFAULT ${fallback}`);
  }
  return parts.join(" ");
}

/** Deterministic constraint name, matching the backend's generated label. */
export function generatedForeignKeyName(
  table: string,
  columns: readonly string[],
): string {
  return `${table}_${columns.join("_")}_fkey`;
}

/** Renders an inline `FOREIGN KEY` table constraint for `CREATE TABLE`. */
export function renderInlineForeignKey(
  table: string,
  foreignKey: ForeignKeyDefinition,
): string {
  const name = foreignKey.name?.trim()
    ? quoteIdentifier(foreignKey.name.trim())
    : quoteIdentifier(generatedForeignKeyName(table, foreignKey.columns));
  const target = foreignKey.referencedSchema?.trim()
    ? `${quoteIdentifier(foreignKey.referencedSchema.trim())}.${quoteIdentifier(
        foreignKey.referencedTable,
      )}`
    : quoteIdentifier(foreignKey.referencedTable);
  return `CONSTRAINT ${name} FOREIGN KEY (${renderColumnList(
    foreignKey.columns,
  )}) REFERENCES ${target} (${renderColumnList(foreignKey.referencedColumns)})`;
}

/** `ALTER TABLE ... ADD COLUMN ...`. */
export function renderAddColumn(
  object: ObjectRef,
  column: ColumnDefinition,
): string {
  return `ALTER TABLE ${quoteObject(object)} ADD COLUMN ${renderColumnDefinition(column)};`;
}

/** `ALTER TABLE ... RENAME COLUMN ... TO ...`. */
export function renderRenameColumn(
  object: ObjectRef,
  from: string,
  to: string,
): string {
  return `ALTER TABLE ${quoteObject(object)} RENAME COLUMN ${quoteIdentifier(
    from,
  )} TO ${quoteIdentifier(to)};`;
}

/** `ALTER TABLE ... DROP COLUMN ...`. */
export function renderDropColumn(object: ObjectRef, column: string): string {
  return `ALTER TABLE ${quoteObject(object)} DROP COLUMN ${quoteIdentifier(column)};`;
}

/** `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...`. */
export function renderAddForeignKey(
  object: ObjectRef,
  foreignKey: ForeignKeyDefinition,
): string {
  return `ALTER TABLE ${quoteObject(object)} ADD ${renderInlineForeignKey(
    object.name,
    foreignKey,
  )};`;
}

/** `ALTER TABLE ... DROP CONSTRAINT ...`. */
export function renderDropForeignKey(object: ObjectRef, name: string): string {
  return `ALTER TABLE ${quoteObject(object)} DROP CONSTRAINT ${quoteIdentifier(
    name,
  )};`;
}

/** `CREATE [UNIQUE] INDEX ... ON ...`. */
export function renderCreateIndex(
  object: ObjectRef,
  name: string,
  columns: readonly string[],
  unique: boolean,
): string {
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(
    name,
  )} ON ${quoteObject(object)} (${renderColumnList(columns)});`;
}

/** `DROP INDEX ...`. */
export function renderDropIndex(name: string): string {
  return `DROP INDEX ${quoteIdentifier(name)};`;
}

/** Renders a full `CREATE TABLE` statement for the preview. */
export function renderCreateTable(definition: TableDefinition): string {
  const clauses = definition.columns.map(renderColumnDefinition);
  for (const foreignKey of definition.foreignKeys ?? []) {
    clauses.push(renderInlineForeignKey(definition.object.name, foreignKey));
  }
  return `CREATE TABLE ${quoteObject(definition.object)} (\n  ${clauses.join(
    ",\n  ",
  )}\n);`;
}
