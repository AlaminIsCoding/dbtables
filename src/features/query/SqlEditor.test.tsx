import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqlEditor } from "./SqlEditor";

afterEach(cleanup);

function editorContent(): HTMLElement {
  return screen.getByTestId("sql-editor").querySelector(".cm-content")!;
}

describe("SqlEditor", () => {
  it("renders an accessible SQL editing surface with the initial value", () => {
    render(<SqlEditor value="SELECT 1" onChange={() => {}} />);

    const surface = screen.getByLabelText("SQL editor");
    expect(surface.getAttribute("contenteditable")).toBe("true");
    expect(screen.getByTestId("sql-editor").textContent).toContain("SELECT 1");
  });

  it("replaces the document when the controlled value changes", () => {
    const { rerender } = render(
      <SqlEditor value="SELECT 1" onChange={() => {}} />,
    );

    rerender(<SqlEditor value="SELECT 2" onChange={() => {}} />);

    expect(screen.getByTestId("sql-editor").textContent).toContain("SELECT 2");
    expect(screen.getByTestId("sql-editor").textContent).not.toContain("SELECT 1");
  });

  it("runs on Ctrl+Enter", () => {
    const onRun = vi.fn();
    render(<SqlEditor value="SELECT 1" onChange={() => {}} onRun={onRun} />);

    fireEvent.keyDown(editorContent(), {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    });

    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("does not run on plain Enter", () => {
    const onRun = vi.fn();
    render(<SqlEditor value="SELECT 1" onChange={() => {}} onRun={onRun} />);

    fireEvent.keyDown(editorContent(), { key: "Enter", code: "Enter" });

    expect(onRun).not.toHaveBeenCalled();
  });
});
