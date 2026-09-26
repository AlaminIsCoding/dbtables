import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ValueViewer } from "./ValueViewer";

afterEach(cleanup);

describe("ValueViewer", () => {
  it("renders the full cell value with its column and row", () => {
    render(
      <ValueViewer
        value={{ type: "text", value: "line one\nline two" }}
        columnName="notes"
        rowNumber={3}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Cell value: notes",
    );
    expect(screen.getByTestId("value-viewer-text").textContent).toBe(
      "line one\nline two",
    );
    expect(screen.getByText("Row 3")).toBeTruthy();
  });

  it("marks a structured value and pretty-prints it", () => {
    render(
      <ValueViewer
        value={{ type: "text", value: '{"a":1}' }}
        columnName="payload"
        rowNumber={1}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("value-viewer-text").textContent).toContain(
      '"a": 1',
    );
    expect(screen.getByText(/structured/)).toBeTruthy();
  });

  it("closes on the close control and on Escape", () => {
    const onClose = vi.fn();
    render(
      <ValueViewer
        value={{ type: "integer", value: 1 }}
        columnName="id"
        rowNumber={1}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close value viewer" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
