import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import type { EngineCapabilities, QueryResult } from "../../domain";
import { connectSqlite, disconnectConnection } from "../../services/connections";
import { listObjects } from "../../services/metadata";
import {
  executeQuery,
  getQueryCapabilities,
} from "../../services/queries";
import type { QueryOutcome } from "../results/queryOutcome";
import { QueryTabView } from "./QueryTabView";

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
  getQueryCapabilities: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

// The view reports outcomes to the workspace message log; a stub keeps the
// test independent of the real provider (connection state, schema listing).
vi.mock("@/app/store", () => ({
  useWorkspace: () => ({ log: vi.fn() }),
}));

const connectMock = vi.mocked(connectSqlite);
const disconnectMock = vi.mocked(disconnectConnection);
const listObjectsMock = vi.mocked(listObjects);
const executeMock = vi.mocked(executeQuery);
const capabilitiesMock = vi.mocked(getQueryCapabilities);
const toastErrorMock = vi.mocked(toast.error);

function gridResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    operationId: "op",
    state: "succeeded",
    columns: [{ name: "id" }],
    rows: [[{ type: "integer", value: 1 }]],
    truncated: false,
    ...overrides,
  };
}

function capabilities(
  overrides: Partial<EngineCapabilities> = {},
): EngineCapabilities {
  return {
    transactions: false,
    ddlTransactions: false,
    savepoints: false,
    cancellation: false,
    schemas: false,
    multipleDatabases: false,
    tls: false,
    ...overrides,
  };
}

function Harness({
  initialSql = "",
  connectionId = "sqlite-1",
  onExecuted,
}: {
  initialSql?: string;
  connectionId?: string | null;
  onExecuted?: (sql: string) => void;
}) {
  const [sql, setSql] = useState(initialSql);

  return (
    <QueryTabView
      connectionId={connectionId}
      sql={sql}
      onSqlChange={setSql}
      onExecuted={(next) => onExecuted?.(next)}
    />
  );
}

afterEach(cleanup);

describe("QueryTabView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listObjectsMock.mockResolvedValue([{ name: "users", kind: "table" }]);
    capabilitiesMock.mockResolvedValue(capabilities());
  });

  it("shows a no-active-connection state and disables Run when connectionId is null", () => {
    render(<Harness connectionId={null} />);

    expect(screen.getByText(/No active connection/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Run/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // No connection is opened by the view itself.
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("runs the editor SQL on the supplied connection and forwards the outcome", async () => {
    executeMock.mockResolvedValue(gridResult());
    render(<Harness initialSql="SELECT id FROM users" />);

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    expect(executeMock.mock.calls[0][0]).toBe("sqlite-1");
    expect(executeMock.mock.calls[0][1].sql).toBe("SELECT id FROM users");
    expect(connectMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("results-panel").textContent).toBe("grid"),
    );
  });

  it("runs only the statement at the cursor, not the whole document", async () => {
    executeMock.mockResolvedValue(gridResult());
    render(<Harness initialSql={"SELECT 1;\nSELECT 2;"} />);

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    expect(executeMock.mock.calls[0][1].sql).toBe("SELECT 1");
  });

  it("calls onExecuted after a successful run", async () => {
    executeMock.mockResolvedValue(gridResult());
    const onExecuted = vi.fn();
    render(
      <Harness initialSql="SELECT id FROM users" onExecuted={onExecuted} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await waitFor(() =>
      expect(onExecuted).toHaveBeenCalledWith("SELECT id FROM users"),
    );
  });

  it("does not call onExecuted when the run fails", async () => {
    executeMock.mockRejectedValue({
      category: "connection",
      message: "connection is not open",
    });
    const onExecuted = vi.fn();
    render(<Harness initialSql="SELECT 1" onExecuted={onExecuted} />);

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("connection is not open"),
    );
    expect(onExecuted).not.toHaveBeenCalled();
    expect(screen.getByTestId("results-panel").textContent).toBe("error");
  });

  it("keeps the workspace interactive while a slow query runs", async () => {
    let resolveQuery: ((value: QueryResult) => void) | undefined;
    executeMock.mockImplementation(
      () =>
        new Promise<QueryResult>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    render(<Harness initialSql="SELECT 1" />);

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    expect(screen.getByTestId("results-panel").textContent).toBe("running");
    expect(
      (screen.getByRole("button", { name: /Running/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      resolveQuery?.(gridResult());
    });

    await waitFor(() =>
      expect(screen.getByTestId("results-panel").textContent).toBe("grid"),
    );
  });

  it("never opens or closes a connection of its own", async () => {
    render(<Harness />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(connectMock).not.toHaveBeenCalled();
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
