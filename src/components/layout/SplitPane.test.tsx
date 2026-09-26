import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SplitPane } from "./SplitPane";

afterEach(cleanup);

describe("SplitPane", () => {
  it("renders both panes", () => {
    render(
      <SplitPane
        start={<div>Editor content</div>}
        end={<div>Results content</div>}
      />,
    );

    expect(screen.getByText("Editor content")).toBeTruthy();
    expect(screen.getByText("Results content")).toBeTruthy();
  });

  it("adjusts the split with the keyboard and clamps to the allowed range", () => {
    render(
      <SplitPane
        start={<div>Editor content</div>}
        end={<div>Results content</div>}
        initialFraction={0.5}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize editor and results",
    });

    expect(separator.getAttribute("aria-valuenow")).toBe("50");

    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator.getAttribute("aria-valuenow")).toBe("55");

    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(separator.getAttribute("aria-valuenow")).toBe("50");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("20");

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("80");
  });
});
