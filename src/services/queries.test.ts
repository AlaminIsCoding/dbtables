import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineCapabilities, QueryRequest, QueryResult } from "../domain";
import {
  CANCEL_QUERY_COMMAND,
  EXECUTE_QUERY_COMMAND,
  QUERY_CAPABILITIES_COMMAND,
  cancelQuery,
  executeQuery,
  getQueryCapabilities,
} from "./queries";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const request: QueryRequest = {
  operationId: "op-1",
  sql: "SELECT * FROM users",
};

const result: QueryResult = {
  operationId: "op-1",
  state: "succeeded",
  columns: [{ name: "id" }],
  rows: [[{ type: "integer", value: 1 }]],
  truncated: false,
};

const capabilities: EngineCapabilities = {
  transactions: true,
  ddlTransactions: true,
  savepoints: true,
  cancellation: true,
  schemas: false,
  multipleDatabases: false,
  tls: false,
};

describe("executeQuery", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the execute_query command with the connection and request", async () => {
    invokeMock.mockResolvedValue(result);

    await expect(executeQuery("sqlite-1", request)).resolves.toEqual(result);

    expect(invokeMock).toHaveBeenCalledWith(EXECUTE_QUERY_COMMAND, {
      connectionId: "sqlite-1",
      request,
    });
  });

  it("surfaces precondition failures to the caller", async () => {
    invokeMock.mockRejectedValue({
      category: "connection",
      message: "connection is not open",
    });

    await expect(executeQuery("sqlite-1", request)).rejects.toEqual({
      category: "connection",
      message: "connection is not open",
    });
  });
});

describe("cancelQuery", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the cancel_query command with the connection and operation", async () => {
    invokeMock.mockResolvedValue("requested");

    await expect(cancelQuery("sqlite-1", "op-1")).resolves.toBe("requested");

    expect(invokeMock).toHaveBeenCalledWith(CANCEL_QUERY_COMMAND, {
      connectionId: "sqlite-1",
      operationId: "op-1",
    });
  });

  it("surfaces an unsupported cancellation to the caller", async () => {
    invokeMock.mockRejectedValue({
      category: "unsupported",
      message: "the driver does not support query cancellation",
    });

    await expect(cancelQuery("sqlite-1", "op-1")).rejects.toEqual({
      category: "unsupported",
      message: "the driver does not support query cancellation",
    });
  });
});

describe("getQueryCapabilities", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the query_capabilities command for the connection", async () => {
    invokeMock.mockResolvedValue(capabilities);

    await expect(getQueryCapabilities("c1")).resolves.toEqual(capabilities);
    expect(invokeMock).toHaveBeenCalledWith(QUERY_CAPABILITIES_COMMAND, {
      connectionId: "c1",
    });
  });
});
