import { useCallback, useEffect, useRef, useState } from "react";

import type { EngineCapabilities, ObjectRef, QueryError } from "../../domain";
import { createOperationId } from "../../domain";
import { connectSqlite, disconnectConnection } from "../../services/connections";
import { toQueryError } from "../../services/errors";
import { listObjects } from "../../services/metadata";
import {
  cancelQuery as requestQueryCancellation,
  executeQuery,
  getQueryCapabilities,
} from "../../services/queries";
import {
  commandErrorOutcome,
  idleOutcome,
  resultOutcome,
  runningOutcome,
  type QueryOutcome,
} from "../results/queryOutcome";
import {
  canFetchMore as canFetchMoreResult,
  nextFetchLimit,
} from "../results/resultPaging";
import {
  historyEntryFromError,
  historyEntryFromResult,
  prependHistoryEntry,
  type QueryHistoryEntry,
} from "./queryHistory";

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
      /** Only present for a session that opened its own SQLite file. */
      filePath?: string;
      objects: ObjectListState;
    }
  | { status: "error"; error: QueryError };

/**
 * Binds a query session to a connection owned elsewhere (the app store).
 *
 * Supplying this option - even with `connectionId: null` - puts the session in
 * external mode: it never opens or closes a connection of its own and exposes
 * no file path. `null` means the workspace currently has no active connection.
 */
export interface UseQuerySessionOptions {
  connectionId: string | null;
}

const EMPTY_FILE_PATH_ERROR: QueryError = {
  category: "validation",
  message: "Enter a SQLite file path.",
};

const EMPTY_SQL_ERROR: QueryError = {
  category: "validation",
  message: "Enter a SQL statement to run.",
};

const EMPTY_OBJECTS: ObjectListState = { status: "ready", objects: [] };

export interface QuerySession {
  /** Current connection lifecycle state. */
  connection: ConnectionStatus;
  /** Current query outcome rendered by the results pane. */
  outcome: QueryOutcome;
  /** Whether a query is currently executing. */
  isRunning: boolean;
  /** Whether a query can be started right now. */
  canRun: boolean;
  /** Whether the active connection's driver supports cancellation. */
  cancellationSupported: boolean;
  /** Whether the running query can be cancelled right now. */
  canCancel: boolean;
  /** Whether a cancellation request is in flight for the running query. */
  cancelRequested: boolean;
  /** Whether the current partial result can be extended with another fetch. */
  canFetchMore: boolean;
  /** Whether an incremental fetch of the current result is in flight. */
  isFetchingMore: boolean;
  /** Non-fatal notice, such as a cancellation that the driver refused. */
  notice: string | null;
  /** Bounded, local recent-query history. Never contains secrets. */
  history: QueryHistoryEntry[];
  openDatabase: (filePath: string) => Promise<void>;
  disconnectDatabase: () => Promise<void>;
  refreshObjects: () => Promise<void>;
  /**
   * Executes the supplied statement and records the outcome.
   *
   * Resolves with the terminal outcome that was rendered, or `null` when the
   * request was ignored (no connection, or a query was already running). The
   * external-connection host uses this to know whether a run succeeded.
   */
  runQuery: (statement: string) => Promise<QueryOutcome | null>;
  /**
   * Re-runs the last successful statement with a larger bounded cap.
   *
   * This is an explicit, user-initiated request, never an automatic retry. It
   * is only offered for a truncated result whose adapter returned the full
   * requested window; reaching the backend's hard ceiling stops the flow.
   */
  fetchMore: () => Promise<void>;
  /** Requests driver cancellation of the running query when supported. */
  cancelRunningQuery: () => Promise<void>;
  /** Empties the recent-query history. */
  clearHistory: () => void;
}

