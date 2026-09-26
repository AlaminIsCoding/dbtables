import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CellValue } from "@/domain";

import { DataTable } from "./DataTable";

afterEach(cleanup);

const columns = [
  { name: "id", typeName: "INTEGER", primaryKey: true },
  { name: "name", typeName: "TEXT" },
];

const rows: CellValue[][] = [
  [
    { type: "integer", value: 1 },
    { type: "text", value: "alice" },
  ],
  [
    { type: "integer", value: 2 },
    { type: "text", value: "bob" },
  ],
  [
    { type: "integer", value: 3 },
    { type: "null" },
  ],
];

describe("DataTable", () => {
  it("renders header columns and cell values", () => {
    render(<DataTable columns={columns} rows={rows} />);

    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("NULL")).toBeTruthy();
  });

  it("selects a row on click", () => {
    const onSelectedRowsChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        selectedRows={[]}
        onSelectedRowsChange={onSelectedRowsChange}
      />,
    );

    fireEvent.click(screen.getByText("bob"));
    expect(onSelectedRowsChange).toHaveBeenCalledWith([1]);
  });

  it("toggles a row with ctrl-click", () => {
    const onSelectedRowsChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        selectedRows={[1]}
        onSelectedRowsChange={onSelectedRowsChange}
      />,
    );

    fireEvent.click(screen.getByText("alice"), { ctrlKey: true });
    expect(onSelectedRowsChange).toHaveBeenCalledWith([0, 1]);
  });

  it("edits a cell inline and reports the parsed value", () => {
    const onCellEdit = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} editable onCellEdit={onCellEdit} />,
    );

    fireEvent.doubleClick(screen.getByText("alice"));
    const input = screen.getByLabelText("Edit name");
    fireEvent.change(input, { target: { value: "bob" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCellEdit).toHaveBeenCalledWith(1, 0, { type: "text", value: "bob" });
  });

  it("activates a read-only cell on double-click instead of editing", () => {
    const onCellActivated = vi.fn();
    const onCellEdit = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        onCellActivated={onCellActivated}
        onCellEdit={onCellEdit}
      />,
    );

    fireEvent.doubleClick(screen.getByText("alice"));
    expect(onCellActivated).toHaveBeenCalledWith(1, 0);
    expect(onCellEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Edit name")).toBeNull();
  });

  it("cycles sort direction from the header", () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        sort={{ column: null, direction: "ascending" }}
        onSortChange={onSortChange}
      />,
    );

    fireEvent.click(screen.getByText("name"));
    expect(onSortChange).toHaveBeenLastCalledWith("name", "ascending");
  });
});
