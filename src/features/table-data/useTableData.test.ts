import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryError, TablePage } from "../../domain";
import { fetchTablePage } from "../../services/tableData";
import { useTableDataController, type TableDataTarget } from "./useTableData";

vi.mock("../../services/tableData", () => ({
  fetchTablePage: vi.fn(),
}));

const fetchMock = vi.mocked(fetchTablePage);

const target: TableDataTarget = {
  connectionId: "c1",
  object: { name: "users", kind: "table" },
};

function page(overrides: Partial<TablePage> = {}): TablePage {
  return {
    operationId: "op",
    columns: [
      { name: "id", typeName: "integer" },
      { name: "name", typeName: "text" },
    ],
    rows: [
      [
        { type: "integer", value: 1 },
        { type: "text", value: "alice" },
      ],
    ],
    rowIdentity: ["id"],
    offset: 0,
    limit: 50,
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("useTableDataController", () => {
  it("loads the first bounded page for the target", async () => {
    fetchMock.mockResolvedValue(page());

    const { result } = renderHook(() => useTableDataController(target));

    await waitFor(() => expect(result.current.page).not.toBeNull());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [connectionId, request] = fetchMock.mock.calls[0];
    expect(connectionId).toBe("c1");
    expect(request.object).toEqual(target.object);
    expect(request.limit).toBe(50);
    expect(request.offset).toBe(0);
    expect(request.filters).toBeUndefined();
    expect(request.sort).toBeUndefined();
    expect(result.current.hasRowIdentity).toBe(true);
    expect(result.current.canGoNext).toBe(false);
    expect(result.current.canGoBack).toBe(false);
  });

  it("pages forward using the backend continuation offset", async () => {
    fetchMock
      .mockResolvedValueOnce(page({ truncated: true, nextOffset: 50 }))
      .mockResolvedValueOnce(page({ offset: 50 }));

    const { result } = renderHook(() => useTableDataController(target));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    expect(result.current.canGoNext).toBe(true);

    act(() => result.current.goNext());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1].offset).toBe(50);
    await waitFor(() => expect(result.current.canGoBack).toBe(true));

    act(() => result.current.goBack());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][1].offset).toBe(0);
  });

  it("resets to the first page when a filter or sort is applied", async () => {
    fetchMock.mockResolvedValue(
      page({ truncated: true, nextOffset: 50, offset: 50 }),
    );

    const { result } = renderHook(() => useTableDataController(target));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    act(() => result.current.goNext());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.offset).toBe(50);

    act(() =>
      result.current.addFilter({
        column: "name",
        operator: "like",
        values: [{ type: "text", value: "%a%" }],
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, request] = fetchMock.mock.calls[2];
    expect(request.offset).toBe(0);
    expect(request.filters?.[0].column).toBe("name");

    act(() => result.current.applySort("id", "descending"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [, sortedRequest] = fetchMock.mock.calls[3];
    expect(sortedRequest.sort?.[0]).toEqual({
      column: "id",
      direction: "descending",
    });
    expect(result.current.sort).toHaveLength(1);
  });

  it("surfaces a normalized error and clears the stale page", async () => {
    const error: QueryError = {
      category: "permission",
      message: "permission denied for relation users",
    };
    fetchMock.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useTableDataController(target));

    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error).toEqual(error);
    expect(result.current.page).toBeNull();
    expect(result.current.rows).toEqual([]);
  });

  it("reports a missing row identity honestly", async () => {
    fetchMock.mockResolvedValue(page({ rowIdentity: [] }));

    const { result } = renderHook(() => useTableDataController(target));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    expect(result.current.hasRowIdentity).toBe(false);
  });
});
