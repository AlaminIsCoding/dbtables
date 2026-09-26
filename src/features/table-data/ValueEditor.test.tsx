import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ColumnInfo } from "../../domain";
import { ValueEditor } from "./ValueEditor";

const textColumn: ColumnInfo = { name: "name", typeName: "text", nullable: true };
const numberColumn: ColumnInfo = { name: "age", typeName: "integer", nullable: true };

afterEach(cleanup);

describe("ValueEditor", () => {
  it("stages a parsed edit", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <ValueEditor
        value={{ type: "text", value: "alice" }}
        column={textColumn}
        rowNumber={1}
        onSave={onSave}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("Cell value"), {
      target: { value: "bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage edit" }));

    expect(onSave).toHaveBeenCalledWith({ type: "text", value: "bob" });
    expect(onClose).toHaveBeenCalled();
  });

  it("stages NULL from the dedicated action", () => {
    const onSave = vi.fn();

    render(
      <ValueEditor
        value={{ type: "text", value: "alice" }}
        column={textColumn}
        rowNumber={1}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set NULL" }));

    expect(onSave).toHaveBeenCalledWith({ type: "null" });
  });

  it("rejects a value that does not match the column type", () => {
    const onSave = vi.fn();

    render(
      <ValueEditor
        value={{ type: "integer", value: 1 }}
        column={numberColumn}
        rowNumber={2}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Cell value"), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage edit" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Enter a whole number.");
  });

  it("closes on Escape without saving", () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    render(
      <ValueEditor
        value={{ type: "text", value: "alice" }}
        column={textColumn}
        rowNumber={1}
        onSave={onSave}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("disables editing for binary values", () => {
    render(
      <ValueEditor
        value={{ type: "bytes", value: [1, 2] }}
        column={{ name: "blob", typeName: "blob", nullable: true }}
        rowNumber={1}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Binary values cannot be edited/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Stage edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
