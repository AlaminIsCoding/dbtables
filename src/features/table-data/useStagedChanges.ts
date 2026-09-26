import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CellValue,
  ColumnInfo,
  ObjectRef,
  QueryError,
  Row,
} from "../../domain";
import { toQueryError } from "../../services/errors";
import {
  applyTableChanges,
  type ChangeGroupResult,
  type RowKey,
} from "../../services/tableData";
import {
  isApplyable,
  pendingRequests,
  reconcileApplyResult,
  removeApplied,
  removeStagedChange,
  rowIdentityFor,
  stageCellEdit,
  stageDelete,
  stageDeleteRows,
  stageInsert,
  summarizeStaged,
  updateInsertCell,
  type StagedChange,
  type StagedSummary,
} from "./stagedChanges";

export interface UseStagedChangesOptions {
  /** Connection the apply requests target. */
  connectionId: string;
  /** Table being edited. */
  object: ObjectRef;
  /** Columns for the loaded page. */
  columns: ColumnInfo[];
  /** Rows for the loaded page. */
  rows: Row[];
  /** Backend-reported identity columns for the object. */
  rowIdentityColumns: string[];
  /** Whether the object is a base table with a safe row identity. */
  canEdit: boolean;
  /** Called after a batch that committed at least one change. */
  onApplied?: () => void;
}

export interface StagedChangesController {
  /** All staged changes. */
  staged: StagedChange[];
  /** Derived counts and flags. */
  summary: StagedSummary;
  /** Whether an apply request is in flight. */
  isApplying: boolean;
  /** Precondition error from a rejected apply request. */
  applyError: QueryError | null;
  /** Last batch outcome, kept for messaging. */
  lastGroup: ChangeGroupResult | null;
  /** Stages a grid cell edit. */
  stageEdit: (rowIndex: number, columnIndex: number, value: CellValue) => void;
  /** Stages an insert for a new row. */
  insertRow: (values: RowKey[]) => void;
  /** Sets one cell of a staged insert (inline new-row editing). */
  updateInsert: (id: string, column: string, value: CellValue) => void;
  /** Stages a delete for a loaded row. */
  deleteRow: (rowIndex: number) => void;
  /** Stages deletes for every selectable row among the given indexes. */
  deleteRows: (rowIndexes: readonly number[]) => void;
  /** Removes one staged change. */
  remove: (id: string) => void;
  /** Discards every staged change. */
  discardAll: () => void;
  /** Applies the applyable changes. */
  apply: () => Promise<void>;
  /** Clears the last-batch messaging. */
  clearFeedback: () => void;
}

function targetKeyOf(connectionId: string, object: ObjectRef): string {
  return [
    connectionId,
    object.database ?? "",
    object.schema ?? "",
    object.kind,
    object.name,
  ].join("\u0000");
}

/**
 * Owns staged table edits for one connection and object.
 *
 * Edits are staged locally until an explicit apply. An edit only becomes a
 * guarded change when the row has a backend-confirmed identity, so unsafe rows
 * are never targeted. Applying never retries an uncertain write, and a grouped
 * conflict/failure is rolled back by the backend with the staged edits kept for
 * inspection or discard.
 */
