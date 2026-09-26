import type { CellValue, ColumnInfo, ObjectRef, QueryError, Row } from "../../domain";
import { createOperationId } from "../../domain";
import type {
  ChangeGroupResult,
  ChangeRequest,
  PendingChange,
  RowIdentity,
  RowKey,
} from "../../services/tableData";

/**
 * Client-side state of a staged change.
 *
 * `applying` is transient while a request is in flight. `applied` means the
 * engine confirmed the change (it is removed from the staged list shortly
 * after). `conflict` means the target row changed and nothing was overwritten;
 * `outcome_unknown` means the write completion could not be confirmed and must
 * never be retried automatically.
 */
export type StagedChangeStatus =
  | "pending"
  | "applying"
  | "applied"
  | "failed"
  | "conflict"
  | "outcome_unknown";

/** Kind of a staged change, matching the `PendingChange` tag. */
export type StagedChangeKind = PendingChange["kind"];

/** A locally staged table mutation, keyed to one row or one new row. */
export interface StagedChange {
  /** Stable client identifier; reused as the apply `operationId`. */
  id: string;
  /** Table the change targets. */
  object: ObjectRef;
  /** Guarded change payload sent to the backend. */
  change: PendingChange;
  /** Current apply state. */
  status: StagedChangeStatus;
  /** Stable string derived from the row identity keys. */
  rowKey: string;
  /** Original page row index for update/delete, or `null` for an insert. */
  rowIndex: number | null;
  /** Column names the change touches. */
  columns: string[];
  /** Error for a failed/uncertain outcome. */
  error?: QueryError;
  /** Columns that no longer matched when the change conflicted. */
  conflictedColumns: string[];
  /** Rows affected on a successful apply. */
  affectedRows?: number;
}

/** Counts and flags derived from the staged list. */
export interface StagedSummary {
  /** Total staged changes. */
  total: number;
  /** Changes waiting to be applied. */
  pending: number;
  /** Changes that failed on the last apply and can be retried. */
  failed: number;
  /** Changes whose row changed on the server. */
  conflict: number;
  /** Changes whose write completion is unconfirmed. */
  outcomeUnknown: number;
  /** Changes ready to apply (pending or failed). */
  applyable: number;
  /** Whether the batch contains a delete. */
  hasDeletes: boolean;
  /** Whether a conflict or uncertain outcome blocks a safe re-apply. */
  hasBlocking: boolean;
}

/** Whether a staged change may be included in the next apply. */
export function isApplyable(change: StagedChange): boolean {
  return change.status === "pending" || change.status === "failed";
}

/** Whether a status blocks re-applying until the user resolves it. */
export function isBlocking(change: StagedChange): boolean {
  return change.status === "conflict" || change.status === "outcome_unknown";
}

/** Deep equality for normalized cell values. */
export function cellValuesEqual(left: CellValue, right: CellValue): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "null" || right.type === "null") {
    return true;
  }
  if (left.type === "bytes" && right.type === "bytes") {
    if (left.value.length !== right.value.length) {
      return false;
    }
    return left.value.every((byte, index) => byte === right.value[index]);
  }
  if ("value" in left && "value" in right) {
    return left.value === right.value;
  }
  return false;
}

/** Canonical string for a normalized value, used inside row-key strings. */
function cellValueKey(value: CellValue): string {
  if (value.type === "null") {
    return "null";
  }
  if (value.type === "bytes") {
    return `bytes:${value.value.join(",")}`;
  }
  return `${value.type}:${String(value.value)}`;
}

/** Canonical, collision-resistant string for a set of identity keys. */
export function rowKeyString(keys: RowKey[]): string {
  return keys.map((key) => `${key.column}\u0000${cellValueKey(key.value)}`).join("\u0001");
}

/**
 * Builds the identity keys for a page row from the backend-reported columns.
 *
 * Returns `null` when the row lacks a value for any identity column or when no
 * identity columns are known, so callers can refuse to target an unsafe row.
 */
