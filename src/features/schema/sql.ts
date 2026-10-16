import type {
  ColumnAlteration,
  ColumnDefinition,
  EngineId,
  ForeignKeyDefinition,
  ObjectRef,
  TableDefinition,
} from "@/domain";
import { quoteIdentifierFor } from "@/lib/sql-ident";

/**
 * Quotes an identifier for the generated SQL preview.
 *
 * This is display-only: the backend validates and quotes every identifier it
 * actually executes, so the preview never has to match an engine's exact
 * quoting rules. Double quotes (the SQL standard) are the default; pass an
 * `engine` to preview MySQL's backticks instead.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Renders a possibly-qualified object name for the preview. */
export function quoteObject(
  object: ObjectRef,
  engine?: EngineId | null,
): string {
  return [object.database, object.schema, object.name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => quoteIdentifierFor(engine, part))
    .join(".");
}

/** Renders a comma-separated, quoted column list. */
export function renderColumnList(
  columns: readonly string[],
  engine?: EngineId | null,
): string {
  return columns
    .map((column) => quoteIdentifierFor(engine, column))
    .join(", ");
}

/** Renders a single column clause as used by `CREATE TABLE`/`ADD COLUMN`. */
export function renderColumnDefinition(
  column: ColumnDefinition,
  engine?: EngineId | null,
): string {
  const parts = [
    quoteIdentifierFor(engine, column.name),
    column.typeName.trim() || "TEXT",
  ];
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
  engine?: EngineId | null,
): string {
  const name = foreignKey.name?.trim()
    ? quoteIdentifierFor(engine, foreignKey.name.trim())
    : quoteIdentifierFor(
        engine,
        generatedForeignKeyName(table, foreignKey.columns),
      );
  const target = foreignKey.referencedSchema?.trim()
    ? `${quoteIdentifierFor(
        engine,
        foreignKey.referencedSchema.trim(),
      )}.${quoteIdentifierFor(engine, foreignKey.referencedTable)}`
    : quoteIdentifierFor(engine, foreignKey.referencedTable);
  return `CONSTRAINT ${name} FOREIGN KEY (${renderColumnList(
    foreignKey.columns,
    engine,
  )}) REFERENCES ${target} (${renderColumnList(
    foreignKey.referencedColumns,
    engine,
  )})`;
}

/** `ALTER TABLE ... ADD COLUMN ...`. */
export function renderAddColumn(
  object: ObjectRef,
  column: ColumnDefinition,
  engine?: EngineId | null,
): string {
  return `ALTER TABLE ${quoteObject(object, engine)} ADD COLUMN ${renderColumnDefinition(
    column,
    engine,
  )};`;
}

/** `ALTER TABLE ... RENAME COLUMN ... TO ...`. */
export function renderRenameColumn(
  object: ObjectRef,
  from: string,
  to: string,
  engine?: EngineId | null,
): string {
  return `ALTER TABLE ${quoteObject(object, engine)} RENAME COLUMN ${quoteIdentifierFor(
    engine,
    from,
  )} TO ${quoteIdentifierFor(engine, to)};`;
}

/** `ALTER TABLE ... DROP COLUMN ...`. */
export function renderDropColumn(
  object: ObjectRef,
  column: string,
  engine?: EngineId | null,
): string {
  return `ALTER TABLE ${quoteObject(object, engine)} DROP COLUMN ${quoteIdentifierFor(
    engine,
    column,
  )};`;
}

/**
 * `ALTER TABLE ... ALTER/MODIFY COLUMN ...` preview for a column alteration.
 *
 * PostgreSQL keeps the requested aspects as separate actions; MySQL restates
 * the whole column with `MODIFY COLUMN`. The preview is illustrative — the
 * backend additionally preserves an existing default that the request omits.
 */
export function renderAlterColumn(
  object: ObjectRef,
  alteration: ColumnAlteration,
  engine?: EngineId | null,
): string {
  const column = quoteIdentifierFor(engine, alteration.name);

  if (engine === "mysql") {
    const parts = [`MODIFY COLUMN ${column}`];
    if (alteration.typeName !== undefined) {
      parts.push(alteration.typeName.trim());
    }
    if (alteration.nullable !== undefined) {
      parts.push(alteration.nullable ? "NULL" : "NOT NULL");
    }
    if (alteration.dropDefault) {
      parts.push("DROP DEFAULT");
    } else if (alteration.setDefault !== undefined) {
      parts.push(`DEFAULT ${alteration.setDefault.trim()}`);
    }
    return `ALTER TABLE ${quoteObject(object, engine)} ${parts.join(" ")};`;
  }

  const actions: string[] = [];
  if (alteration.typeName !== undefined) {
    actions.push(`ALTER COLUMN ${column} TYPE ${alteration.typeName.trim()}`);
  }
  if (alteration.nullable !== undefined) {
    actions.push(
      `ALTER COLUMN ${column} ${alteration.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`,
    );
  }
  if (alteration.dropDefault) {
    actions.push(`ALTER COLUMN ${column} DROP DEFAULT`);
  } else if (alteration.setDefault !== undefined) {
    actions.push(
      `ALTER COLUMN ${column} SET DEFAULT ${alteration.setDefault.trim()}`,
    );
  }
  return `ALTER TABLE ${quoteObject(object, engine)} ${actions.join(", ")};`;
}

/** `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...`. */
export function renderAddForeignKey(
  object: ObjectRef,
  foreignKey: ForeignKeyDefinition,
  engine?: EngineId | null,
): string {
  return `ALTER TABLE ${quoteObject(object, engine)} ADD ${renderInlineForeignKey(
    object.name,
    foreignKey,
    engine,
  )};`;
}

/** `ALTER TABLE ... DROP CONSTRAINT ...`. */
export function renderDropForeignKey(
  object: ObjectRef,
  name: string,
  engine?: EngineId | null,
): string {
  return `ALTER TABLE ${quoteObject(object, engine)} DROP CONSTRAINT ${quoteIdentifierFor(
    engine,
    name,
  )};`;
}

/** `CREATE [UNIQUE] INDEX ... ON ...`. */
export function renderCreateIndex(
  object: ObjectRef,
  name: string,
  columns: readonly string[],
  unique: boolean,
  engine?: EngineId | null,
): string {
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentifierFor(
    engine,
    name,
  )} ON ${quoteObject(object, engine)} (${renderColumnList(columns, engine)});`;
}

/**
 * `DROP INDEX ...`.
 *
 * MySQL needs `DROP INDEX name ON table`, but this preview takes only the index
 * name; the backend emits the full engine-correct statement.
 */
export function renderDropIndex(
  name: string,
  engine?: EngineId | null,
): string {
  return `DROP INDEX ${quoteIdentifierFor(engine, name)};`;
}

/** Renders a full `CREATE TABLE` statement for the preview. */
export function renderCreateTable(
  definition: TableDefinition,
  engine?: EngineId | null,
): string {
  const clauses = definition.columns.map((column) =>
    renderColumnDefinition(column, engine),
  );
  for (const foreignKey of definition.foreignKeys ?? []) {
    clauses.push(
      renderInlineForeignKey(definition.object.name, foreignKey, engine),
    );
  }
  return `CREATE TABLE ${quoteObject(definition.object, engine)} (\n  ${clauses.join(
    ",\n  ",
  )}\n);`;
}
