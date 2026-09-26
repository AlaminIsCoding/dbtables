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
  /** Executes the supplied statement and records the outcome. */
  runQuery: (statement: string) => Promise<void>;
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
 * Cancellation is capability-gated: the hook reads the adapter's reported
 * capabilities and only offers Cancel when the driver supports it. A cancel
 * request never invents a final state; the executing call reports the real
 * outcome, and a refused request surfaces a non-fatal notice instead of
 * overwriting the running state.
 */
export function useQuerySession(): QuerySession {
  const [connection, setConnection] = useState<ConnectionStatus>({
    status: "disconnected",
  });
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

  useEffect(() => {
    outcomeRef.current = outcome;
  }, [outcome]);

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

  const loadCapabilities = useCallback(async () => {
    try {
      setCapabilities(await getQueryCapabilities());
    } catch {
      // Capability discovery is best-effort: an unknown adapter must never
      // advertise a feature, so fall back to "nothing supported".
      setCapabilities(null);
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
      setCapabilities(null);
      setNotice(null);
      setCancelRequested(false);
      setIsFetchingMore(false);
      lastStatementRef.current = null;
      requestedLimitRef.current = 0;

      try {
        const connectionId = await connectSqlite(trimmed);
        connectionIdRef.current = connectionId;
        setConnection({
          status: "connected",
          connectionId,
          filePath: trimmed,
          objects: { status: "loading" },
        });
        await Promise.all([loadObjects(connectionId), loadCapabilities()]);
      } catch (error) {
        connectionIdRef.current = null;
        setConnection({ status: "error", error: toQueryError(error) });
      }
    },
    [loadCapabilities, loadObjects],
  );

  const disconnectDatabase = useCallback(async () => {
    const connectionId = connectionIdRef.current;
    connectionIdRef.current = null;
    setConnection({ status: "disconnected" });
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

  const recordHistory = useCallback((entry: QueryHistoryEntry | null) => {
    if (!entry) {
      return;
    }
    setHistory((current) => prependHistoryEntry(current, entry));
  }, []);

  const runQuery = useCallback(
    async (statement: string) => {
      const connectionId = connectionIdRef.current;
      if (!connectionId || runningRef.current) {
        return;
      }

      const trimmed = statement.trim();
      if (trimmed.length === 0) {
        setOutcome(commandErrorOutcome(EMPTY_SQL_ERROR));
        return;
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
        setOutcome(resultOutcome(result));
        recordHistory(historyEntryFromResult(operationId, trimmed, result));
      } catch (error) {
        const queryError = toQueryError(error);
        setOutcome(commandErrorOutcome(queryError));
        recordHistory(historyEntryFromError(operationId, trimmed, queryError));
      } finally {
        runningRef.current = false;
        activeOperationRef.current = null;
        setCancelRequested(false);
        setIsRunning(false);
      }
    },
    [recordHistory],
  );

  const fetchMore = useCallback(async () => {
    const connectionId = connectionIdRef.current;
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
  }, []);

  const cancelRunningQuery = useCallback(async () => {
    const connectionId = connectionIdRef.current;
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
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

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
