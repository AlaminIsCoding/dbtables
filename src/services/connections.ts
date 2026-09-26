import { invoke } from "@tauri-apps/api/core";

import type { ConnectionState } from "../domain";

/** Keep command names in sync with `src-tauri/src/commands/connections.rs`. */
export const CONNECT_SQLITE_COMMAND = "connect_sqlite";
export const DISCONNECT_CONNECTION_COMMAND = "disconnect_connection";
export const CONNECTION_STATE_COMMAND = "connection_state";

/**
 * Opens a local SQLite file read-only and returns an opaque connection token.
 *
 * The path is non-secret profile data; no driver handle crosses the boundary.
 */
export async function connectSqlite(filePath: string): Promise<string> {
  return invoke<string>(CONNECT_SQLITE_COMMAND, { filePath });
}

/** Closes a connection previously returned by {@link connectSqlite}. */
export async function disconnectConnection(
  connectionId: string,
): Promise<void> {
  return invoke<void>(DISCONNECT_CONNECTION_COMMAND, { connectionId });
}

/** Reports the backend's current state for a known connection. */
export async function getConnectionState(
  connectionId: string,
): Promise<ConnectionState> {
  return invoke<ConnectionState>(CONNECTION_STATE_COMMAND, { connectionId });
}
