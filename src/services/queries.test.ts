import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRequest, QueryResult } from "../domain";
import { EXECUTE_QUERY_COMMAND, executeQuery } from "./queries";

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
