import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TablePage, TablePageRequest } from "../domain";
import { FETCH_TABLE_PAGE_COMMAND, fetchTablePage } from "./tableData";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const request: TablePageRequest = {
  operationId: "page-1",
  object: { name: "users", kind: "table" },
  limit: 50,
  offset: 100,
  filters: [
    { column: "name", operator: "like", values: [{ type: "text", value: "%bob%" }] },
  ],
  sort: [{ column: "id", direction: "ascending" }],
};

const page: TablePage = {
  operationId: "page-1",
  columns: [
    { name: "id", typeName: "integer", nullable: false },
    { name: "name", typeName: "text", nullable: true },
  ],
  rows: [
    [
      { type: "integer", value: 1 },
      { type: "text", value: "bob" },
    ],
  ],
  rowIdentity: ["id"],
  offset: 100,
  limit: 50,
  totalRows: 320,
  truncated: true,
  nextOffset: 150,
};

describe("table data service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes fetch_table_page with the connection id and request", async () => {
    invokeMock.mockResolvedValue(page);

    await expect(fetchTablePage("sqlite-1", request)).resolves.toEqual(page);

    expect(invokeMock).toHaveBeenCalledWith(FETCH_TABLE_PAGE_COMMAND, {
      connectionId: "sqlite-1",
      request,
    });
  });

  it("propagates a rejected backend error unchanged", async () => {
    const error = { category: "validation", message: "unknown filter column `x`" };
    invokeMock.mockRejectedValue(error);

    await expect(fetchTablePage("sqlite-1", request)).rejects.toEqual(error);
  });
});
