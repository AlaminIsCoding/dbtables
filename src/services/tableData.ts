import { invoke } from "@tauri-apps/api/core";

import type {
  CellValue,
  ObjectRef,
  QueryError,
  TablePage,
  TablePageRequest,
} from "../domain";

/** Keep the command name in sync with `src-tauri/src/commands/table_data.rs`. */
export const FETCH_TABLE_PAGE_COMMAND = "fetch_table_page";
export const APPLY_TABLE_CHANGES_COMMAND = "apply_table_changes";

/**
 * Fetches one bounded, filtered, sorted page of a table or view.
 *
 * The request carries column identifiers and bound values separately; the
 * backend validates every identifier against table metadata and binds
 * comparison values, so no caller text becomes SQL. The returned page reports
 * the columns, the effective window, and the row identity the backend could
 * establish (absent when the object has no primary key or safe row identifier).
 */
export async function fetchTablePage(
  connectionId: string,
  request: TablePageRequest,
): Promise<TablePage> {
  return invoke<TablePage>(FETCH_TABLE_PAGE_COMMAND, {
    connectionId,
    request,
  });
}

/**
 * A column identifier paired with a bound value, mirroring the Rust `RowKey`.
 *
 * The two halves stay separate on purpose: `column` is an identifier the backend
 * validates and quotes, and `value` is bound as a parameter. Neither field may
 * carry SQL text.
 */
export interface RowKey {
  /** Column identifier. */
  column: string;
  /** Bound value for the column. */
  value: CellValue;
}

/**
 * Stable identity for an existing row plus optional original values.
 *
 * `keys` is the primary key (or another safe identity) with its original
 * values. `originalValues` carries the pre-edit values of the columns being
 * changed so the backend can detect a row that changed since it was read and
 * report a conflict instead of overwriting it.
 */
export interface RowIdentity {
  /** Identity columns and their original values. */
  keys: RowKey[];
  /** Original values of edited columns, used for stale-row detection. */
  originalValues?: RowKey[];
}

/**
 * A staged change to apply to a table row, mirroring the Rust `PendingChange`.
 *
 * Variants carry identifiers and bound values only; no SQL text is ever
 * supplied by the caller.
 */
export type PendingChange =
  | { kind: "insert"; values: RowKey[] }
  | { kind: "update"; identity: RowIdentity; values: RowKey[] }
  | { kind: "delete"; identity: RowIdentity };

/** Terminal outcome of applying a {@link PendingChange}. */
export type ChangeOutcome =
  | "applied"
  | "conflict"
  | "failed"
  | "outcome_unknown";

/** Result of applying one staged change, mirroring the Rust `ChangeResult`. */
export interface ChangeResult {
  /** Stable identifier matching the originating request. */
  operationId: string;
  /** Outcome of the change. */
  outcome: ChangeOutcome;
  /** Rows affected when the change was applied. */
  affectedRows?: number;
  /** Columns whose original values no longer matched on a conflict. */
  conflictedColumns?: string[];
  /** Normalized error for a failed or uncertain outcome. */
  error?: QueryError;
}

/** Batch-level outcome of applying a group of changes. */
export type ChangeGroupState =
  | "applied"
  | "conflict"
  | "failed"
  | "outcome_unknown"
  | "auto_commit";

/** Result of applying a group of staged changes, mirroring Rust `ChangeGroupResult`. */
export interface ChangeGroupResult {
  /** Per-change outcomes, in request order. */
  results: ChangeResult[];
  /** Whether the changes were wrapped in an explicit transaction. */
  grouped: boolean;
  /** Batch-level outcome. */
  state: ChangeGroupState;
  /** Transaction used for the group, when one was opened. */
  transaction?: string;
  /** Rollback or commit error, when the group ended abnormally. */
  error?: QueryError;
}

/** A request to apply one staged change to a table, mirroring Rust `ChangeRequest`. */
export interface ChangeRequest {
  /** Caller-supplied stable identifier echoed in the result. */
  operationId: string;
  /** Table the change targets. */
  object: ObjectRef;
  /** Staged change to apply. */
  change: PendingChange;
}

/**
 * Applies one or more staged changes as a group.
 *
 * The backend validates every request before the first write, groups the batch
 * in a transaction when the engine supports one, and returns a per-change
 * outcome plus the batch state. A conflict never overwrites the target row and
 * an unconfirmed write is reported as `outcome_unknown` rather than success.
 * Only a precondition failure rejects with a `QueryError`; a batch that ran
 * resolves with its normalized outcome.
 */
export async function applyTableChanges(
  connectionId: string,
  requests: ChangeRequest[],
): Promise<ChangeGroupResult> {
  return invoke<ChangeGroupResult>(APPLY_TABLE_CHANGES_COMMAND, {
    connectionId,
    requests,
  });
}
