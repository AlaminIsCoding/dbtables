import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryError, TablePage } from "../../domain";
import { fetchTablePage } from "../../services/tableData";
import { TableDataView } from "./TableDataView";

vi.mock("../../services/tableData", () => ({
  fetchTablePage: vi.fn(),
}));

vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: {
    Text: "text",
    Number: "number",
    Boolean: "boolean",
  },
  getDefaultTheme: () => ({}),
  DataEditor: () => null,
}));

const fetchMock = vi.mocked(fetchTablePage);

const object = { name: "users", kind: "table" as const };

function page(overrides: Partial<TablePage> = {}): TablePage {
  return {
    operationId: "op",
    columns: [
      { name: "id", typeName: "integer", nullable: false },
      { name: "name", typeName: "text", nullable: true },
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

afterEach(cleanup);

describe("TableDataView", () => {
  it("shows a read-only badge and loads the first page", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);

    expect(screen.getByTestId("table-data-read-only").textContent).toBe(
      "Read-only",
    );
    expect(screen.getByText(/editing rows is not available/)).toBeTruthy();

    await waitFor(() =>
      expect(screen.getByTestId("table-data-range").textContent).toBe(
        "Rows 1–1",
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("c1");
    expect(fetchMock.mock.calls[0][1].offset).toBe(0);
  });

  it("pages forward and back with bounded requests", async () => {
    fetchMock
      .mockResolvedValueOnce(page({ truncated: true, nextOffset: 50 }))
      .mockResolvedValueOnce(page({ offset: 50 }))
      .mockResolvedValueOnce(page({ offset: 0 }));

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() =>
      expect(screen.getByTestId("table-data-range").textContent).toBe(
        "Rows 1–1",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1].offset).toBe(50);

    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][1].offset).toBe(0);
  });

  it("applies a filter and returns to the first page", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);
    const filterColumnSelect = screen.getByLabelText("Filter column");
    await waitFor(() =>
      expect(filterColumnSelect.querySelectorAll("option").length).toBeGreaterThan(1),
    );

    fireEvent.change(screen.getByLabelText("Filter column"), {
      target: { value: "name" },
    });
    fireEvent.change(screen.getByLabelText("Filter value"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1][1];
    expect(request.offset).toBe(0);
    expect(request.filters?.[0]).toEqual({
      column: "name",
      operator: "equal",
      values: [{ type: "text", value: "alice" }],
    });
  });

  it("applies a sort column", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);
    const sortColumnSelect = screen.getByLabelText("Sort column");
    await waitFor(() =>
      expect(sortColumnSelect.querySelectorAll("option").length).toBeGreaterThan(1),
    );

    fireEvent.change(screen.getByLabelText("Sort column"), {
      target: { value: "name" },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1].sort?.[0]).toEqual({
      column: "name",
      direction: "ascending",
    });
  });

  it("warns when the object has no safe row identity", async () => {
    fetchMock.mockResolvedValue(page({ rowIdentity: [] }));

    render(<TableDataView connectionId="c1" object={object} />);

    expect(await screen.findByTestId("table-data-no-identity")).toBeTruthy();
  });

  it("shows a normalized error instead of stale rows", async () => {
    const error: QueryError = {
      category: "permission",
      message: "permission denied for relation users",
    };
    fetchMock.mockRejectedValue(error);

    render(<TableDataView connectionId="c1" object={object} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("permission denied");
  });

  it("can be closed from the header", async () => {
    fetchMock.mockResolvedValue(page());
    const onClose = vi.fn();

    render(<TableDataView connectionId="c1" object={object} onClose={onClose} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close table data" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
