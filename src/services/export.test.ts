import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CsvExportSummary, QueryResult } from "../domain";
import { EXPORT_QUERY_CSV_COMMAND, exportQueryCsv } from "./export";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const result: QueryResult = {
  operationId: "op-1",
  state: "succeeded",
  truncated: false,
  columns: [{ name: "id" }, { name: "name" }],
  rows: [
    [
      { type: "integer", value: 1 },
      { type: "text", value: "alice" },
    ],
  ],
};

const summary: CsvExportSummary = {
  path: "C:/tmp/results.csv",
  rows: 1,
  columns: 2,
  bytesWritten: 42,
};

describe("exportQueryCsv", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes export_query_csv with the path and loaded rows", async () => {
    invokeMock.mockResolvedValue(summary);

    await expect(exportQueryCsv("C:/tmp/results.csv", result)).resolves.toEqual(
      summary,
    );

    expect(invokeMock).toHaveBeenCalledWith(EXPORT_QUERY_CSV_COMMAND, {
      path: "C:/tmp/results.csv",
      columns: result.columns,
      rows: result.rows,
    });
  });

  it("sends empty column and row arrays for a column-only result", async () => {
    invokeMock.mockResolvedValue(summary);

    await exportQueryCsv("C:/tmp/empty.csv", {
      operationId: "op-2",
      state: "succeeded",
      truncated: false,
    });

    expect(invokeMock).toHaveBeenCalledWith(EXPORT_QUERY_CSV_COMMAND, {
      path: "C:/tmp/empty.csv",
      columns: [],
      rows: [],
    });
  });

  it("surfaces an actionable write error to the caller", async () => {
    invokeMock.mockRejectedValue({
      category: "permission",
      message: "permission was denied writing `C:/tmp/results.csv`",
    });

    await expect(
      exportQueryCsv("C:/tmp/results.csv", result),
    ).rejects.toEqual({
      category: "permission",
      message: "permission was denied writing `C:/tmp/results.csv`",
    });
  });
});
