import { useCallback, useEffect, useRef, useState } from "react";

import type { ConnectionProfile, EngineId, QueryError } from "../../domain";
import {
  connectProfile,
  connectProfileDatabase,
  deleteConnectionProfile,
  disconnectConnection,
  listConnectionProfiles,
  saveConnectionProfile,
  testConnectionProfile,
  type ConnectionProfileInput,
} from "../../services/connections";
import { toQueryError } from "../../services/errors";

/** Loading/ready/error state for the saved profile list. */
export type ProfileListState =
  | { status: "loading" }
  | { status: "ready"; profiles: ConnectionProfile[] }
  | { status: "error"; error: QueryError };

/**
 * Lifecycle of the single active profile connection.
 *
 * `database` is present when the connection was opened against a specific
 * database (PostgreSQL, which binds one connection to one database).
 */
export type ActiveConnection =
  | { status: "disconnected" }
  | { status: "connecting"; profileId: string; database?: string }
  | {
      status: "connected";
      profileId: string;
      connectionId: string;
      database?: string;
    }
  | { status: "error"; error: QueryError };

/**
 * Latest test-connection outcome.
 *
 * `targetId` is the profile identifier a list-row test came from, or `null`
 * when the test came from an unsaved form draft.
 */
export type TestStatus =
  | { status: "idle" }
  | { status: "testing"; targetId: string | null }
  | {
      status: "success";
      targetId: string | null;
      engine: EngineId;
      serverVersion?: string;
    }
  | { status: "error"; targetId: string | null; error: QueryError };

/** State of a profile save or removal. */
export type MutationState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "removing"; profileId: string }
  | { status: "error"; error: QueryError };

export interface ConnectionManagerController {
  /** Saved profiles and their load state. */
  profiles: ProfileListState;
  /** The single active profile connection. */
  active: ActiveConnection;
  /** Latest test-connection outcome. */
  test: TestStatus;
  /** Latest save/remove outcome. */
  mutation: MutationState;
  /** Reloads the saved profile list. */
  reload: () => Promise<void>;
  /** Creates or updates a profile; resolves with the saved profile on success. */
  save: (input: ConnectionProfileInput) => Promise<ConnectionProfile | null>;
  /** Removes a profile and its secret; resolves with whether it existed. */
  remove: (profileId: string) => Promise<boolean>;
  /** Tests submitted settings without retaining a connection. */
  testConnection: (
    input: ConnectionProfileInput,
    targetId: string | null,
  ) => Promise<void>;
  /**
   * Connects a saved profile, replacing any current connection.
   *
   * Supplying `options.database` opens the profile against that database, which
   * some engines (PostgreSQL) require in order to switch databases.
   */
  connect: (
    profileId: string,
    options?: { database?: string },
  ) => Promise<void>;
  /** Closes the active connection. */
  disconnect: () => Promise<void>;
  /** Clears a displayed test result. */
  clearTest: () => void;
  /** Clears a displayed save/remove error. */
  clearMutation: () => void;
}

/**
 * Owns saved-profile and connection lifecycle state for the connection manager.
 *
 * Every backend interaction goes through the typed service facade, so the
 * component tree never invokes Tauri commands directly. Only one profile is
 * connected at a time: connecting or removing a different profile replaces the
 * current connection first, and a failed close never blocks the requested
 * change (mirroring the query workspace's replace-on-connect behavior).
 */
export function useConnectionManager(): ConnectionManagerController {
  const [profiles, setProfiles] = useState<ProfileListState>({ status: "loading" });
  const [active, setActive] = useState<ActiveConnection>({ status: "disconnected" });
  const [test, setTest] = useState<TestStatus>({ status: "idle" });
  const [mutation, setMutation] = useState<MutationState>({ status: "idle" });

  const connectionIdRef = useRef<string | null>(null);
  const activeProfileRef = useRef<string | null>(null);
  const activeDatabaseRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setProfiles({ status: "loading" });
    try {
      const saved = await listConnectionProfiles();
      setProfiles({ status: "ready", profiles: saved });
    } catch (error) {
      setProfiles({ status: "error", error: toQueryError(error) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const closeActive = useCallback(async () => {
    const connectionId = connectionIdRef.current;
    connectionIdRef.current = null;
    activeProfileRef.current = null;
    activeDatabaseRef.current = null;
    if (connectionId) {
      try {
        await disconnectConnection(connectionId);
      } catch {
        // The UI is moving on regardless; a failed close must not block the
        // requested change.
      }
    }
  }, []);

  const connect = useCallback(
    async (profileId: string, options?: { database?: string }) => {
      const database = options?.database;
      if (
        activeProfileRef.current === profileId &&
        connectionIdRef.current !== null &&
        activeDatabaseRef.current === (database ?? null)
      ) {
        return;
      }

      setTest({ status: "idle" });
      await closeActive();
      setActive({ status: "connecting", profileId, database });

      try {
        const connectionId = database
          ? await connectProfileDatabase(profileId, database)
          : await connectProfile(profileId);
        connectionIdRef.current = connectionId;
        activeProfileRef.current = profileId;
        activeDatabaseRef.current = database ?? null;
        setActive({ status: "connected", profileId, connectionId, database });
      } catch (error) {
        setActive({ status: "error", error: toQueryError(error) });
      }
    },
    [closeActive],
  );

  const disconnect = useCallback(async () => {
    await closeActive();
    setActive({ status: "disconnected" });
  }, [closeActive]);

  const save = useCallback(
    async (input: ConnectionProfileInput) => {
      setMutation({ status: "saving" });
      try {
        const saved = await saveConnectionProfile(input);
        setMutation({ status: "idle" });
        await reload();
        return saved;
      } catch (error) {
        setMutation({ status: "error", error: toQueryError(error) });
        return null;
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (profileId: string) => {
      setMutation({ status: "removing", profileId });
      if (activeProfileRef.current === profileId) {
        await closeActive();
        setActive({ status: "disconnected" });
      }

      try {
        const removed = await deleteConnectionProfile(profileId);
        setMutation({ status: "idle" });
        await reload();
        return removed;
      } catch (error) {
        setMutation({ status: "error", error: toQueryError(error) });
        return false;
      }
    },
    [closeActive, reload],
  );

  const testConnection = useCallback(
    async (input: ConnectionProfileInput, targetId: string | null) => {
      setTest({ status: "testing", targetId });
      try {
        const result = await testConnectionProfile(input);
        setTest({
          status: "success",
          targetId,
          engine: result.engine,
          serverVersion: result.serverVersion,
        });
      } catch (error) {
        setTest({ status: "error", targetId, error: toQueryError(error) });
      }
    },
    [],
  );

  const clearTest = useCallback(() => setTest({ status: "idle" }), []);
  const clearMutation = useCallback(
    () => setMutation({ status: "idle" }),
    [],
  );

  return {
    profiles,
    active,
    test,
    mutation,
    reload,
    save,
    remove,
    testConnection,
    connect,
    disconnect,
    clearTest,
    clearMutation,
  };
}
