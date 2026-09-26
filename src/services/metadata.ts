import { invoke } from "@tauri-apps/api/core";

import type { ObjectRef } from "../domain";

/** Keep the command name in sync with `src-tauri/src/commands/metadata.rs`. */
export const LIST_OBJECTS_COMMAND = "list_objects";

/**
 * Lists tables and views visible to a connection.
 *
 * Scope selection is not exposed for SQLite; MySQL/PostgreSQL add it in a
 * later slice.
 */
export async function listObjects(connectionId: string): Promise<ObjectRef[]> {
  return invoke<ObjectRef[]>(LIST_OBJECTS_COMMAND, { connectionId });
}
