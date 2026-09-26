import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResultsPanel } from "./ResultsPanel";

const glide = vi.hoisted(() => ({
  props: undefined as
    | {
        onCellEdited: (
          cell: readonly [number, number],
          value: unknown,
        ) => void;
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

afterEach(cleanup);

describe("ResultsPanel", () => {
  it("renders the mock result summary and grid by default", () => {
    render(<ResultsPanel />);

    expect(screen.getByTestId("results-summary").textContent).toContain("120 rows");
    expect(screen.getByTestId("results-summary").textContent).toContain("11 columns");
    expect(
      screen.getByRole("region", {
        name: /Query results grid: 120 rows, 11 columns/,
      }),
    ).toBeTruthy();
  });

  it("shows the empty sample state", () => {
    render(<ResultsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Empty" }));

    expect(screen.getByText("Query returned no rows")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("shows the loading sample state", () => {
    render(<ResultsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Loading" }));

    expect(screen.getByText("Running query…")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("counts local grid edits without persisting them", () => {
    render(<ResultsPanel />);

    act(() => {
      glide.props?.onCellEdited([1, 0], {
        kind: "text",
        data: "Renamed",
        displayData: "Renamed",
        allowOverlay: true,
      });
    });

    expect(screen.getByTestId("results-summary").textContent).toContain(
      "1 local edit (not saved)",
    );
  });
});
