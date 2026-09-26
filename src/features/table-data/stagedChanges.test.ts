import { describe, expect, it } from "vitest";

import type { CellValue, ColumnInfo, ObjectRef, Row } from "../../domain";
import type { ChangeGroupResult, RowIdentity } from "../../services/tableData";
import {
  cellValuesEqual,
  describeStagedChange,
  isApplyable,
  isBlocking,
  pendingRequests,
  reconcileApplyResult,
  removeApplied,
  removeStagedChange,
  rowIdentityFor,
  rowKeyString,
  stageCellEdit,
  stageDelete,
  stageInsert,
  stagedDeletedRows,
  stagedEditedCells,
  summarizeStaged,
  type StagedChange,
} from "./stagedChanges";

const object: ObjectRef = { name: "users", kind: "table" };

const columns: ColumnInfo[] = [
  { name: "id", typeName: "integer", nullable: false },
  { name: "name", typeName: "text", nullable: true },
];

const row: Row = [
  { type: "integer", value: 1 },
  { type: "text", value: "alice" },
];

const identity: RowIdentity = {
  keys: [{ column: "id", value: { type: "integer", value: 1 } }],
};

function text(value: string): CellValue {
  return { type: "text", value };
}

function stageEdit(
  staged: readonly StagedChange[],
  column: string,
  next: CellValue,
  original: CellValue,
  rowIndex = 0,
): StagedChange[] {
  return stageCellEdit(staged, {
    object,
    rowIndex,
    identity,
    column,
    original,
    next,
  });
}

describe("cell identity helpers", () => {
  it("compares normalized values structurally", () => {
    expect(cellValuesEqual({ type: "null" }, { type: "null" })).toBe(true);
    expect(cellValuesEqual(text("a"), text("a"))).toBe(true);
    expect(cellValuesEqual(text("a"), text("b"))).toBe(false);
    expect(cellValuesEqual(text("1"), { type: "integer", value: 1 })).toBe(false);
    expect(
      cellValuesEqual({ type: "bytes", value: [1, 2] }, { type: "bytes", value: [1, 2] }),
    ).toBe(true);
    expect(
      cellValuesEqual({ type: "bytes", value: [1] }, { type: "bytes", value: [1, 2] }),
    ).toBe(false);
  });

  it("builds a canonical key string", () => {
    expect(rowKeyString([{ column: "id", value: { type: "integer", value: 1 } }])).toBe(
      "id\u0000integer:1",
    );
  });

  it("builds an identity from reported columns and refuses unsafe rows", () => {
    expect(rowIdentityFor(row, columns, ["id"])).toEqual({
      keys: [{ column: "id", value: { type: "integer", value: 1 } }],
      originalValues: [],
    });
    expect(rowIdentityFor(row, columns, [])).toBeNull();
    expect(rowIdentityFor(row, columns, ["missing"])).toBeNull();
  });
});

describe("stageCellEdit", () => {
  it("stages an update with the original value for conflict detection", () => {
    const staged = stageEdit([], "name", text("bob"), text("alice"));

    expect(staged).toHaveLength(1);
    expect(staged[0].change).toEqual({
      kind: "update",
      identity: {
        keys: [{ column: "id", value: { type: "integer", value: 1 } }],
        originalValues: [{ column: "name", value: { type: "text", value: "alice" } }],
      },
      values: [{ column: "name", value: { type: "text", value: "bob" } }],
    });
    expect(staged[0].columns).toEqual(["name"]);
    expect(staged[0].rowIndex).toBe(0);
  });

  it("merges edits to the same row and preserves the staged id", () => {
    const first = stageEdit([], "name", text("bob"), text("alice"));
    const second = stageEdit(first, "name", text("carol"), text("alice"));

    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].columns).toEqual(["name"]);
  });

  it("drops a column returned to its original value and the change when empty", () => {
    const edited = stageEdit([], "name", text("bob"), text("alice"));
    const reverted = stageEdit(edited, "name", text("alice"), text("alice"));

    expect(reverted).toHaveLength(0);
  });

  it("refuses to stage without an identity", () => {
    const staged = stageCellEdit([], {
      object,
      rowIndex: 0,
      identity: { keys: [] },
      column: "name",
      original: text("alice"),
      next: text("bob"),
    });
    expect(staged).toHaveLength(0);
  });
});

describe("stageInsert and stageDelete", () => {
  it("stages an insert and ignores an empty one", () => {
    const staged = stageInsert([], object, [{ column: "name", value: text("dana") }], "new-1");
    expect(staged).toHaveLength(1);
    expect(staged[0].change).toEqual({
      kind: "insert",
      values: [{ column: "name", value: { type: "text", value: "dana" } }],
    });
    expect(staged[0].rowKey).toBe("new-1");
    expect(stageInsert([], object, [])).toHaveLength(0);
  });

  it("replaces a pending update with a delete for the same row", () => {
    const edited = stageEdit([], "name", text("bob"), text("alice"));
    const deleted = stageDelete(edited, object, identity, 0, "del-1");

    expect(deleted).toHaveLength(1);
    expect(deleted[0].change.kind).toBe("delete");
    expect(deleted[0].rowKey).toBe(rowKeyString(identity.keys));
  });

  it("refuses a delete without a key", () => {
    expect(stageDelete([], object, { keys: [] }, 0)).toHaveLength(0);
  });
});

