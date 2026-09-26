import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ColumnInfo } from "../../domain";
import { InsertRowDialog } from "./InsertRowDialog";

const columns: ColumnInfo[] = [
  { name: "id", typeName: "integer", nullable: false },
  { name: "name", typeName: "text", nullable: true },
  { name: "note", typeName: "text", nullable: true },
];

afterEach(cleanup);

describe("InsertRowDialog", () => {
  it("stages typed column values and omits blank nullable columns", () => {
    const onStage = vi.fn();
    const onClose = vi.fn();

    render(
      <InsertRowDialog columns={columns} onStage={onStage} onClose={onClose} />,
    );

    fireEvent.change(screen.getByLabelText("Value for id"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Value for name"), {
      target: { value: "dana" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(onStage).toHaveBeenCalledWith([
      { column: "id", value: { type: "integer", value: 7 } },
      { column: "name", value: { type: "text", value: "dana" } },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("stages an explicit NULL for a nullable column", () => {
    const onStage = vi.fn();

    render(
      <InsertRowDialog columns={columns} onStage={onStage} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Value for id"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Value for name"), {
      target: { value: "dana" },
    });
    fireEvent.click(screen.getByLabelText("Set note to NULL"));
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(onStage).toHaveBeenCalledWith([
      { column: "id", value: { type: "integer", value: 7 } },
      { column: "name", value: { type: "text", value: "dana" } },
      { column: "note", value: { type: "null" } },
    ]);
  });

  it("requires a non-nullable column", () => {
    const onStage = vi.fn();

    render(
      <InsertRowDialog columns={columns} onStage={onStage} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Value for name"), {
      target: { value: "dana" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(screen.getByRole("alert").textContent).toBe("id is required.");
    expect(onStage).not.toHaveBeenCalled();
  });

  it("refuses to set a non-nullable column to NULL", () => {
    const onStage = vi.fn();

    render(
      <InsertRowDialog columns={columns} onStage={onStage} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByLabelText("Set id to NULL"));
    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(screen.getByRole("alert").textContent).toBe("id cannot be NULL.");
    expect(onStage).not.toHaveBeenCalled();
  });

  it("requires at least one value", () => {
    const onStage = vi.fn();
    const nullable = columns.map((column) => ({ ...column, nullable: true }));

    render(
      <InsertRowDialog columns={nullable} onStage={onStage} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stage insert" }));

    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a value for at least one column.",
    );
    expect(onStage).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();

    render(
      <InsertRowDialog columns={columns} onStage={vi.fn()} onClose={onClose} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