function defaultCapabilities(): EngineCapabilities | null {
  return null;
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
 *
 * Two modes are supported. With no options the hook opens and closes its own
 * SQLite file (the legacy standalone workspace). With a
 * {@link UseQuerySessionOptions} argument it binds to the app store's single
 * active connection instead and never opens or closes a connection itself.
 *
 * Cancellation is capability-gated: the hook reads the adapter's reported
 * capabilities and only offers Cancel when the driver supports it. A cancel
 * request never invents a final state; the executing call reports the real
 * outcome, and a refused request surfaces a non-fatal notice instead of
 * overwriting the running state.
 */
export function useQuerySession(options?: UseQuerySessionOptions): QuerySession {
  const external = options !== undefined;
  const externalConnectionId = options?.connectionId ?? null;

  const [internalConnection, setInternalConnection] =
    useState<ConnectionStatus>({ status: "disconnected" });
  const [externalObjects, setExternalObjects] =
    useState<ObjectListState>(EMPTY_OBJECTS);
  const [outcome, setOutcome] = useState<QueryOutcome>(idleOutcome);
  const [isRunning, setIsRunning] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(
    defaultCapabilities,
  );
  const [cancelRequested, setCancelRequested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);

  const connectionIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const activeOperationRef = useRef<string | null>(null);
  const lastStatementRef = useRef<string | null>(null);
  const requestedLimitRef = useRef(0);
  const outcomeRef = useRef<QueryOutcome>(outcome);
  const externalTokenRef = useRef(0);

  useEffect(() => {
    outcomeRef.current = outcome;
  }, [outcome]);

  const loadObjects = useCallback(async (connectionId: string) => {
    try {
      const objects = await listObjects(connectionId);
      setInternalConnection((current) =>
        current.status === "connected" &&
        current.connectionId === connectionId
          ? { ...current, objects: { status: "ready", objects } }
          : current,
      );
    } catch (error) {
      setInternalConnection((current) =>
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

  const loadCapabilities = useCallback(async () => {
    try {
      setCapabilities(await getQueryCapabilities());
    } catch {
      // Capability discovery is best-effort: an unknown adapter must never
      // advertise a feature, so fall back to "nothing supported".
      setCapabilities(null);
    }
  }, []);

  // External mode: mirror the store's active connection, reloading the object
  // list and adapter capabilities whenever it changes. The session never opens
  // or closes this connection.
  useEffect(() => {
    if (!external) {
      return;
    }

    lastStatementRef.current = null;
    requestedLimitRef.current = 0;
    setOutcome(idleOutcome());
    setCancelRequested(false);
    setNotice(null);
    setIsFetchingMore(false);

    if (externalConnectionId === null) {
      setExternalObjects(EMPTY_OBJECTS);
      setCapabilities(null);
      return;
    }

    const token = externalTokenRef.current + 1;
    externalTokenRef.current = token;
    setExternalObjects({ status: "loading" });

    void (async () => {
      try {
        const objects = await listObjects(externalConnectionId);
        if (externalTokenRef.current === token) {
          setExternalObjects({ status: "ready", objects });
        }
      } catch (error) {
        if (externalTokenRef.current === token) {
          setExternalObjects({ status: "error", error: toQueryError(error) });
        }
      }
    })();

    void loadCapabilities();
  }, [external, externalConnectionId, loadCapabilities]);

  const openDatabase = useCallback(
    async (filePath: string) => {
      if (external) {
        // The connection belongs to the app store; opening a file here would
        // create a second connection.
        return;
      }

      const trimmed = filePath.trim();
      if (trimmed.length === 0) {
        setInternalConnection({
          status: "error",
          error: EMPTY_FILE_PATH_ERROR,
        });
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

      setInternalConnection({ status: "connecting" });
      setOutcome(idleOutcome());
      setCapabilities(null);
      setNotice(null);
      setCancelRequested(false);
      setIsFetchingMore(false);
      lastStatementRef.current = null;
      requestedLimitRef.current = 0;

      try {
        const connectionId = await connectSqlite(trimmed);
        connectionIdRef.current = connectionId;
        setInternalConnection({
          status: "connected",
          connectionId,
          filePath: trimmed,
          objects: { status: "loading" },
        });
        await Promise.all([loadObjects(connectionId), loadCapabilities()]);
      } catch (error) {
        connectionIdRef.current = null;
        setInternalConnection({ status: "error", error: toQueryError(error) });
      }
    },
    [external, loadCapabilities, loadObjects],
  );

  const disconnectDatabase = useCallback(async () => {
    if (external) {
      // The app store owns the connection's lifecycle.
      return;
    }

    const connectionId = connectionIdRef.current;
    connectionIdRef.current = null;
    setInternalConnection({ status: "disconnected" });
    setOutcome(idleOutcome());
    setCapabilities(null);
    setCancelRequested(false);
    setNotice(null);
    setIsFetchingMore(false);
    lastStatementRef.current = null;
    requestedLimitRef.current = 0;

    if (connectionId) {
      try {
        await disconnectConnection(connectionId);
      } catch {
        // The UI is already disconnected; a failed close does not change that.
      }
    }
  }, [external]);

  const refreshObjects = useCallback(async () => {
    if (external) {
      if (externalConnectionId === null) {
        return;
      }

      setExternalObjects({ status: "loading" });
      try {
        const objects = await listObjects(externalConnectionId);
        setExternalObjects({ status: "ready", objects });
      } catch (error) {
        setExternalObjects({ status: "error", error: toQueryError(error) });
      }
      return;
    }

    const connectionId = connectionIdRef.current;
    if (!connectionId) {
      return;
    }

    setInternalConnection((current) =>
      current.status === "connected" && current.connectionId === connectionId
        ? { ...current, objects: { status: "loading" } }
        : current,
    );
    await loadObjects(connectionId);
  }, [external, externalConnectionId, loadObjects]);

  const recordHistory = useCallback((entry: QueryHistoryEntry | null) => {
    if (!entry) {
      return;
    }
    setHistory((current) => prependHistoryEntry(current, entry));
  }, []);

  const runQuery = useCallback(
    async (statement: string): Promise<QueryOutcome | null> => {
      const connectionId = external
        ? externalConnectionId
        : connectionIdRef.current;
      if (!connectionId || runningRef.current) {
        return null;
      }

      const trimmed = statement.trim();
      if (trimmed.length === 0) {
        const blocked = commandErrorOutcome(EMPTY_SQL_ERROR);
        setOutcome(blocked);
        return blocked;
      }

      const operationId = createOperationId();
      runningRef.current = true;
      activeOperationRef.current = operationId;
      lastStatementRef.current = null;
      requestedLimitRef.current = 0;
      setIsRunning(true);
      setCancelRequested(false);
      setNotice(null);
      setOutcome(runningOutcome());

      try {
        const result = await executeQuery(connectionId, {
          operationId,
          sql: trimmed,
        });
        if (result.state === "succeeded") {
          lastStatementRef.current = trimmed;
          requestedLimitRef.current = result.rows?.length ?? 0;
        }
        const next = resultOutcome(result);
        setOutcome(next);
        recordHistory(historyEntryFromResult(operationId, trimmed, result));
        return next;
      } catch (error) {
        const queryError = toQueryError(error);
        const next = commandErrorOutcome(queryError);
        setOutcome(next);
        recordHistory(historyEntryFromError(operationId, trimmed, queryError));
        return next;
      } finally {
        runningRef.current = false;
        activeOperationRef.current = null;
        setCancelRequested(false);
        setIsRunning(false);
      }
    },
    [external, externalConnectionId, recordHistory],
  );

  const fetchMore = useCallback(async () => {
    const connectionId = external
      ? externalConnectionId
      : connectionIdRef.current;
    const sql = lastStatementRef.current;
    const current = outcomeRef.current;
    if (!connectionId || !sql || runningRef.current) {
      return;
    }
    if (
      current.kind !== "partial" ||
      !canFetchMoreResult(current.result, requestedLimitRef.current)
    ) {
      return;
    }

    const nextLimit = nextFetchLimit(requestedLimitRef.current);
    const operationId = createOperationId();
    runningRef.current = true;
    setIsFetchingMore(true);
    setNotice(null);

    try {
      const result = await executeQuery(connectionId, {
        operationId,
        sql,
        maxRows: nextLimit,
      });
      requestedLimitRef.current = nextLimit;
      setOutcome(resultOutcome(result));
      // Fetch-more continues the same statement, so it does not add a second
      // history entry.
    } catch (error) {
      // The already-loaded rows remain valid; surface the failed extension as a
      // non-fatal notice instead of discarding the visible result.
      setNotice(toQueryError(error).message);
    } finally {
      runningRef.current = false;
      setIsFetchingMore(false);
    }
  }, [external, externalConnectionId]);

  const cancelRunningQuery = useCallback(async () => {
    const connectionId = external
      ? externalConnectionId
      : connectionIdRef.current;
    const operationId = activeOperationRef.current;
    if (!connectionId || !operationId || !runningRef.current) {
      return;
    }

    setCancelRequested(true);
    setNotice(null);
    try {
      await requestQueryCancellation(connectionId, operationId);
      // A `requested` or `not_running` outcome is not itself a final state:
      // the executing call reports the real result, so leave `outcome` alone.
    } catch (error) {
      setCancelRequested(false);
      setNotice(toQueryError(error).message);
    }
  }, [external, externalConnectionId]);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const connection: ConnectionStatus = external
    ? externalConnectionId === null
      ? { status: "disconnected" }
      : {
          status: "connected",
          connectionId: externalConnectionId,
          objects: externalObjects,
        }
    : internalConnection;

  const cancellationSupported = capabilities?.cancellation === true;
  const canFetchMore =
    connection.status === "connected" &&
    !isRunning &&
    !isFetchingMore &&
    outcome.kind === "partial" &&
    canFetchMoreResult(outcome.result, requestedLimitRef.current);

  return {
    connection,
    outcome,
    isRunning,
    canRun: connection.status === "connected" && !isRunning && !isFetchingMore,
    cancellationSupported,
    canCancel: isRunning && cancellationSupported,
    cancelRequested,
    canFetchMore,
    isFetchingMore,
    notice,
    history,
    openDatabase,
    disconnectDatabase,
    refreshObjects,
    runQuery,
    fetchMore,
    cancelRunningQuery,
    clearHistory,
  };
}