export function rowIdentityFor(
  row: Row,
  columns: ColumnInfo[],
  identityColumns: string[],
): RowIdentity | null {
  if (identityColumns.length === 0) {
    return null;
  }

  const keys: RowKey[] = [];
  for (const name of identityColumns) {
    const index = columns.findIndex((column) => column.name === name);
    if (index < 0) {
      return null;
    }
    keys.push({ column: name, value: row[index] ?? { type: "null" } });
  }

  return { keys, originalValues: [] };
}

function updateValuesOf(change: PendingChange): RowKey[] {
  return change.kind === "update" ? change.values : [];
}

function updateIdentityOf(change: PendingChange): RowIdentity | null {
  return change.kind === "update" ? change.identity : null;
}

/**
 * Stages a single cell edit, merging into any existing update for the row.
 *
 * The original value is kept so the backend can detect a stale row. Editing a
 * cell back to its original value removes that column from the staged update,
 * and removing the last column drops the staged change entirely.
 */
export function stageCellEdit(
  staged: readonly StagedChange[],
  params: {
    object: ObjectRef;
    rowIndex: number;
    identity: RowIdentity;
    column: string;
    original: CellValue;
    next: CellValue;
    id?: string;
  },
): StagedChange[] {
  const { identity } = params;
  if (identity.keys.length === 0) {
    return [...staged];
  }

  const rowKey = rowKeyString(identity.keys);
  const existing = staged.find(
    (change) => change.change.kind === "update" && change.rowKey === rowKey,
  );

  const values = new Map<string, CellValue>();
  const originals = new Map<string, CellValue>();
  if (existing) {
    for (const key of updateValuesOf(existing.change)) {
      values.set(key.column, key.value);
    }
    for (const key of updateIdentityOf(existing.change)?.originalValues ?? []) {
      originals.set(key.column, key.value);
    }
  }

  if (cellValuesEqual(params.next, params.original)) {
    values.delete(params.column);
    originals.delete(params.column);
  } else {
    values.set(params.column, params.next);
    originals.set(params.column, params.original);
  }

  const remaining = staged.filter((change) => change !== existing);
  if (values.size === 0) {
    return remaining;
  }

  const nextIdentity: RowIdentity = {
    keys: identity.keys,
    originalValues: [...originals.entries()].map(([column, value]) => ({
      column,
      value,
    })),
  };
  const change: PendingChange = {
    kind: "update",
    identity: nextIdentity,
    values: [...values.entries()].map(([column, value]) => ({ column, value })),
  };

  const next: StagedChange = {
    id: existing?.id ?? params.id ?? createOperationId(),
    object: params.object,
    change,
    status: "pending",
    rowKey,
    rowIndex: params.rowIndex,
    columns: [...values.keys()],
    conflictedColumns: [],
  };
  return [...remaining, next];
}

/** Stages one insert of a new row from column/value pairs. */
export function stageInsert(
  staged: readonly StagedChange[],
  object: ObjectRef,
  values: readonly RowKey[],
  id: string = createOperationId(),
): StagedChange[] {
  return [
    ...staged,
    {
      id,
      object,
      change: { kind: "insert", values: [...values] },
      status: "pending",
      rowKey: id,
      rowIndex: null,
      columns: values.map((value) => value.column),
      conflictedColumns: [],
    },
  ];
}

/**
 * Whether a staged change carries enough data to be sent to the backend.
 *
 * A freshly staged insert starts empty (the user fills it in inline), so an
 * insert with no values is a draft rather than an applyable change.
 */
export function hasPendingData(change: StagedChange): boolean {
  return change.change.kind !== "insert" || change.change.values.length > 0;
}

/**
 * Sets one cell of a staged insert, merging it into the insert's values.
 *
 * Editing the cell to `NULL` removes the column from the insert, so untouched
 * or cleared columns are not sent as explicit nulls.
 */
export function updateInsertCell(
  staged: readonly StagedChange[],
  id: string,
  column: string,
  value: CellValue,
): StagedChange[] {
  return staged.map((change) => {
    if (change.id !== id || change.change.kind !== "insert") {
      return change;
    }
    const values = change.change.values.filter((entry) => entry.column !== column);
    if (value.type !== "null") {
      values.push({ column, value });
    }
    return {
      ...change,
      change: { kind: "insert", values },
      columns: values.map((entry) => entry.column),
      status: "pending",
      conflictedColumns: [],
      error: undefined,
    };
  });
}