describe("staged list operations", () => {
  it("removes one change by id and every applied change", () => {
    const inserted = stageInsert([], object, [{ column: "name", value: text("dana") }], "new-1");
    expect(removeStagedChange(inserted, "new-1")).toHaveLength(0);

    const applied: StagedChange[] = [
      { ...inserted[0], status: "applied" },
      { ...inserted[0], id: "new-2" },
    ];
    expect(removeApplied(applied).map((change) => change.id)).toEqual(["new-2"]);
  });

  it("builds requests only for applyable changes", () => {
    const pending = stageInsert([], object, [{ column: "name", value: text("a") }], "p");
    const conflicted: StagedChange[] = [{ ...pending[0], status: "conflict" }];
    expect(pendingRequests(pending).map((request) => request.operationId)).toEqual(["p"]);
    expect(pendingRequests(conflicted)).toHaveLength(0);
    expect(isApplyable(pending[0])).toBe(true);
    expect(isBlocking(conflicted[0])).toBe(true);
  });

  it("summarizes statuses and flags high-impact changes", () => {
    const inserted = stageInsert([], object, [{ column: "name", value: text("a") }], "i");
    const deleted = stageDelete([], object, identity, 0, "d");
    const conflicted: StagedChange = {
      ...stageDelete([], object, identity, 1, "c")[0],
      status: "conflict",
    };
    const summary = summarizeStaged([...inserted, ...deleted, conflicted]);

    expect(summary.total).toBe(3);
    expect(summary.pending).toBe(2);
    expect(summary.conflict).toBe(1);
    expect(summary.applyable).toBe(2);
    expect(summary.hasDeletes).toBe(true);
    expect(summary.hasBlocking).toBe(true);
  });
});

describe("reconcileApplyResult", () => {
  const pending: StagedChange[] = [
    { ...stageInsert([], object, [{ column: "name", value: text("a") }], "a")[0] },
    { ...stageInsert([], object, [{ column: "name", value: text("b") }], "b")[0] },
    { ...stageInsert([], object, [{ column: "name", value: text("c") }], "c")[0] },
  ];

  function group(overrides: Partial<ChangeGroupResult>): ChangeGroupResult {
    return { results: [], grouped: true, state: "applied", ...overrides };
  }

  it("marks grouped applied results as applied", () => {
    const reconciled = reconcileApplyResult(
      pending,
      group({
        results: [
          { operationId: "a", outcome: "applied", affectedRows: 1 },
          { operationId: "b", outcome: "applied", affectedRows: 1 },
          { operationId: "c", outcome: "applied", affectedRows: 1 },
        ],
      }),
    );
    expect(reconciled.every((change) => change.status === "applied")).toBe(true);
    expect(removeApplied(reconciled)).toHaveLength(0);
  });

  it("restores unattempted changes to pending after a rolled-back conflict", () => {
    const reconciled = reconcileApplyResult(
      pending,
      group({
        state: "conflict",
        results: [
          { operationId: "a", outcome: "applied", affectedRows: 1 },
          {
            operationId: "b",
            outcome: "conflict",
            conflictedColumns: ["name"],
          },
        ],
      }),
    );

    expect(reconciled[0].status).toBe("pending");
    expect(reconciled[1].status).toBe("conflict");
    expect(reconciled[1].conflictedColumns).toEqual(["name"]);
    expect(reconciled[2].status).toBe("pending");
  });

  it("marks the whole group uncertain when a write outcome is unknown", () => {
    const reconciled = reconcileApplyResult(
      pending,
      group({
        state: "outcome_unknown",
        results: [{ operationId: "a", outcome: "outcome_unknown" }],
      }),
    );

    expect(reconciled.every((change) => change.status === "outcome_unknown")).toBe(true);
    expect(reconciled[0].error?.category).toBe("transport");
  });

  it("records per-change failures for a grouped rollback", () => {
    const error = { category: "constraint" as const, message: "duplicate key" };
    const reconciled = reconcileApplyResult(
      pending,
      group({
        state: "failed",
        results: [{ operationId: "a", outcome: "failed", error }],
      }),
    );

    expect(reconciled[0].status).toBe("failed");
    expect(reconciled[0].error).toEqual(error);
    expect(reconciled[1].status).toBe("pending");
  });

  it("honours independent auto-committed outcomes", () => {
    const reconciled = reconcileApplyResult(
      pending,
      group({
        grouped: false,
        state: "failed",
        results: [
          { operationId: "a", outcome: "applied", affectedRows: 1 },
          { operationId: "b", outcome: "failed", error: { category: "constraint", message: "no" } },
        ],
      }),
    );

    expect(reconciled[0].status).toBe("applied");
    expect(reconciled[1].status).toBe("failed");
    expect(reconciled[2].status).toBe("pending");
  });
});

describe("staged grid indicators", () => {
  it("reports edited cells and deleted rows", () => {
    const edited = stageEdit([], "name", text("bob"), text("alice"));
    const deleted = stageDelete([], object, identity, 2, "del");

    const cells = stagedEditedCells([...edited, ...deleted]);
    expect(cells.get(0)?.has("name")).toBe(true);
    expect(stagedDeletedRows([...edited, ...deleted])).toEqual(new Set([2]));
  });
});

describe("describeStagedChange", () => {
  it("names the target and columns", () => {
    const edited = stageEdit([], "name", text("bob"), text("alice"));
    const inserted = stageInsert([], object, [{ column: "name", value: text("dana") }], "i");
    const deleted = stageDelete([], object, identity, 3, "d");

    expect(describeStagedChange(edited[0])).toContain("Update row 1");
    expect(describeStagedChange(inserted[0])).toContain("Insert");
    expect(describeStagedChange(deleted[0])).toContain("Delete row 4");
  });
});