export function useStagedChanges(
  options: UseStagedChangesOptions,
): StagedChangesController {
  const {
    connectionId,
    object,
    columns,
    rows,
    rowIdentityColumns,
    canEdit,
    onApplied,
  } = options;

  const [staged, setStaged] = useState<StagedChange[]>([]);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<QueryError | null>(null);
  const [lastGroup, setLastGroup] = useState<ChangeGroupResult | null>(null);

  const targetKey = targetKeyOf(connectionId, object);
  const previousKeyRef = useRef(targetKey);

  // Refs keep the latest page/columns available to callbacks without making the
  // callback identities change on every page load.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const identityRef = useRef(rowIdentityColumns);
  identityRef.current = rowIdentityColumns;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const objectRef = useRef(object);
  objectRef.current = object;
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  // A different table must not inherit another table's pending edits.
  useEffect(() => {
    if (previousKeyRef.current === targetKey) {
      return;
    }
    previousKeyRef.current = targetKey;
    setStaged([]);
    setIsApplying(false);
    setApplyError(null);
    setLastGroup(null);
  }, [targetKey]);

  const stageEdit = useCallback(
    (rowIndex: number, columnIndex: number, value: CellValue) => {
      if (!canEditRef.current) {
        return;
      }
      const row = rowsRef.current[rowIndex];
      const column = columnsRef.current[columnIndex];
      if (!row || !column) {
        return;
      }
      const identity = rowIdentityFor(
        row,
        columnsRef.current,
        identityRef.current,
      );
      if (identity === null) {
        return;
      }
      setStaged((current) =>
        stageCellEdit(current, {
          object: objectRef.current,
          rowIndex,
          identity,
          column: column.name,
          original: row[columnIndex] ?? { type: "null" },
          next: value,
        }),
      );
    },
    [],
  );

  const insertRow = useCallback((values: RowKey[]) => {
    if (!canEditRef.current) {
      return;
    }
    setStaged((current) => stageInsert(current, objectRef.current, values));
  }, []);

  const updateInsert = useCallback(
    (id: string, column: string, value: CellValue) => {
      setStaged((current) => updateInsertCell(current, id, column, value));
    },
    [],
  );

  const deleteRow = useCallback((rowIndex: number) => {
    if (!canEditRef.current) {
      return;
    }
    const row = rowsRef.current[rowIndex];
    if (!row) {
      return;
    }
    const identity = rowIdentityFor(row, columnsRef.current, identityRef.current);
    if (identity === null) {
      return;
    }
    setStaged((current) =>
      stageDelete(current, objectRef.current, identity, rowIndex),
    );
  }, []);

  const deleteRows = useCallback((rowIndexes: readonly number[]) => {
    if (!canEditRef.current || rowIndexes.length === 0) {
      return;
    }
    setStaged((current) =>
      stageDeleteRows(current, objectRef.current, {
        rows: rowsRef.current,
        columns: columnsRef.current,
        identityColumns: identityRef.current,
        rowIndexes,
      }),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setStaged((current) => removeStagedChange(current, id));
  }, []);

  const discardAll = useCallback(() => {
    setStaged([]);
    setApplyError(null);
    setLastGroup(null);
  }, []);

  const clearFeedback = useCallback(() => {
    setApplyError(null);
    setLastGroup(null);
  }, []);

  const apply = useCallback(async () => {
    const current = stagedRef.current;
    const requests = pendingRequests(current);
    if (requests.length === 0 || isApplying) {
      return;
    }

    setIsApplying(true);
    setApplyError(null);
    setLastGroup(null);
    setStaged((list) =>
      list.map((change) =>
        isApplyable(change) ? { ...change, status: "applying" } : change,
      ),
    );

    try {
      const group = await applyTableChanges(connectionRef.current, requests);
      setLastGroup(group);
      setStaged((list) => {
        const reconciled = reconcileApplyResult(list, group);
        if (group.state === "applied" || group.state === "auto_commit") {
          return removeApplied(reconciled);
        }
        return reconciled;
      });

      const committed =
        group.state === "applied" ||
        group.state === "auto_commit" ||
        (!group.grouped &&
          group.results.some((result) => result.outcome === "applied"));
      if (committed) {
        onAppliedRef.current?.();
      }
    } catch (rawError) {
      setApplyError(toQueryError(rawError));
      setStaged((list) =>
        list.map((change) =>
          change.status === "applying"
            ? { ...change, status: "pending" }
            : change,
        ),
      );
    } finally {
      setIsApplying(false);
    }
  }, [isApplying]);

  return {
    staged,
    summary: summarizeStaged(staged),
    isApplying,
    applyError,
    lastGroup,
    stageEdit,
    insertRow,
    updateInsert,
    deleteRow,
    deleteRows,
    remove,
    discardAll,
    apply,
    clearFeedback,
  };
}