/**
 * Stages a delete for the identified row.
 *
 * A pending update/delete for the same row is replaced, since deleting the row
 * supersedes editing it.
 */
export function stageDelete(
  staged: readonly StagedChange[],
  object: ObjectRef,
  identity: RowIdentity,
  rowIndex: number,
  id: string = createOperationId(),
): StagedChange[] {
  if (identity.keys.length === 0) {
    return [...staged];
  }

  const rowKey = rowKeyString(identity.keys);
  const remaining = staged.filter((change) => change.rowKey !== rowKey);
  return [
    ...remaining,
    {
      id,
      object,
      change: { kind: "delete", identity: { keys: identity.keys } },
      status: "pending",
      rowKey,
      rowIndex,
      columns: identity.keys.map((key) => key.column),
      conflictedColumns: [],
    },
  ];
}

/**
 * Stages deletes for every selected page row that can be safely identified.
 *
 * Rows missing from the loaded page, or without a backend-confirmed identity,
 * are skipped so a multi-row delete never targets a row the engine cannot
 * address. Existing updates for a deleted row are replaced by its delete.
 */
export function stageDeleteRows(
  staged: readonly StagedChange[],
  object: ObjectRef,
  params: {
    /** Loaded page rows, indexed by their grid row. */
    rows: readonly Row[];
    /** Columns for the loaded page. */
    columns: ColumnInfo[];
    /** Backend-reported identity columns. */
    identityColumns: string[];
    /** Page row indexes selected in the grid. */
    rowIndexes: readonly number[];
  },
): StagedChange[] {
  let next: StagedChange[] = [...staged];
  for (const rowIndex of params.rowIndexes) {
    const row = params.rows[rowIndex];
    if (!row) {
      continue;
    }
    const identity = rowIdentityFor(row, params.columns, params.identityColumns);
    if (identity === null) {
      continue;
    }
    next = stageDelete(next, object, identity, rowIndex);
  }
  return next;
}

/** Removes one staged change by id. */
export function removeStagedChange(
  staged: readonly StagedChange[],
  id: string,
): StagedChange[] {
  return staged.filter((change) => change.id !== id);
}

/** Removes every change whose last apply was confirmed. */
export function removeApplied(staged: readonly StagedChange[]): StagedChange[] {
  return staged.filter((change) => change.status !== "applied");
}

/** Converts a staged change into the backend apply request shape. */
export function stagedChangeToRequest(change: StagedChange): ChangeRequest {
  return {
    operationId: change.id,
    object: change.object,
    change: change.change,
  };
}

/** Requests for every change that may be applied right now, in staged order. */
export function pendingRequests(staged: readonly StagedChange[]): ChangeRequest[] {
  return staged
    .filter((change) => isApplyable(change) && hasPendingData(change))
    .map(stagedChangeToRequest);
}

/** Insert changes that are still queued (new rows being filled in inline). */
export function stagedInserts(staged: readonly StagedChange[]): StagedChange[] {
  return staged.filter(
    (change) => change.change.kind === "insert" && change.status !== "applied",
  );
}

/** Counts and flags for the staged list. */
export function summarizeStaged(staged: readonly StagedChange[]): StagedSummary {
  let pending = 0;
  let failed = 0;
  let conflict = 0;
  let outcomeUnknown = 0;
  let applyable = 0;
  let hasDeletes = false;
  let hasBlocking = false;

  for (const change of staged) {
    if (change.change.kind === "delete" && change.status !== "applied") {
      hasDeletes = true;
    }
    switch (change.status) {
      case "pending":
        pending += 1;
        if (hasPendingData(change)) {
          applyable += 1;
        }
        break;
      case "failed":
        failed += 1;
        if (hasPendingData(change)) {
          applyable += 1;
        }
        break;
      case "conflict":
        conflict += 1;
        hasBlocking = true;
        break;
      case "outcome_unknown":
        outcomeUnknown += 1;
        hasBlocking = true;
        break;
      case "applying":
        applyable += 1;
        break;
      case "applied":
        break;
    }
  }

  return {
    total: staged.length,
    pending,
    failed,
    conflict,
    outcomeUnknown,
    applyable,
    hasDeletes,
    hasBlocking,
  };
}

