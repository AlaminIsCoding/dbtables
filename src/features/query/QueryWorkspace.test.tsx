import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryResult } from "../../domain";
import type { QueryOutcome } from "../results/queryOutcome";
import { connectSqlite } from "../../services/connections";
import { listObjects } from "../../services/metadata";
import { executeQuery } from "../../services/queries";
import { QueryWorkspace } from "./QueryWorkspace";

// The results pane is exercised by its own suite; here it is a lightweight
// probe so the query -> outcome handoff is observable without Glide/canvas.
vi.mock("../results", () => ({
  ResultsPanel: ({ outcome }: { outcome: QueryOutcome }) => (
    <div data-testid="results-panel">{outcome.kind}</div>
  ),
}));

vi.mock("../../services/connections", () => ({
  connectSqlite: vi.fn(),
  disconnectConnection: vi.fn(),
}));

vi.mock("../../services/metadata", () => ({
  listObjects: vi.fn(),
}));

vi.mock("../../services/queries", () => ({
  executeQuery: vi.fn(),
}));

const connectMock = vi.mocked(connectSqlite);
const listObjectsMock = vi.mocked(listObjects);
const executeMock = vi.mocked(executeQuery);

function gridResult(): QueryResult {
  return {
    operationId: "op",
    state: "succeeded",
    columns: [{ name: "id" }],
    rows: [[{ type: "integer", value: 1 }]],
    truncated: false,
  };
}

/** Wraps the workspace with the controlled editor state the tab strip owns. */
function Harness({
  label = "Query 1",
  initialSql = "",
}: {
  label?: string;
  initialSql?: string;
}) {
  const [sql, setSql] = useState(initialSql);
  const [dirty, setDirty] = useState(initialSql.length > 0);

  return (
    <QueryWorkspace
      label={label}
      sql={sql}
      dirty={dirty}
      onSqlChange={(next) => {
        setSql(next);
        setDirty(true);
      }}
      onExecuted={() => setDirty(false)}
    />
  );
}

function editorText(): string {
  return screen.getByTestId("sql-editor").textContent ?? "";
}

async function openDatabase() {
  connectMock.mockResolvedValue("sqlite-1");
  listObjectsMock.mockResolvedValue([{ name: "users", kind: "table" }]);

  fireEvent.change(screen.getByLabelText("SQLite file"), {
    target: { value: "C:/data/app.sqlite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  await screen.findByRole("button", { name: /users/i });
}

afterEach(cleanup);

describe("QueryWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders connection controls with Run disabled before connecting", () => {
    render(<Harness />);

    expect(screen.getByText("SQL editor · Query 1")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByLabelText("SQLite file")).toBeTruthy();
    expect(screen.getByLabelText("SQL editor")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("results-panel").textContent).toBe("idle");
  });

  it("lists objects and loads a selected object into the editor", async () => {
    render(<Harness />);
    await openDatabase();

    fireEvent.click(screen.getByRole("button", { name: /users/i }));

    expect(editorText()).toContain('SELECT * FROM "users";');
    expect(
      (screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("runs the editor SQL and forwards the outcome to the results pane", async () => {
    render(<Harness initialSql="SELECT id FROM users" />);
    await openDatabase();
    executeMock.mockResolvedValue(gridResult());

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1].sql).toBe("SELECT id FROM users");
    expect(screen.getByTestId("results-panel").textContent).toBe("grid");
  });

  it("clears the unsaved marker when the tab's SQL is executed", async () => {
    render(<Harness initialSql="SELECT 1" />);
    await openDatabase();
    executeMock.mockResolvedValue(gridResult());

    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("keeps the workspace usable while a slow query runs", async () => {
    render(<Harness initialSql="SELECT pg_sleep(10)" />);
    await openDatabase();

    let resolveQuery: ((value: QueryResult) => void) | undefined;
    executeMock.mockImplementation(
      () =>
        new Promise<QueryResult>((resolve) => {
          resolveQuery = resolve;
        }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(screen.getByTestId("results-panel").textContent).toBe("running");
    expect(
      (screen.getByRole("button", { name: "Running…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Connection controls remain interactive during execution.
    expect(
      (screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    await act(async () => {
      resolveQuery?.(gridResult());
    });

    expect(screen.getByTestId("results-panel").textContent).toBe("grid");
  });
});
