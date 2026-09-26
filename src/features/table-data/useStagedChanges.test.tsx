import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ColumnInfo, ObjectRef, Row } from "../../domain";
import { applyTableChanges, type ChangeGroupResult } from "../../services/tableData";
import { useStagedChanges, type UseStagedChangesOptions } from "./useStagedChanges";

vi.mock("../../services/tableData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tableData")>();
  return { ...actual, applyTableChanges: vi.fn() };
});

const applyMock = vi.mocked(applyTableChanges);

const object: ObjectRef = { name: "users", kind: "table" };
const columns: ColumnInfo[] = [
  { name: "id", typeName: "integer", nullable: false },
  { name: "name", typeName: "text", nullable: true },
];
const rows: Row[] = [
  [
    { type: "integer", value: 1 },
    { type: "text", value: "alice" },
  ],
];

function options(overrides: Partial<UseStagedChangesOptions> = {}): UseStagedChangesOptions {
  return {
    connectionId: "c1",
    object,
    columns,
    rows,
    rowIdentityColumns: ["id"],
    canEdit: true,
    ...overrides,
  };
}

function appliedGroup(
  requests: readonly { operationId: string }[],
): ChangeGroupResult {
  return {
    results: requests.map((request) => ({
      operationId: request.operationId,
      outcome: "applied",
      affectedRows: 1,
    })),
    grouped: true,
    state: "applied",
  };
}

beforeEach(() => {
  applyMock.mockReset();
});

describe("useStagedChanges", () => {
  it("stages a cell edit and applies it as a guarded request", async () => {
    applyMock.mockImplementation(async (_connection, requests) =>
      appliedGroup(requests),
    );
    const onApplied = vi.fn();

    const { result } = renderHook(() => useStagedChanges(options({ onApplied })));

    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
    });

    expect(result.current.staged).toHaveLength(1);
    expect(result.current.summary.pending).toBe(1);

    await act(async () => {
      await result.current.apply();
    });

    expect(applyMock).toHaveBeenCalledTimes(1);
    const [connectionId, requests] = applyMock.mock.calls[0];
    expect(connectionId).toBe("c1");
    expect(requests).toHaveLength(1);
    expect(requests[0].change).toMatchObject({
      kind: "update",
      values: [{ column: "name", value: { type: "text", value: "bob" } }],
    });

    await waitFor(() => expect(result.current.staged).toHaveLength(0));
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("keeps a conflicted change inspectable and does not reload", async () => {
    applyMock.mockImplementation(async (_connection, requests) => ({
      results: [
        {
          operationId: requests[0].operationId,
          outcome: "conflict",
          conflictedColumns: ["name"],
        },
      ],
      grouped: true,
      state: "conflict",
    }));
    const onApplied = vi.fn();

    const { result } = renderHook(() => useStagedChanges(options({ onApplied })));
    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.staged[0].status).toBe("conflict");
    expect(result.current.staged[0].conflictedColumns).toEqual(["name"]);
    expect(result.current.summary.hasBlocking).toBe(true);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("preserves pending edits when the apply precondition is rejected", async () => {
    applyMock.mockRejectedValue({ category: "unsupported", message: "no safe identity" });
    const onApplied = vi.fn();

    const { result } = renderHook(() => useStagedChanges(options({ onApplied })));
    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.applyError).toEqual({
      category: "unsupported",
      message: "no safe identity",
    });
    expect(result.current.staged[0].status).toBe("pending");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("never marks an uncertain write as applied", async () => {
    applyMock.mockImplementation(async (_connection, requests) => ({
      results: [{ operationId: requests[0].operationId, outcome: "outcome_unknown" }],
      grouped: true,
      state: "outcome_unknown",
    }));

    const { result } = renderHook(() => useStagedChanges(options()));
    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.staged[0].status).toBe("outcome_unknown");
    expect(result.current.summary.outcomeUnknown).toBe(1);
  });

  it("ignores every mutation when editing is disabled", () => {
    const { result } = renderHook(() =>
      useStagedChanges(options({ canEdit: false, rowIdentityColumns: [] })),
    );

    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
      result.current.insertRow([{ column: "name", value: { type: "text", value: "x" } }]);
      result.current.deleteRow(0);
    });

    expect(result.current.staged).toHaveLength(0);
    expect(result.current.summary.total).toBe(0);
  });

  it("clears staged edits when the target object changes", async () => {
    const { result, rerender } = renderHook(
      (props: UseStagedChangesOptions) => useStagedChanges(props),
      { initialProps: options() },
    );

    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
    });
    expect(result.current.staged).toHaveLength(1);

    rerender(options({ object: { name: "orders", kind: "table" } }));

    await waitFor(() => expect(result.current.staged).toHaveLength(0));
  });

  it("discards staged edits without writing", () => {
    const { result } = renderHook(() => useStagedChanges(options()));
    act(() => {
      result.current.stageEdit(0, 1, { type: "text", value: "bob" });
    });

    act(() => {
      result.current.discardAll();
    });

    expect(result.current.staged).toHaveLength(0);
    expect(applyMock).not.toHaveBeenCalled();
  });
});
