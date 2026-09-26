import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CopyIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { useWorkspace } from "@/app/store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumn,
  type DataTableSort,
  type RowState,
} from "@/components/data-table";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import type {
  CellValue,
  FilterOperator,
  ObjectRef,
  QueryError,
  Row,
  TableFilter,
} from "@/domain";
import { cellValueToCopyString } from "@/features/results/cellValue";
import { copyTextToClipboard } from "@/features/results/clipboard";
import { reportError } from "@/lib/notify";
import { describeTable } from "@/services/metadata";
import type { ChangeGroupResult } from "@/services/tableData";

import {
  createTableFilter,
  describeFilter,
  FILTER_OPERATORS,
  operatorNeedsValue,
  operatorTakesList,
  sortColumnOf,
  sortDirectionOf,
} from "./filters";
import { PAGE_SIZE_OPTIONS, pageRangeLabel } from "./paging";
import {
  describeStagedChange,
  stagedDeletedRows,
  stagedEditedCells,
  stagedInserts,
  type StagedChangeStatus,
} from "./stagedChanges";
import { useStagedChanges } from "./useStagedChanges";
import { useTableDataController } from "./useTableData";

export interface TableTabViewProps {
  connectionId: string;
  object: ObjectRef;
  /** One-shot filter applied on mount (foreign-key navigation). */
  focusFilter?: TableFilter;
  /** Called once `focusFilter` has been applied. */
  onFocusFilterConsumed?: () => void;
}

/** Sentinel used because Radix Select forbids an empty item value. */
const UNSORTED = "__unsorted__";

const STATUS_LABELS: Record<StagedChangeStatus, string> = {
  pending: "Pending",
  applying: "Applying",
  applied: "Applied",
  failed: "Failed",
  conflict: "Conflict",
  outcome_unknown: "Unknown",
};

interface ForeignKeyRef {
  column: string;
  refTable: string;
  refColumn: string;
}

function statusBadgeVariant(
  status: StagedChangeStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "conflict":
    case "outcome_unknown":
    case "failed":
      return "destructive";
    case "applied":
      return "secondary";
    default:
      return "outline";
  }
}

