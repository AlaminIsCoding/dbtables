import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../domain";
import { connectSqlite, disconnectConnection } from "../../services/connections";
import { listObjects } from "../../services/metadata";
import { executeQuery } from "../../services/queries";
import { useQuerySession } from "./useQuerySession";

vi.mock("../../services/connections", () => ({
  connectSqlite: vi.fn(),
  disconnectConnection: vi.fn(),
}));

vi.mock("../../services/metadata", () => ({
  listObjects: vi.fn(),
}));

vi.mock("../../services/queries", () => ({
  executeQuery: vi.fn(),
}));

const connectMock = vi.mocked(connectSqlite);
const disconnectMock = vi.mocked(disconnectConnection);
const listObjectsMock = vi.mocked(listObjects);
const executeMock = vi.mocked(executeQuery);

function gridResult(): QueryResult {
  return {
    operationId: "op",
    state: "succeeded",
    columns: [{ name: "id" }],
    rows: [[{ type: "integer", value: 1 }]],
    truncated: false,
  };
}

async function openConnected(
  result: { current: ReturnType<typeof useQuerySession> },
) {
  connectMock.mockResolvedValue("sqlite-1");
  listObjectsMock.mockResolvedValue([{ name: "users", kind: "table" }]);
  await act(async () => {
    await result.current.openDatabase("C:/data/app.sqlite");
  });
}

afterEach(cleanup);

describe("useQuerySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts disconnected with an idle outcome", () => {
    const { result } = renderHook(() => useQuerySession());

    expect(result.current.connection).toEqual({ status: "disconnected" });
    expect(result.current.outcome).toEqual({ kind: "idle" });
    expect(result.current.canRun).toBe(false);
    expect(result.current.isRunning).toBe(false);
  });

  it("opens a database and loads its objects", async () => {
    const { result } = renderHook(() => useQuerySession());
    await openConnected(result);

    expect(connectMock).toHaveBeenCalledWith("C:/data/app.sqlite");
    expect(result.current.connection).toEqual({
      status: "connected",
      connectionId: "sqlite-1",
      filePath: "C:/data/app.sqlite",
      objects: { status: "ready", objects: [{ name: "users", kind: "table" }] },
    });
    expect(result.current.canRun).toBe(true);
  });

  it("reports a connection failure", async () => {
    connectMock.mockRejectedValue({
      category: "connection",
      message: "the SQLite database file could not be opened",
    });
    const { result } = renderHook(() => useQuerySession());

    await act(async () => {
      await result.current.openDatabase("missing.sqlite");
    });

    expect(result.current.connection).toEqual({
      status: "error",
      error: {
        category: "connection",
        message: "the SQLite database file could not be opened",
      },
    });
    expect(result.current.canRun).toBe(false);
  });

  it("validates a blank file path without calling the backend", async () => {
    const { result } = renderHook(() => useQuerySession());

    await act(async () => {
      await result.current.openDatabase("   ");
    });

    expect(connectMock).not.toHaveBeenCalled();
    expect(result.current.connection.status).toBe("error");
  });

  it("reports an object-listing failure without losing the connection", async () => {
    connectMock.mockResolvedValue("sqlite-1");
    listObjectsMock.mockRejectedValue({
      category: "internal",
      message: "listing failed",
    });
    const { result } = renderHook(() => useQuerySession());

    await act(async () => {
      await result.current.openDatabase("C:/data/app.sqlite");
    });

    expect(result.current.connection.status).toBe("connected");
    if (result.current.connection.status === "connected") {
      expect(result.current.connection.objects).toEqual({
        status: "error",
        error: { category: "internal", message: "listing failed" },
      });
    }
  });

  it("runs a query through the service facade and exposes the result", async () => {
    const { result } = renderHook(() => useQuerySession());
    await openConnected(result);
    executeMock.mockResolvedValue(gridResult());

    await act(async () => {
      await result.current.runQuery("SELECT id FROM users");
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [connectionId, request] = executeMock.mock.calls[0];
    expect(connectionId).toBe("sqlite-1");
    expect(request.sql).toBe("SELECT id FROM users");
    expect(typeof request.operationId).toBe("string");
    expect(result.current.outcome.kind).toBe("grid");
  });

  it("reports a rejected query as a command error", async () => {
    const { result } = renderHook(() => useQuerySession());
    await openConnected(result);
    executeMock.mockRejectedValue({
      category: "connection",
      message: "connection is not open",
    });

    await act(async () => {
      await result.current.runQuery("SELECT 1");
    });

    expect(result.current.outcome).toEqual({
      kind: "error",
      error: { category: "connection", message: "connection is not open" },
    });
  });

  it("rejects a blank statement without calling the backend", async () => {
    const { result } = renderHook(() => useQuerySession());
    await openConnected(result);

    await act(async () => {
      await result.current.runQuery("   ");
    });

    expect(executeMock).not.toHaveBeenCalled();
    expect(result.current.outcome.kind).toBe("error");
  });

  it("does not start a second query while one is running", async () => {
    const { result } = renderHook(() => useQuerySession());
    await openConnected(result);

    let resolveQuery: ((value: QueryResult) => void) | undefined;
    executeMock.mockImplementation(
      () =>
        new Promise<QueryResult>((resolve) => {
          resolveQuery = resolve;
        }),
    );

    await act(async () => {
      void result.current.runQuery("SELECT 1");
    });

    expect(result.current.outcome.kind).toBe("running");
    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      await result.current.runQuery("SELECT 1");
    });
    expect(executeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveQuery?.(gridResult());
    });

    expect(result.current.outcome.kind).toBe("grid");
    expect(result.current.isRunning).toBe(false);
  });

  it("disconnects and resets the workspace", async () => {
    const { result } = renderHook(() => useQuerySession());
    await openConnected(result);
    disconnectMock.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.disconnectDatabase();
    });

    expect(disconnectMock).toHaveBeenCalledWith("sqlite-1");
    expect(result.current.connection).toEqual({ status: "disconnected" });
    expect(result.current.outcome).toEqual({ kind: "idle" });
  });
});
