import { useCallback, useRef, useState } from "react";

import type { ObjectRef, QueryError } from "../../domain";
import { createOperationId } from "../../domain";
import { connectSqlite, disconnectConnection } from "../../services/connections";
import { toQueryError } from "../../services/errors";
import { listObjects } from "../../services/metadata";
import { executeQuery } from "../../services/queries";
import {
  commandErrorOutcome,
  idleOutcome,
  resultOutcome,
  runningOutcome,
  type QueryOutcome,
} from "../results/queryOutcome";

/** Loading/ready/error state for the connection's object list. */
export type ObjectListState =
  | { status: "loading" }
  | { status: "ready"; objects: ObjectRef[] }
  | { status: "error"; error: QueryError };

/** Connection lifecycle state for the query workspace. */
export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      connectionId: string;
      filePath: string;
      objects: ObjectListState;
    }
  | { status: "error"; error: QueryError };

const EMPTY_FILE_PATH_ERROR: QueryError = {
  category: "validation",
  message: "Enter a SQLite file path.",
};

const EMPTY_SQL_ERROR: QueryError = {
  category: "validation",
  message: "Enter a SQL statement to run.",
};

export interface QuerySession {
  /** Current connection lifecycle state. */
  connection: ConnectionStatus;
  /** Current query outcome rendered by the results pane. */
  outcome: QueryOutcome;
  /** Whether a query is currently executing. */
  isRunning: boolean;
  /** Whether a query can be started right now. */
  canRun: boolean;
  openDatabase: (filePath: string) => Promise<void>;
  disconnectDatabase: () => Promise<void>;
  refreshObjects: () => Promise<void>;
  /** Executes the supplied statement and records the outcome. */
  runQuery: (statement: string) => Promise<void>;
}

/**
 * Owns connection and query *execution* state for one workspace tab.
 *
 * Editor text and tab state belong to {@link useQueryTabs}; this hook is only
 * told which statement to run. All database work goes through the typed service
 * facade, so the component tree never touches Tauri commands directly. Query
 * execution is awaited asynchronously; React updates to `running` before the
 * call so the editor and connection controls stay interactive while the backend
 * works.
 */
export function useQuerySession(): QuerySession {
  const [connection, setConnection] = useState<ConnectionStatus>({
    status: "disconnected",
  });
  const [outcome, setOutcome] = useState<QueryOutcome>(idleOutcome);
  const [isRunning, setIsRunning] = useState(false);

  const connectionIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);

  const loadObjects = useCallback(async (connectionId: string) => {
    try {
      const objects = await listObjects(connectionId);
      setConnection((current) =>
        current.status === "connected" &&
        current.connectionId === connectionId
          ? { ...current, objects: { status: "ready", objects } }
          : current,
      );
    } catch (error) {
      setConnection((current) =>
        current.status === "connected" &&
        current.connectionId === connectionId
          ? {
              ...current,
              objects: { status: "error", error: toQueryError(error) },
            }
          : current,
      );
    }
  }, []);

  const openDatabase = useCallback(
    async (filePath: string) => {
      const trimmed = filePath.trim();
      if (trimmed.length === 0) {
        setConnection({ status: "error", error: EMPTY_FILE_PATH_ERROR });
        return;
      }

      // Replace any previous connection so the workspace only ever holds one.
      const previous = connectionIdRef.current;
      if (previous) {
        connectionIdRef.current = null;
        try {
          await disconnectConnection(previous);
        } catch {
          // The old connection is being replaced regardless; a failed close
          // must not block opening the requested file.
        }
      }

      setConnection({ status: "connecting" });
      setOutcome(idleOutcome());

      try {
        const connectionId = await connectSqlite(trimmed);
        connectionIdRef.current = connectionId;
        setConnection({
          status: "connected",
          connectionId,
          filePath: trimmed,
          objects: { status: "loading" },
        });
        await loadObjects(connectionId);
      } catch (error) {
        connectionIdRef.current = null;
        setConnection({ status: "error", error: toQueryError(error) });
      }
    },
    [loadObjects],
  );

  const disconnectDatabase = useCallback(async () => {
    const connectionId = connectionIdRef.current;
    connectionIdRef.current = null;
    setConnection({ status: "disconnected" });
    setOutcome(idleOutcome());

    if (connectionId) {
      try {
        await disconnectConnection(connectionId);
      } catch {
        // The UI is already disconnected; a failed close does not change that.
      }
    }
  }, []);

  const refreshObjects = useCallback(async () => {
    const connectionId = connectionIdRef.current;
    if (!connectionId) {
      return;
    }

    setConnection((current) =>
      current.status === "connected" && current.connectionId === connectionId
        ? { ...current, objects: { status: "loading" } }
        : current,
    );
    await loadObjects(connectionId);
  }, [loadObjects]);

  const runQuery = useCallback(async (statement: string) => {
    const connectionId = connectionIdRef.current;
    if (!connectionId || runningRef.current) {
      return;
    }

    const trimmed = statement.trim();
    if (trimmed.length === 0) {
      setOutcome(commandErrorOutcome(EMPTY_SQL_ERROR));
      return;
    }

    runningRef.current = true;
    setIsRunning(true);
    setOutcome(runningOutcome());

    try {
      const result = await executeQuery(connectionId, {
        operationId: createOperationId(),
        sql: trimmed,
      });
      setOutcome(resultOutcome(result));
    } catch (error) {
      setOutcome(commandErrorOutcome(toQueryError(error)));
    } finally {
      runningRef.current = false;
      setIsRunning(false);
    }
  }, []);

  return {
    connection,
    outcome,
    isRunning,
    canRun: connection.status === "connected" && !isRunning,
    openDatabase,
    disconnectDatabase,
    refreshObjects,
    runQuery,
  };
}
