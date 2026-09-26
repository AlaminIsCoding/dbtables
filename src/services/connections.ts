import { invoke } from "@tauri-apps/api/core";

import type {
  ConnectionDescriptor,
  ConnectionProfile,
  ConnectionState,
  ConnectionTest,
} from "../domain";

/** Keep command names in sync with `src-tauri/src/commands/connections.rs`. */
export const CONNECT_SQLITE_COMMAND = "connect_sqlite";
export const DISCONNECT_CONNECTION_COMMAND = "disconnect_connection";
export const CONNECTION_STATE_COMMAND = "connection_state";
export const LIST_CONNECTION_PROFILES_COMMAND = "list_connection_profiles";
export const SAVE_CONNECTION_PROFILE_COMMAND = "save_connection_profile";
export const DELETE_CONNECTION_PROFILE_COMMAND = "delete_connection_profile";
export const TEST_CONNECTION_PROFILE_COMMAND = "test_connection_profile";
export const CONNECT_PROFILE_COMMAND = "connect_profile";
export const CONNECT_PROFILE_DATABASE_COMMAND = "connect_profile_database";
export const LIST_PROFILE_DATABASES_COMMAND = "list_profile_databases";

/**
 * Submitted profile fields for a create/update or a connection test.
 *
 * `id` is absent when creating a new profile; the backend generates the stable
 * identifier and returns it in the saved {@link ConnectionProfile}.
 *
 * `password` is write-only. When absent or empty on an update, the backend
 * preserves the previously saved secret instead of overwriting it, so an edit
 * can leave the password field blank without clearing the credential.
 */
export interface ConnectionProfileInput {
  /** Existing profile to update; absent to create a new profile. */
  id?: string;
  /** User-facing display name. */
  name: string;
  /** Secret-free routing settings. */
  descriptor: ConnectionDescriptor;
  /** New password. Omit or leave empty to keep the saved secret. */
  password?: string;
}

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

/**
 * Lists saved profiles.
 *
 * Returned profiles are secret-free; the backend never includes a stored
 * password in this response.
 */
export async function listConnectionProfiles(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>(LIST_CONNECTION_PROFILES_COMMAND);
}

/**
 * Creates or replaces a profile and saves its password when one is supplied.
 *
 * The backend validates the non-secret fields, stores any non-empty password
 * through the OS-protected credential store, and returns the saved profile. A
 * blank or omitted password leaves an existing secret untouched.
 */
export async function saveConnectionProfile(
  input: ConnectionProfileInput,
): Promise<ConnectionProfile> {
  return invoke<ConnectionProfile>(SAVE_CONNECTION_PROFILE_COMMAND, { input });
}

/**
 * Removes a profile and its stored secret.
 *
 * Returns `true` when a profile was removed and `false` when the identifier did
 * not match a saved profile.
 */
export async function deleteConnectionProfile(
  profileId: string,
): Promise<boolean> {
  return invoke<boolean>(DELETE_CONNECTION_PROFILE_COMMAND, { profileId });
}

/**
 * Tests the submitted connection settings without retaining a connection.
 *
 * The backend resolves the secret: a non-empty `password` is used as submitted,
 * while an omitted password falls back to the saved secret for `input.id`. A
 * failed test rejects with a normalized, redacted `QueryError`, so the UI can
 * show an actionable message without exposing credentials.
 */
export async function testConnectionProfile(
  input: ConnectionProfileInput,
): Promise<ConnectionTest> {
  return invoke<ConnectionTest>(TEST_CONNECTION_PROFILE_COMMAND, { input });
}

/**
 * Opens a saved profile and returns an opaque connection token.
 *
 * The backend resolves the profile's stored secret; no password crosses this
 * boundary in either direction.
 */
export async function connectProfile(profileId: string): Promise<string> {
  return invoke<string>(CONNECT_PROFILE_COMMAND, { profileId });
}

/**
 * Opens a saved profile against a specific database.
 *
 * A PostgreSQL connection is bound to one database, so choosing a different
 * database opens a new connection with that database. The backend resolves the
 * profile's saved secret; no password crosses this boundary.
 */
export async function connectProfileDatabase(
  profileId: string,
  database: string,
): Promise<string> {
  return invoke<string>(CONNECT_PROFILE_DATABASE_COMMAND, {
    profileId,
    database,
  });
}

/**
 * Lists the databases a server profile can address.
 *
 * Server-level and asked before a database is chosen, so it takes the same
 * write-only input as a test: a supplied password wins, otherwise the saved
 * secret for `input.id` is used. Engines with a single fixed database reject
 * with an `unsupported` error, which callers treat as "no picker".
 */
export async function listProfileDatabases(
  input: ConnectionProfileInput,
): Promise<string[]> {
  return invoke<string[]>(LIST_PROFILE_DATABASES_COMMAND, { input });
}
