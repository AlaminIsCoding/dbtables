import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../domain";
import { ResultsPanel } from "./ResultsPanel";
import type { QueryOutcome } from "./queryOutcome";

const glide = vi.hoisted(() => ({
  props: undefined as
    | {
        rows: number;
        columns: { title: string }[];
        onCellEdited?: unknown;
        onCellsEdited?: unknown;
        onGridSelectionChange?: (selection: {
          current?: { cell: readonly [number, number] };
        }) => void;
        onCellActivated?: (cell: readonly [number, number]) => void;
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

afterEach(() => {
  cleanup();
  glide.props = undefined;
});

function resultWith(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op-1",
    state: "succeeded",
    truncated: false,
    ...overrides,
  };
}

function renderOutcome(outcome: QueryOutcome) {
  return render(<ResultsPanel outcome={outcome} />);
}

describe("ResultsPanel", () => {
  it("shows an idle prompt before any query runs", () => {
    renderOutcome({ kind: "idle" });

    expect(screen.getByText("No results yet")).toBeTruthy();
    expect(screen.getByTestId("results-summary").textContent).toContain(
      "No query run",
    );
  });

  it("shows a distinct running state", () => {
    renderOutcome({ kind: "running" });

    expect(screen.getByText("Running query…")).toBeTruthy();
    expect(screen.getByTestId("results-summary").textContent).toContain(
      "Running",
    );
  });

  it("renders a grid success with a read-only Glide instance", () => {
    renderOutcome({
      kind: "grid",
      result: resultWith({
        columns: [{ name: "id" }, { name: "name" }],
        rows: [
          [
            { type: "integer", value: 1 },
            { type: "text", value: "alice" },
          ],
          [
            { type: "integer", value: 2 },
            { type: "text", value: "bob" },
          ],
        ],
        durationMs: 5,
      }),
    });

    expect(glide.props?.rows).toBe(2);
    expect(glide.props?.onCellEdited).toBeUndefined();
    expect(glide.props?.onCellsEdited).toBeUndefined();
    expect(
      screen.getByRole("region", {
        name: /Query results grid: 2 rows, 2 columns/,
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("results-summary").textContent).toBe(
      "2 rows · 2 columns · 5 ms",
    );
  });

  it("renders a partial result with a bounded fetch-more action", () => {
    const onFetchMore = vi.fn();
    render(
      <ResultsPanel
        outcome={{
          kind: "partial",
          result: resultWith({
            columns: [{ name: "id" }],
            rows: [[{ type: "integer", value: 1 }]],
            truncated: true,
          }),
        }}
        canFetchMore
        onFetchMore={onFetchMore}
      />,
    );

    expect(screen.getByTestId("results-summary").textContent).toContain(
      "partial",
    );
    expect(screen.getByTestId("partial-notice").textContent).toContain(
      "Showing first 1 row",
    );

    fireEvent.click(screen.getByRole("button", { name: "Fetch more" }));
    expect(onFetchMore).toHaveBeenCalledTimes(1);
  });

  it("disables fetch-more while an extension is in flight", () => {
    render(
      <ResultsPanel
        outcome={{
          kind: "partial",
          result: resultWith({
            columns: [{ name: "id" }],
            rows: [[{ type: "integer", value: 1 }]],
            truncated: true,
          }),
        }}
        canFetchMore
        fetchingMore
        onFetchMore={() => {}}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Fetching…",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("opens the value viewer for the selected cell", () => {
    renderOutcome({
      kind: "grid",
      result: resultWith({
        columns: [{ name: "notes" }],
        rows: [[{ type: "text", value: "a\nlong\nvalue" }]],
      }),
    });

    act(() => {
      glide.props?.onGridSelectionChange?.({ current: { cell: [0, 0] } });
    });

    fireEvent.click(screen.getByRole("button", { name: "View value" }));

    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(
      "Cell value: notes",
    );
    expect(screen.getByTestId("value-viewer-text").textContent).toBe(
      "a\nlong\nvalue",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close value viewer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the value viewer when a cell is activated", () => {
    renderOutcome({
      kind: "grid",
      result: resultWith({
        columns: [{ name: "payload" }],
        rows: [[{ type: "text", value: '{"a":1}' }]],
      }),
    });

    act(() => {
      glide.props?.onCellActivated?.([0, 0]);
    });

    expect(screen.getByTestId("value-viewer-text").textContent).toContain(
      '"a": 1',
    );
  });

  it("shows an empty-result state for a successful query with no rows", () => {
    renderOutcome({
      kind: "empty",
      result: resultWith({ columns: [{ name: "id" }], rows: [] }),
    });

    expect(screen.getByText("Query returned no rows")).toBeTruthy();
    expect(screen.getByTestId("results-summary").textContent).toContain(
      "0 rows · 1 columns",
    );
  });

  it("shows a statement outcome for a result with no columns", () => {
    renderOutcome({
      kind: "statement",
      result: resultWith({ affectedRows: 3 }),
    });

    expect(screen.getByText("Statement completed")).toBeTruthy();
    expect(screen.getByText("3 rows affected.")).toBeTruthy();
  });

  it("shows a failed query as an alert with its category", () => {
    renderOutcome({
      kind: "failed",
      error: {
        category: "syntax",
        message: "the SQL statement has a syntax error",
        engineDetail: "near WHERE: syntax error",
      },
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Query failed");
    expect(alert.textContent).toContain("syntax error");
    expect(alert.textContent).toContain("syntax");
  });

  it("shows a command-level error distinctly from a failed query", () => {
    renderOutcome({
      kind: "error",
      error: { category: "connection", message: "connection is not open" },
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Backend error");
    expect(alert.textContent).toContain("connection is not open");
  });

  it("shows cancelled and uncertain outcomes distinctly", () => {
    renderOutcome({ kind: "cancelled" });
    expect(screen.getByText("Query cancelled")).toBeTruthy();

    cleanup();

    renderOutcome({
      kind: "outcome_unknown",
      error: { category: "transport", message: "connection lost" },
    });
    expect(screen.getByRole("alert").textContent).toContain("Outcome unknown");
    expect(screen.getByRole("alert").textContent).toContain("connection lost");
  });
});
