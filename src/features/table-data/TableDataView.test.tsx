import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryError, TablePage } from "../../domain";
import { applyTableChanges, fetchTablePage } from "../../services/tableData";
import { TableDataView } from "./TableDataView";

vi.mock("../../services/tableData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tableData")>();
  return { ...actual, fetchTablePage: vi.fn(), applyTableChanges: vi.fn() };
});

const glide = vi.hoisted(() => ({
  props: undefined as
    | {
        rows: number;
        getCellContent: (cell: readonly [number, number]) => {
          kind: string;
          themeOverride?: unknown;
        };
        onCellActivated: (cell: readonly [number, number]) => void;
        onGridSelectionChange: (selection: {
          current?: { cell: readonly [number, number] };
        }) => void;
      }
    | undefined,
}));

vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: {
    Text: "text",
    Number: "number",
    Boolean: "boolean",
  },
  getDefaultTheme: () => ({}),
  DataEditor: (props: unknown) => {
    glide.props = props as typeof glide.props;
    return null;
  },
}));

const fetchMock = vi.mocked(fetchTablePage);
const applyMock = vi.mocked(applyTableChanges);

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

function selectRow(row = 0) {
  act(() => {
    glide.props?.onGridSelectionChange({ current: { cell: [0, row] } });
  });
}

function activateCell(cell: readonly [number, number]) {
  act(() => {
    glide.props?.onCellActivated(cell);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  applyMock.mockReset();
  glide.props = undefined;
});

afterEach(cleanup);

describe("TableDataView", () => {
  it("enables editing when the object has a safe identity", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);

    await waitFor(() =>
      expect(screen.getByTestId("table-data-range").textContent).toBe("Rows 1–1"),
    );

    expect(screen.getByTestId("table-data-mode").textContent).toBe("Editable");
    expect(screen.getByRole("button", { name: "Add row" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Apply/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps a view read-only even with a reported identity", async () => {
    fetchMock.mockResolvedValue(page());

    render(
      <TableDataView connectionId="c1" object={{ name: "v", kind: "view" }} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("table-data-range").textContent).toBe("Rows 1–1"),
    );

    expect(screen.getByTestId("table-data-mode").textContent).toBe("Read-only");
    expect(screen.getByTestId("table-data-view")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
  });

  it("warns when the object has no safe row identity", async () => {
    fetchMock.mockResolvedValue(page({ rowIdentity: [] }));

    render(<TableDataView connectionId="c1" object={object} />);

    expect(await screen.findByTestId("table-data-no-identity")).toBeTruthy();
    expect(screen.getByTestId("table-data-mode").textContent).toBe("Read-only");
  });

  it("stages a cell edit through the value editor and marks the cell", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() => expect(glide.props).toBeDefined());

    activateCell([1, 0]);
    fireEvent.change(await screen.findByLabelText("Cell value"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage edit" }));

    expect(await screen.findByTestId("staged-summary")).toBeTruthy();
    expect(screen.getByTestId("staged-summary").textContent).toContain("1 staged");
    expect(glide.props?.getCellContent([1, 0]).themeOverride).toBeDefined();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("applies staged edits, reloads, and clears the queue", async () => {
    fetchMock.mockResolvedValue(page());
    applyMock.mockImplementation(async (_connection, requests) => ({
      results: requests.map((request) => ({
        operationId: request.operationId,
        outcome: "applied",
        affectedRows: 1,
      })),
      grouped: true,
      state: "applied",
    }));

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() => expect(glide.props).toBeDefined());

    activateCell([1, 0]);
    fireEvent.change(await screen.findByLabelText("Cell value"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage edit" }));

    fireEvent.click(await screen.findByRole("button", { name: "Apply (1)" }));

    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("staged-summary")).toBeNull(),
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("confirms before applying deletes and surfaces a conflict", async () => {
    fetchMock.mockResolvedValue(page());
    applyMock.mockImplementation(async (_connection, requests) => ({
      results: [
        {
          operationId: requests[0].operationId,
          outcome: "conflict",
          conflictedColumns: ["id"],
        },
      ],
      grouped: true,
      state: "conflict",
    }));

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() => expect(glide.props).toBeDefined());

    selectRow(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stage delete" }));

    expect(screen.getByTestId("staged-summary").textContent).toContain("1 staged");

    fireEvent.click(screen.getByRole("button", { name: "Apply (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply changes" }));

    await waitFor(() =>
      expect(screen.getByTestId("apply-feedback").textContent).toContain("conflicted"),
    );
    expect(screen.getByTestId("reload-rows")).toBeTruthy();
    expect(screen.getByTestId(/^staged-status-/).textContent).toBe("Conflict");
  });

  it("discards staged edits only after confirmation", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() => expect(glide.props).toBeDefined());

    activateCell([1, 0]);
    fireEvent.change(await screen.findByLabelText("Cell value"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage edit" }));

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() =>
      expect(screen.queryByTestId("staged-summary")).toBeNull(),
    );
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("stages a new row from the insert dialog", async () => {
    fetchMock.mockResolvedValue(page());

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() =>
      expect(screen.getByTestId("table-data-range").textContent).toBe("Rows 1–1"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.change(screen.getByLabelText("Value for id"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Value for name"), {
      target: { value: "dana" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(screen.getByTestId("staged-summary").textContent).toContain("1 staged");
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("pages forward and back with bounded requests", async () => {
    fetchMock
      .mockResolvedValueOnce(page({ truncated: true, nextOffset: 50 }))
      .mockResolvedValueOnce(page({ offset: 50 }))
      .mockResolvedValueOnce(page({ offset: 0 }));

    render(<TableDataView connectionId="c1" object={object} />);
    await waitFor(() =>
      expect(screen.getByTestId("table-data-range").textContent).toBe("Rows 1–1"),
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