function qualifiedObjectName(object: ObjectRef): string {
  const parts = [object.database, object.schema, object.name].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.join(".");
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * Resolves the most specific error from a failed apply batch.
 *
 * A grouped failure rolls the transaction back and reports the offending
 * change's own error, which is more useful than the generic batch error.
 */
function applyFailure(group: ChangeGroupResult): {
  message: string;
  detail?: string;
  changeId?: string;
} {
  const failed = group.results.find(
    (result) => result.outcome === "failed" || result.outcome === "outcome_unknown",
  );
  const error = failed?.error ?? group.error;
  return {
    message:
      error?.message ??
      "The database rejected the change and the batch was rolled back.",
    detail: error?.engineDetail,
    changeId: failed?.operationId,
  };
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
    >
      <Spinner className="size-4" />
      Loading rows…
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: QueryError; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <p className="text-sm font-medium text-destructive">Could not load rows</p>
      <p className="max-w-sm text-xs text-muted-foreground">{error.message}</p>
      {error.engineDetail ? (
        <p className="max-w-sm font-mono text-[10px] text-muted-foreground/80">
          {error.engineDetail}
        </p>
      ) : null}
      <p className="text-[10px] tracking-wide uppercase text-muted-foreground">
        {error.category}
      </p>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Editable table browser.
 *
 * The grid is the themed `DataTable`. New rows are added directly in the grid
 * as a blank editable row; row selection (click, ctrl/cmd, shift range), inline
 * edits, and multi-row deletes are staged locally until an explicit apply.
 * Foreign-key cells expose a "go to row" affordance that opens the referenced
 * table filtered to the referenced value. Secondary controls (filters, sort,
 * page size, pending changes) live in a right-hand sheet.
 */
export function TableTabView({
  connectionId,
  object,
  focusFilter,
  onFocusFilterConsumed,
}: TableTabViewProps) {
  const { openTableFiltered, log } = useWorkspace();
  const controller = useTableDataController({ connectionId, object });
  const {
    columns,
    rows,
    page,
    isLoading,
    error,
    filters,
    sort,
    pageSize,
    offset,
    canGoBack,
    canGoNext,
    hasRowIdentity,
  } = controller;

  const rowIdentityColumns = page?.rowIdentity ?? [];
  const canEdit = object.kind === "table" && hasRowIdentity;

  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<FilterOperator>("equal");
  const [filterValue, setFilterValue] = useState("");
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyRef[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const focusAppliedRef = useRef<TableFilter | null>(null);
  const [focusRowPending, setFocusRowPending] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const staged = useStagedChanges({
    connectionId,
    object,
    columns,
    rows,
    rowIdentityColumns,
    canEdit,
    onApplied: controller.refresh,
  });
  const { stageEdit, insertRow, updateInsert, deleteRows, remove, discardAll, apply } =
    staged;
  const stagedRef = useRef(staged.staged);
  stagedRef.current = staged.staged;

  // Load foreign-key metadata so cells can link to the referenced row.
  useEffect(() => {
    let active = true;
    setForeignKeys([]);
    if (object.kind !== "table") {
      return () => {
        active = false;
      };
    }
    void (async () => {
      try {
        const description = await describeTable(connectionId, object);
        if (!active) {
          return;
        }
        const next: ForeignKeyRef[] = [];
        for (const constraint of description.constraints ?? []) {
          const column = constraint.columns?.[0];
          const refColumn = constraint.referencedColumns?.[0];
          if (
            constraint.kind === "foreign_key" &&
            constraint.columns?.length === 1 &&
            constraint.referencedColumns?.length === 1 &&
            column &&
            refColumn &&
            constraint.referencedTable
          ) {
            next.push({
              column,
              refTable: constraint.referencedTable,
              refColumn,
            });
          }
        }
        setForeignKeys(next);
      } catch {
        // Foreign-key metadata is a convenience; browsing works without it.
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId, object.database, object.schema, object.name, object.kind]);

  // Keep the filter column valid as columns arrive for a new object.
  useEffect(() => {
    if (columns.length === 0) {
      setFilterColumn("");
      return;
    }
    if (!columns.some((column) => column.name === filterColumn)) {
      setFilterColumn(columns[0].name);
    }
  }, [columns, filterColumn]);

  // A reloaded window invalidates the rows the selection pointed at.
  useEffect(() => {
    setSelectedRows([]);
  }, [page]);

  // A different object must not inherit transient UI state.
  useEffect(() => {
    setFilterValue("");
    setFilterNotice(null);
    setConfirm(null);
    setSelectedRows([]);
    setFiltersOpen(false);
  }, [connectionId, object.database, object.schema, object.name, object.kind]);

  useEffect(() => {
    if (staged.applyError) {
      toast.error(staged.applyError.message);
      reportError(
        log,
        `Could not apply changes to ${qualifiedObjectName(object)}`,
        staged.applyError,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged.applyError]);

  useEffect(() => {
    const group = staged.lastGroup;
    if (!group) {
      return;
    }
    const target = qualifiedObjectName(object);
    if (group.state === "applied" || group.state === "auto_commit") {
      toast.success("Changes applied.");
      log("success", `Applied changes to ${target}`);
      return;
    }
    if (group.state === "conflict") {
      toast.error("A row changed on the server, so the batch was rolled back.");
      log("warning", `Conflict applying changes to ${target}`);
      return;
    }
    if (group.state === "outcome_unknown") {
      toast.warning(
        "A write outcome could not be confirmed. Do not retry automatically.",
      );
      log("warning", `Outcome unknown applying changes to ${target}`);
      return;
    }
    const failure = applyFailure(group);
    const failedChange = failure.changeId
      ? stagedRef.current.find((change) => change.id === failure.changeId)
      : undefined;
    const description = [
      failedChange ? describeStagedChange(failedChange) : undefined,
      failure.detail,
    ]
      .filter(Boolean)
      .join(": ");
    toast.error(failure.message, description ? { description } : undefined);
    log(
      "error",
      `Could not apply changes to ${target}`,
      failure.detail ? `${failure.message}: ${failure.detail}` : failure.message,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged.lastGroup]);

  // Clear row selection when interacting outside the table so a lingering
  // highlight is never mistaken for an edit.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && sectionRef.current?.contains(node)) {
        return;
      }
      setSelectedRows((current) => (current.length === 0 ? current : []));
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Apply the one-shot FK focus filter exactly once.
  useEffect(() => {
    if (!focusFilter || focusAppliedRef.current === focusFilter) {
      return;
    }
    focusAppliedRef.current = focusFilter;
    controller.addFilter(focusFilter);
    setFocusRowPending(true);
    onFocusFilterConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFilter]);

  // Once the filtered page arrives, select the located row.
  useEffect(() => {
    if (focusRowPending && rows.length > 0) {
      setSelectedRows([0]);
      setFocusRowPending(false);
    }
  }, [focusRowPending, rows]);

  const insertChanges = useMemo(() => stagedInserts(staged.staged), [staged.staged]);

  // Staged inserts are shown as extra editable rows after the loaded page.
  const displayRows = useMemo<Row[]>(() => {
    if (insertChanges.length === 0) {
      return rows;
    }
    const synthetic = insertChanges.map((change) => {
      const row: Row = columns.map(() => ({ type: "null" }));
      if (change.change.kind === "insert") {
        for (const { column, value } of change.change.values) {
          const index = columns.findIndex((candidate) => candidate.name === column);
          if (index >= 0) {
            row[index] = value;
          }
        }
      }
      return row;
    });
    return [...rows, ...synthetic];
  }, [rows, columns, insertChanges]);

  const columnForeignKeys = useMemo(() => {
    const map = new Map<string, { refTable: string; refColumn: string }>();
    for (const fk of foreignKeys) {
      map.set(fk.column, { refTable: fk.refTable, refColumn: fk.refColumn });
    }
    return map;
  }, [foreignKeys]);

  const tableColumns = useMemo<DataTableColumn[]>(
    () =>
      columns.map((column) => ({
        name: column.name,
        typeName: column.typeName,
        primaryKey: rowIdentityColumns.includes(column.name),
        foreignKey: columnForeignKeys.get(column.name) ?? null,
      })),
    [columns, rowIdentityColumns, columnForeignKeys],
  );

  const editedCells = useMemo(() => stagedEditedCells(staged.staged), [staged.staged]);
  const deletedRows = useMemo(() => stagedDeletedRows(staged.staged), [staged.staged]);

  const rowState = useCallback(
    (row: number): RowState | undefined => {
      if (row >= rows.length) {
        return "new";
      }
      if (deletedRows.has(row)) {
        return "deleted";
      }
      if ((editedCells.get(row)?.size ?? 0) > 0) {
        return "edited";
      }
      return undefined;
    },
    [rows.length, deletedRows, editedCells],
  );

  const rowNumberLabel = useCallback(
    (row: number) => (row >= rows.length ? "+" : String(offset + row + 1)),
    [offset, rows.length],
  );

  const cellClassName = useCallback(
    (_col: number, row: number, _value: CellValue) => {
      if (row >= rows.length || deletedRows.has(row)) {
        return undefined;
      }
      const columnName = columns[_col]?.name;
      if (columnName && editedCells.get(row)?.has(columnName)) {
        return "bg-primary/15 shadow-[inset_2px_0_0_var(--primary)]";
      }
      return undefined;
    },
    [columns, rows.length, deletedRows, editedCells],
  );

  const handleCellEdit = useCallback(
    (col: number, row: number, value: CellValue) => {
      if (row >= rows.length) {
        const change = insertChanges[row - rows.length];
        const column = columns[col];
        if (!change || !column) {
          return;
        }
        updateInsert(change.id, column.name, value);
        return;
      }
      stageEdit(row, col, value);
    },
    [rows.length, insertChanges, columns, updateInsert, stageEdit],
  );

  const handleForeignKeyActivated = useCallback(
    (col: number, row: number) => {
      const columnName = columns[col]?.name;
      const fk = columnName ? columnForeignKeys.get(columnName) : undefined;
      const value = displayRows[row]?.[col];
      if (!fk || !value || value.type === "null") {
        return;
      }
      const target: ObjectRef = {
        kind: "table",
        name: fk.refTable,
        schema: object.schema,
        database: object.database,
      };
      openTableFiltered(target, {
        column: fk.refColumn,
        operator: "equal",
        values: [value],
      });
    },
    [columns, displayRows, columnForeignKeys, object.schema, object.database, openTableFiltered],
  );

  const tableSort: DataTableSort = {
    column: sortColumnOf(sort) ?? null,
    direction: sortDirectionOf(sort),
  };

  const handleSortChange = useCallback(
    (column: string | null, direction: "ascending" | "descending") => {
      if (column === null) {
        controller.clearSort();
        return;
      }
      controller.applySort(column, direction);
    },
    [controller],
  );

  const handleAddFilter = useCallback(() => {
    const column = columns.find((candidate) => candidate.name === filterColumn);
    if (!column) {
      setFilterNotice("Choose a column to filter on.");
      return;
    }
    const filter = createTableFilter(column, filterOperator, filterValue);
    if (filter === null) {
      setFilterNotice("Enter a value for the selected filter.");
      return;
    }
    controller.addFilter(filter);
    setFilterValue("");
    setFilterNotice(null);
  }, [columns, controller, filterColumn, filterOperator, filterValue]);

  const handleDeleteSelected = useCallback(() => {
    if (!canEdit || selectedRows.length === 0) {
      return;
    }
    const loadedRows = selectedRows.filter((row) => row < rows.length);
    const newRows = selectedRows
      .filter((row) => row >= rows.length)
      .map((row) => insertChanges[row - rows.length])
      .filter((change): change is NonNullable<typeof change> => Boolean(change));
    const count = loadedRows.length + newRows.length;
    if (count === 0) {
      return;
    }
    setConfirm({
      title: newRows.length > 0 && loadedRows.length === 0 ? "Remove new row(s)" : "Delete selected rows",
      description: `Stage deletes for ${count} selected row(s) in ${qualifiedObjectName(object)}? They are removed only after you apply the staged changes.`,
      confirmLabel: newRows.length > 0 && loadedRows.length === 0 ? "Remove" : "Stage deletes",
      onConfirm: () => {
        if (loadedRows.length > 0) {
          deleteRows(loadedRows);
        }
        for (const change of newRows) {
          remove(change.id);
        }
      },
    });
  }, [canEdit, deleteRows, insertChanges, object, remove, rows.length, selectedRows]);

  const handleApply = useCallback(() => {
    if (staged.summary.hasDeletes) {
      setConfirm({
        title: "Apply changes",
        description: `Apply ${staged.summary.applyable} change(s), including deletes, to ${qualifiedObjectName(object)}? This cannot be undone after the database confirms it.`,
        confirmLabel: "Apply changes",
        onConfirm: () => {
          void apply();
        },
      });
      return;
    }
    void apply();
  }, [apply, object, staged.summary.applyable, staged.summary.hasDeletes]);

  const handleDiscard = useCallback(() => {
    if (staged.staged.length === 0) {
      return;
    }
    const count = staged.staged.length;
    setConfirm({
      title: "Discard staged changes",
      description: `Discard ${count} staged change(s)? Nothing has been written to the database.`,
      confirmLabel: "Discard changes",
      onConfirm: () => discardAll(),
    });
  }, [discardAll, staged.staged.length]);

  const handleCopySelection = useCallback(async () => {
    if (selectedRows.length === 0) {
      return;
    }
    const header = columns.map((column) => column.name).join(",");
    const body = selectedRows
      .map((row) =>
        columns
          .map((_, col) => {
            const value = displayRows[row]?.[col] ?? { type: "null" as const };
            return JSON.stringify(cellValueToCopyString(value));
          })
          .join(","),
      )
      .join("\n");
    try {
      await copyTextToClipboard([header, body].join("\n"));
      toast.success(`Copied ${selectedRows.length} row(s)`);
    } catch {
      toast.error("Could not copy to the clipboard.");
    }
  }, [columns, displayRows, selectedRows]);

  const rangeLabel = pageRangeLabel(offset, rows.length, page?.totalRows);
  const totalPages = page?.totalRows
    ? Math.max(1, Math.ceil(page.totalRows / pageSize))
    : null;
  const currentPage = Math.floor(offset / pageSize) + 1;
  const dirtyCount = staged.summary.applyable;
  const applyDisabled =
    !canEdit || staged.isApplying || staged.summary.applyable === 0 || staged.summary.hasBlocking;
  const activeFilterCount = filters.length;

  const toolbarIcon = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    disabled = false,
    extra?: string,
  ) => (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={extra}
    >
      {icon}
    </Button>
  );

  return (
    <section
      ref={sectionRef}
      aria-label="Table data"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      {object.kind === "view" ? (
        <p
          data-testid="table-data-view"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
        >
          Views are read-only; rows cannot be inserted, updated, or deleted.
        </p>
      ) : page && object.kind === "table" && !hasRowIdentity ? (
        <p
          data-testid="table-data-no-identity"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
        >
          No primary key or safe row identifier was found, so rows cannot be
          targeted for editing. Browsing and selecting are still available.
        </p>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={controller.refresh} />
        ) : page === null ? (
          <LoadingState />
        ) : displayRows.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyTitle>No rows</EmptyTitle>
              <EmptyDescription>
                {filters.length > 0
                  ? "No rows match the active filters."
                  : canEdit
                    ? "This table has no rows. Insert one to get started."
                    : "This object has no rows."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DataTable
            ariaLabel={`Table data for ${qualifiedObjectName(object)}`}
            columns={tableColumns}
            rows={displayRows}
            editable={canEdit}
            selectedRows={selectedRows}
            onSelectedRowsChange={setSelectedRows}
            onCellEdit={canEdit ? handleCellEdit : undefined}
            onForeignKeyActivated={handleForeignKeyActivated}
            sort={tableSort}
            onSortChange={handleSortChange}
            rowState={rowState}
            cellClassName={cellClassName}
            rowNumberLabel={rowNumberLabel}
          />
        )}

        {isLoading && page !== null ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
            <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-popover px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm">
              <Spinner className="size-3" />
              Loading
            </span>
          </div>
        ) : null}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-1 border-t border-border bg-muted px-2 text-xs select-none">
        {toolbarIcon(
          <RefreshCwIcon className={isLoading ? "animate-spin" : undefined} />,
          "Refresh",
          controller.refresh,
          isLoading,
        )}
        {canEdit
          ? toolbarIcon(
              <PlusIcon />,
              "Insert row",
              () => insertRow([]),
              isLoading || columns.length === 0,
            )
          : null}
        {canEdit
          ? toolbarIcon(
              <CheckIcon />,
              "Apply changes",
              handleApply,
              applyDisabled,
              dirtyCount > 0 ? "text-primary" : undefined,
            )
          : null}
        <Button
          variant="destructive"
          size="icon-sm"
          title="Delete selected rows"
          aria-label="Delete selected rows"
          onClick={handleDeleteSelected}
          disabled={!canEdit || selectedRows.length === 0 || isLoading}
        >
          <TrashIcon />
        </Button>
        {canEdit
          ? toolbarIcon(
              <Undo2Icon />,
              "Discard staged changes",
              handleDiscard,
              staged.staged.length === 0 || staged.isApplying,
            )
          : null}

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        {toolbarIcon(
          <CopyIcon />,
          "Copy selected rows as CSV",
          () => void handleCopySelection(),
          selectedRows.length === 0,
        )}

        {selectedRows.length > 0 ? (
          <span className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-[11px] font-medium text-accent-foreground">
            {selectedRows.length} selected
          </span>
        ) : null}
        {insertChanges.length > 0 ? (
          <span className="inline-flex h-5 items-center gap-1 rounded-full bg-emerald-500/15 px-2 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            {insertChanges.length} new
          </span>
        ) : null}
        {dirtyCount > 0 ? (
          <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary/15 px-2 text-[11px] font-medium text-accent-foreground">
            <CheckIcon className="size-3" />
            {dirtyCount} unsaved
          </span>
        ) : null}
        {deletedRows.size > 0 ? (
          <span className="inline-flex h-5 items-center rounded-full bg-destructive/15 px-2 text-[11px] font-medium text-destructive">
            {deletedRows.size} to delete
          </span>
        ) : null}

        <div className="flex-1" />

        <Button
          variant={filtersOpen ? "secondary" : "ghost"}
          size="icon-sm"
          title="Filters and options"
          aria-label="Filters and options"
          onClick={() => setFiltersOpen((open) => !open)}
          className="relative"
        >
          <SlidersHorizontalIcon />
          {activeFilterCount > 0 ? (
            <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        {toolbarIcon(
          <ChevronsLeftIcon />,
          "First page",
          controller.goFirst,
          !canGoBack || isLoading,
        )}
        {toolbarIcon(
          <ChevronLeftIcon />,
          "Previous page",
          controller.goBack,
          !canGoBack || isLoading,
        )}
        <span
          data-testid="table-data-page"
          className="px-1.5 text-[11px] text-muted-foreground tabular-nums"
        >
          Page <strong className="text-foreground">{currentPage}</strong>
          {totalPages ? ` / ${totalPages}` : ""}
        </span>
        {toolbarIcon(
          <ChevronRightIcon />,
          "Next page",
          controller.goNext,
          !canGoNext || isLoading,
        )}
        {toolbarIcon(
          <ChevronsRightIcon />,
          "Last page",
          controller.goLast,
          totalPages === null || !canGoNext || isLoading,
        )}
        <span
          data-testid="table-data-range"
          role="status"
          className="px-1.5 text-[11px] text-muted-foreground tabular-nums"
        >
          {rangeLabel}
        </span>
      </footer>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="right" className="flex w-80 flex-col gap-0 p-0">
          <SheetHeader className="border-b border-border px-4 py-3">
            <SheetTitle className="text-sm">Table options</SheetTitle>
            <SheetDescription className="text-[11px]">
              Filter, sort, and page {qualifiedObjectName(object)}.
            </SheetDescription>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 p-4">
              <section className="flex flex-col gap-2">
                <Label className="text-[10px] tracking-wide uppercase">Page size</Label>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => controller.setPageSize(Number(value))}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Page size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size} rows
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </section>

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] tracking-wide uppercase">Sort</Label>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => handleSortChange(null, "ascending")}
                    disabled={tableSort.column === null}
                  >
                    Clear
                  </Button>
                </div>
                <Select
                  value={tableSort.column ?? UNSORTED}
                  onValueChange={(value) =>
                    handleSortChange(
                      value === UNSORTED ? null : value,
                      tableSort.direction,
                    )
                  }
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Sort column">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNSORTED}>Unsorted</SelectItem>
                    {columns.map((column) => (
                      <SelectItem key={column.name} value={column.name}>
                        {column.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={tableSort.direction}
                  onValueChange={(value) =>
                    handleSortChange(
                      tableSort.column,
                      value as "ascending" | "descending",
                    )
                  }
                  disabled={tableSort.column === null}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Sort direction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ascending">Ascending</SelectItem>
                    <SelectItem value="descending">Descending</SelectItem>
                  </SelectContent>
                </Select>
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] tracking-wide uppercase">Filters</Label>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      controller.clearFilters();
                      controller.clearSort();
                    }}
                    disabled={filters.length === 0 && tableSort.column === null}
                  >
                    Reset
                  </Button>
                </div>
                {filters.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {filters.map((filter, index) => (
                      <div
                        key={`${filter.column}-${filter.operator}-${index}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px]"
                      >
                        <span className="truncate">{describeFilter(filter)}</span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Remove filter ${index + 1}`}
                          onClick={() => controller.removeFilter(index)}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No filters applied.</p>
                )}

                <Separator className="my-1" />

                <Select
                  value={filterColumn}
                  onValueChange={(value) => {
                    setFilterColumn(value);
                    setFilterNotice(null);
                  }}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Filter column">
                    <SelectValue placeholder="Column" />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((column) => (
                      <SelectItem key={column.name} value={column.name}>
                        {column.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filterOperator}
                  onValueChange={(value) => setFilterOperator(value as FilterOperator)}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Filter operator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_OPERATORS.map((option) => (
                      <SelectItem key={option.operator} value={option.operator}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {operatorNeedsValue(filterOperator) ? (
                  <Input
                    aria-label="Filter value"
                    value={filterValue}
                    spellCheck={false}
                    placeholder={operatorTakesList(filterOperator) ? "a, b, c" : "value"}
                    onChange={(event) => {
                      setFilterValue(event.target.value);
                      setFilterNotice(null);
                    }}
                    className="h-8 text-xs"
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddFilter}
                  disabled={columns.length === 0}
                >
                  Add filter
                </Button>
                {filterNotice ? (
                  <p role="alert" className="text-[11px] text-destructive">
                    {filterNotice}
                  </p>
                ) : null}
              </section>

              {staged.staged.length > 0 || staged.applyError || staged.lastGroup ? (
                <>
                  <Separator />
                  <section
                    data-testid="pending-changes"
                    className="flex flex-col gap-2"
                  >
                    <Label className="text-[10px] tracking-wide uppercase">
                      Pending changes
                    </Label>
                    {staged.applyError ? (
                      <p data-testid="apply-error" role="alert" className="text-[11px] text-destructive">
                        {staged.applyError.message}
                      </p>
                    ) : null}
                    {staged.staged.map((change) => (
                      <div
                        key={change.id}
                        data-testid={`staged-change-${change.id}`}
                        className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-[11px]"
                      >
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={statusBadgeVariant(change.status)}
                            className="text-[9px] tracking-wide uppercase"
                          >
                            {STATUS_LABELS[change.status]}
                          </Badge>
                          <span className="flex-1">{describeStagedChange(change)}</span>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Remove staged change ${change.id}`}
                            onClick={() => remove(change.id)}
                          >
                            <XIcon />
                          </Button>
                        </div>
                        {change.conflictedColumns.length > 0 ? (
                          <span className="text-destructive">
                            changed on server: {change.conflictedColumns.join(", ")}
                          </span>
                        ) : null}
                        {change.error ? (
                          <span className="text-destructive">
                            {change.error.message}
                            {change.error.engineDetail ? (
                              <span className="mt-0.5 block font-mono text-[10px] break-words opacity-80">
                                {change.error.engineDetail}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    ))}
                    {staged.lastGroup ? (
                      <p
                        data-testid="apply-feedback"
                        role="status"
                        className="text-[11px] text-muted-foreground"
                      >
                        {staged.lastGroup.state === "applied"
                          ? "Changes applied and committed."
                          : staged.lastGroup.state === "auto_commit"
                            ? "Changes applied (this engine has no transaction grouping)."
                            : staged.lastGroup.state === "conflict"
                              ? "A change conflicted; the batch was rolled back."
                              : staged.lastGroup.state === "failed"
                                ? "A change failed; the batch was rolled back."
                                : "A write outcome could not be confirmed. Do not retry automatically."}
                        {staged.lastGroup.transaction
                          ? ` (transaction ${staged.lastGroup.transaction})`
                          : ""}
                      </p>
                    ) : null}
                    {staged.summary.conflict > 0 || staged.summary.outcomeUnknown > 0 ? (
                      <Button
                        size="xs"
                        variant="outline"
                        data-testid="reload-rows"
                        onClick={controller.refresh}
                        disabled={isLoading}
                      >
                        Reload rows
                      </Button>
                    ) : null}
                  </section>
                </>
              ) : null}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title ?? ""}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description ?? ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              onClick={() => {
                confirm?.onConfirm();
              }}
            >
              {confirm?.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
