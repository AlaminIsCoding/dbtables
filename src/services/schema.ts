import { invoke } from "@tauri-apps/api/core";

import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  ObjectRef,
  TableDefinition,
  TableDescription,
  TableFilter,
} from "@/domain";

/** Keep command names in sync with `src-tauri/src/commands/schema.rs`. */
export const CREATE_TABLE_COMMAND = "create_table";
export const DROP_TABLE_COMMAND = "drop_table";
export const ADD_COLUMN_COMMAND = "add_column";
export const RENAME_COLUMN_COMMAND = "rename_column";
export const DROP_COLUMN_COMMAND = "drop_column";
export const ADD_FOREIGN_KEY_COMMAND = "add_foreign_key";
export const DROP_FOREIGN_KEY_COMMAND = "drop_foreign_key";
export const CREATE_INDEX_COMMAND = "create_index";
export const DROP_INDEX_COMMAND = "drop_index";
export const COUNT_TABLE_ROWS_COMMAND = "count_table_rows";

/**
 * Creates a base table and returns its inspected description.
 *
 * The backend validates every identifier against the engine's rules and quotes
 * it; it never interpolates caller text into SQL.
 */
export async function createTable(
  connectionId: string,
  definition: TableDefinition,
): Promise<TableDescription> {
  return invoke<TableDescription>(CREATE_TABLE_COMMAND, {
    connectionId,
    definition,
  });
}

/** Drops a table. `cascade` is honoured only by engines that support it. */
export async function dropTable(
  connectionId: string,
  object: ObjectRef,
  cascade = false,
): Promise<void> {
  return invoke<void>(DROP_TABLE_COMMAND, { connectionId, object, cascade });
}

/** Adds a column to an existing table. */
export async function addColumn(
  connectionId: string,
  object: ObjectRef,
  column: ColumnDefinition,
): Promise<void> {
  return invoke<void>(ADD_COLUMN_COMMAND, { connectionId, object, column });
}

/** Renames an existing column. */
export async function renameColumn(
  connectionId: string,
  object: ObjectRef,
  from: string,
  to: string,
): Promise<void> {
  return invoke<void>(RENAME_COLUMN_COMMAND, {
    connectionId,
    object,
    from,
    to,
  });
}

/** Drops a column from an existing table. */
export async function dropColumn(
  connectionId: string,
  object: ObjectRef,
  column: string,
): Promise<void> {
  return invoke<void>(DROP_COLUMN_COMMAND, { connectionId, object, column });
}

/** Adds a foreign key to an existing table, where the engine supports it. */
export async function addForeignKey(
  connectionId: string,
  object: ObjectRef,
  foreignKey: ForeignKeyDefinition,
): Promise<void> {
  return invoke<void>(ADD_FOREIGN_KEY_COMMAND, {
    connectionId,
    object,
    foreignKey,
  });
}

/** Drops a named constraint from an existing table. */
export async function dropForeignKey(
  connectionId: string,
  object: ObjectRef,
  name: string,
): Promise<void> {
  return invoke<void>(DROP_FOREIGN_KEY_COMMAND, { connectionId, object, name });
}

/** Creates an index over the given columns. */
export async function createIndex(
  connectionId: string,
  object: ObjectRef,
  name: string,
  columns: string[],
  unique: boolean,
): Promise<void> {
  return invoke<void>(CREATE_INDEX_COMMAND, {
    connectionId,
    object,
    name,
    columns,
    unique,
  });
}

/** Drops a named index. */
export async function dropIndex(
  connectionId: string,
  object: ObjectRef,
  name: string,
): Promise<void> {
  return invoke<void>(DROP_INDEX_COMMAND, { connectionId, object, name });
}

/** Counts rows matching the optional filters. */
export async function countTableRows(
  connectionId: string,
  object: ObjectRef,
  filters?: TableFilter[],
): Promise<number> {
  return invoke<number>(COUNT_TABLE_ROWS_COMMAND, {
    connectionId,
    object,
    filters,
  });
}