/**
 * Reconciles a batch result into the staged list.
 *
 * Per-change outcomes are authoritative only when changes committed
 * independently. A grouped conflict or failure rolled the whole transaction
 * back, so changes the engine "applied" inside it return to `pending` and the
 * conflict/failure is isolated. A grouped `outcome_unknown` marks the entire
 * batch uncertain and must not be retried.
 */
export function reconcileApplyResult(
  staged: readonly StagedChange[],
  group: ChangeGroupResult,
): StagedChange[] {
  const byId = new Map(group.results.map((result) => [result.operationId, result]));
  const rolledBack = group.grouped && (group.state === "conflict" || group.state === "failed");
  const uncertain = group.grouped && group.state === "outcome_unknown";

  return staged.map((change) => {
    const result = byId.get(change.id);

    if (uncertain) {
      if (!isApplyable(change) && change.status !== "applying") {
        return change;
      }
      return {
        ...change,
        status: "outcome_unknown",
        conflictedColumns: [],
        error: result?.error ?? {
          category: "transport",
          message:
            "The connection was lost before the write outcome could be confirmed.",
        },
      };
    }

    if (rolledBack) {
      if (!result) {
        // The transaction rolled back before this change ran, so it was never
        // attempted and returns to the queue instead of staying "applying".
        return { ...change, status: "pending", conflictedColumns: [], error: undefined };
      }
      if (result.outcome === "conflict") {
        return {
          ...change,
          status: "conflict",
          conflictedColumns: result.conflictedColumns ?? [],
          error: undefined,
        };
      }
      if (result.outcome === "failed") {
        return { ...change, status: "failed", error: result.error };
      }
      return { ...change, status: "pending", conflictedColumns: [], error: undefined };
    }

    if (!result) {
      return change;
    }

    switch (result.outcome) {
      case "applied":
        return {
          ...change,
          status: "applied",
          affectedRows: result.affectedRows,
          conflictedColumns: [],
          error: undefined,
        };
      case "conflict":
        return {
          ...change,
          status: "conflict",
          conflictedColumns: result.conflictedColumns ?? [],
          error: undefined,
        };
      case "failed":
        return { ...change, status: "failed", error: result.error };
      case "outcome_unknown":
        return { ...change, status: "outcome_unknown", error: result.error };
    }
  });
}

/** Human-readable one-line description of a staged change. */
export function describeStagedChange(change: StagedChange): string {
  const target =
    change.change.kind === "insert"
      ? "new row"
      : change.rowIndex !== null
        ? `row ${change.rowIndex + 1}`
        : "row";
  const columns = change.columns.length > 0 ? change.columns.join(", ") : "-";
  switch (change.change.kind) {
    case "insert":
      return `Insert ${columns}`;
    case "update":
      return `Update ${target} · ${columns}`;
    case "delete":
      return `Delete ${target}`;
  }
}

/** Cell locations (row then column) with a staged update, for grid indicators. */
export function stagedEditedCells(
  staged: readonly StagedChange[],
): Map<number, Set<string>> {
  const cells = new Map<number, Set<string>>();
  for (const change of staged) {
    if (change.change.kind !== "update" || change.rowIndex === null) {
      continue;
    }
    const columns = cells.get(change.rowIndex) ?? new Set<string>();
    for (const value of change.change.values) {
      columns.add(value.column);
    }
    cells.set(change.rowIndex, columns);
  }
  return cells;
}

/** Row indexes with a staged delete, for grid indicators. */
export function stagedDeletedRows(staged: readonly StagedChange[]): Set<number> {
  const rows = new Set<number>();
  for (const change of staged) {
    if (change.change.kind === "delete" && change.rowIndex !== null) {
      rows.add(change.rowIndex);
    }
  }
  return rows;
}
