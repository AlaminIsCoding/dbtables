import { invoke } from "@tauri-apps/api/core";

import type {
  ObjectRef,
  ObjectScope,
  ScopeListing,
  TableDescription,
} from "../domain";

/** Keep the command names in sync with `src-tauri/src/commands/metadata.rs`. */
export const LIST_OBJECTS_COMMAND = "list_objects";
export const LIST_SCOPES_COMMAND = "list_scopes";
export const DESCRIBE_TABLE_COMMAND = "describe_table";

/**
 * Lists tables and views visible to a connection.
 *
 * When `scope` is omitted the backend uses the connection's default
 * database/schema. SQLite exposes no scope, so the parameter is only meaningful
 * for engines with separate catalogs/schemas.
 */
export async function listObjects(
  connectionId: string,
  scope?: ObjectScope,
): Promise<ObjectRef[]> {
  if (scope) {
    return invoke<ObjectRef[]>(LIST_OBJECTS_COMMAND, { connectionId, scope });
  }

  return invoke<ObjectRef[]>(LIST_OBJECTS_COMMAND, { connectionId });
}

/**
 * Lists the database/catalog and schema scopes a connection can address.
 *
 * Engines that expose neither (SQLite) reject with an `unsupported`
 * `QueryError`, which callers should treat as "no scope picker" rather than a
 * failure.
 */
export async function listScopes(connectionId: string): Promise<ScopeListing> {
  return invoke<ScopeListing>(LIST_SCOPES_COMMAND, { connectionId });
}

/**
 * Describes the columns, primary key, indexes, and constraints of an object.
 *
 * Absent `indexes`/`constraints` mean the adapter cannot inspect that category;
 * an empty array means it inspected the object and found none. Callers must
 * preserve that distinction when presenting metadata.
 */
export async function describeTable(
  connectionId: string,
  object: ObjectRef,
): Promise<TableDescription> {
  return invoke<TableDescription>(DESCRIBE_TABLE_COMMAND, {
    connectionId,
    object,
  });
}
