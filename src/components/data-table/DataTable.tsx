import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  Link2Icon,
} from "lucide-react";

import type { CellValue } from "@/domain";
import { cn } from "@/lib/utils";
import { cellValuesEqual } from "@/features/table-data/stagedChanges";

import {
  cellEditText,
  columnWidthFor,
  formatCellValue,
  parseCellEdit,
  parseColumnEdit,
  type DataTableColumn,
} from "./format";

/** Visual state of a row relative to its saved value. */
export type RowState = "new" | "edited" | "deleted";

/** Column the table is ordered by, and the direction. */
export interface DataTableSort {
  column: string | null;
  direction: "ascending" | "descending";
}

export interface DataTableProps {
  /** Column metadata, rendered as the sticky header. */
  columns: DataTableColumn[];
  /** Row data; each row has one cell per column. */
  rows: CellValue[][];
  /** Whether cells can be edited inline on double-click. */
  editable?: boolean;
  /** Selected page row indexes (controlled). */
  selectedRows?: number[];
  /** Called when row selection changes (click, ctrl/cmd, shift). */
  onSelectedRowsChange?: (rows: number[]) => void;
  /** Called with the parsed value when an inline edit is committed. */
  onCellEdit?: (col: number, row: number, value: CellValue) => void;
  /** Called when a read-only cell is activated (double-click). */
  onCellActivated?: (col: number, row: number) => void;
  /** Called when a cell is clicked, before row selection updates. */
  onCellClick?: (col: number, row: number) => void;
  /** Called when a foreign-key cell's "go to row" affordance is clicked. */
  onForeignKeyActivated?: (col: number, row: number) => void;
  /** The focused cell, highlighted independently of row selection. */
  activeCell?: { col: number; row: number } | null;
  /** Visual state of a row (staged new/edited/deleted). */
  rowState?: (row: number) => RowState | undefined;
  /** Current ordering; enables sortable headers when `onSortChange` is set. */
  sort?: DataTableSort;
  /** Called when a header cycles its sort direction. `null` clears the sort. */
  onSortChange?: (
    column: string | null,
    direction: "ascending" | "descending",
  ) => void;
  /** Extra classes for a cell (for example, a staged-edit tint). */
  cellClassName?: (col: number, row: number, value: CellValue) => string | undefined;
  /** Extra classes for a row (for example, a staged-delete tint). */
  rowClassName?: (row: number) => string | undefined;
  /** Label for a row's gutter cell; defaults to the 1-based row number. */
  rowNumberLabel?: (row: number) => string;
  /** First row number to display, so paging shows absolute positions. */
  startRowNumber?: number;
  /** Shown in place of the table when there are no rows. */
  emptyMessage?: string;
  /** Accessible name for the table region. */
  ariaLabel?: string;
  className?: string;
}

const ROWNUM_WIDTH = 46;
const MIN_COLUMN_WIDTH = 56;

/**
 * Themed, dependency-free data table.
 *
 * Renders a sticky-header HTML table that follows the app's design tokens with
 * hover and selection highlighting, inline cell editing, header-driven sorting,
 * and draggable column widths. It is a pure presentation layer: it derives
 * everything from `columns`/`rows` and reports selection, edits, and sort
 * changes back to the caller. Nothing here knows about databases or SQL.
 */
export function DataTable({
  columns,
  rows,
  editable = false,
  selectedRows,
  onSelectedRowsChange,
  onCellEdit,
  onCellActivated,
  onCellClick,
  onForeignKeyActivated,
  activeCell,
  rowState,
  sort,
  onSortChange,
  cellClassName,
  rowClassName,
  rowNumberLabel,
  startRowNumber = 1,
  emptyMessage = "No rows.",
  ariaLabel = "Data table",
  className,
}: DataTableProps) {
  const signature = columns.map((c) => `${c.name}:${c.typeName ?? ""}`).join("|");
  const [widths, setWidths] = useState<number[]>(() =>
    columns.map(columnWidthFor),
  );

  // Recompute starting widths only when the column shape actually changes, so
  // a resize is not thrown away by an unrelated re-render.
  useEffect(() => {
    setWidths(columns.map(columnWidthFor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const anchorRef = useRef<number | null>(null);
  const resizeRef = useRef<{
    index: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const active = resizeRef.current;
      if (!active) {
        return;
      }
      const next = Math.max(
        MIN_COLUMN_WIDTH,
        active.startWidth + (event.clientX - active.startX),
      );
      setWidths((current) =>
        current.map((width, index) => (index === active.index ? next : width)),
      );
    };
    const onUp = () => {
      if (!resizeRef.current) {
        return;
      }
      resizeRef.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const beginResize = useCallback(
    (index: number, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      resizeRef.current = {
        index,
        startX: event.clientX,
        startWidth: widths[index] ?? MIN_COLUMN_WIDTH,
      };
      document.body.style.cursor = "col-resize";
    },
    [widths],
  );

  const selectedSet = useMemo(
    () => new Set(selectedRows ?? []),
    [selectedRows],
  );

  const handleRowClick = useCallback(
    (row: number, event: React.MouseEvent) => {
      if (!onSelectedRowsChange) {
        return;
      }
      const current = selectedRows ?? [];
      if (event.shiftKey && anchorRef.current !== null) {
        const [from, to] = [anchorRef.current, row].sort((a, b) => a - b);
        const range: number[] = [];
        for (let index = from; index <= to; index += 1) {
          range.push(index);
        }
        onSelectedRowsChange(
          [...new Set([...current, ...range])].sort((a, b) => a - b),
        );
      } else if (event.metaKey || event.ctrlKey) {
        const next = current.includes(row)
          ? current.filter((candidate) => candidate !== row)
          : [...current, row].sort((a, b) => a - b);
        onSelectedRowsChange(next);
        anchorRef.current = row;
      } else {
        onSelectedRowsChange([row]);
        anchorRef.current = row;
      }
    },
    [onSelectedRowsChange, selectedRows],
  );

  const [editing, setEditing] = useState<{ col: number; row: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const skipCommitRef = useRef(false);

  // A new page/result invalidates the row an open editor pointed at.
  useEffect(() => {
    setEditing(null);
  }, [rows]);

  const startEdit = useCallback(
    (col: number, row: number, value: CellValue) => {
      setEditing({ col, row });
      setDraft(cellEditText(value));
      skipCommitRef.current = false;
    },
    [],
  );

  const commitEdit = useCallback(() => {
    if (!editing) {
      return;
    }
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      setEditing(null);
      return;
    }
    const previous = rows[editing.row]?.[editing.col] ?? { type: "null" };
    const column = columns[editing.col];
    const result =
      previous.type === "null" && column
        ? parseColumnEdit(draft, {
            name: column.name,
            typeName: column.typeName,
            nullable: true,
          })
        : parseCellEdit(draft, previous);
    if (result.ok && !cellValuesEqual(result.value, previous)) {
      onCellEdit?.(editing.col, editing.row, result.value);
    }
    setEditing(null);
  }, [columns, draft, editing, onCellEdit, rows]);

  const handleSort = useCallback(
    (name: string) => {
      if (!onSortChange) {
        return;
      }
      if (sort?.column !== name) {
        onSortChange(name, "ascending");
      } else if (sort.direction === "ascending") {
        onSortChange(name, "descending");
      } else {
        onSortChange(null, "ascending");
      }
    },
    [onSortChange, sort?.column, sort?.direction],
  );

  const totalWidth =
    ROWNUM_WIDTH + widths.reduce((sum, width) => sum + width, 0);

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={cn("app-scroll relative min-h-0 flex-1 overflow-auto", className)}
    >
      <table
        className="border-separate border-spacing-0 text-xs"
        style={{ width: "100%", minWidth: totalWidth, tableLayout: "fixed" }}
      >
        <colgroup>
          <col style={{ width: ROWNUM_WIDTH }} />
          {widths.map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
          {/* Filler absorbs the leftover width so resizing one column never
              shifts the others. */}
          <col />
        </colgroup>

        <thead>
          <tr>
            <th
              scope="col"
              className="sticky top-0 left-0 z-30 h-[30px] border-r border-b border-border bg-muted px-2 text-center text-[10px] font-semibold text-muted-foreground"
            >
              #
            </th>
            {columns.map((column, index) => {
              const isSorted = sort?.column === column.name;
              const SortIcon = !isSorted
                ? ChevronsUpDownIcon
                : sort?.direction === "ascending"
                  ? ChevronUpIcon
                  : ChevronDownIcon;
              return (
                <th
                  key={`${column.name}-${index}`}
                  scope="col"
                  className="group/th sticky top-0 z-20 h-[30px] border-r border-b border-border bg-muted px-2.5 text-left font-semibold text-[11px] text-muted-foreground select-none"
                >
                  <div className="flex items-center gap-1.5 overflow-hidden">
                    {column.primaryKey ? (
                      <KeyRoundIcon
                        className="size-3 shrink-0 text-primary"
                        aria-label="Primary key"
                      />
                    ) : null}
                    {column.foreignKey ? (
                      <Link2Icon
                        className="size-3 shrink-0 text-muted-foreground/70"
                        aria-label={`References ${column.foreignKey.refTable}.${column.foreignKey.refColumn}`}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => handleSort(column.name)}
                      disabled={!onSortChange}
                      title={`${column.name}${column.typeName ? ` · ${column.typeName}` : ""}${column.primaryKey ? " · PRIMARY KEY" : ""}${column.foreignKey ? ` · -> ${column.foreignKey.refTable}.${column.foreignKey.refColumn}` : ""}`}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-1 text-left",
                        onSortChange && "cursor-pointer hover:text-foreground",
                      )}
                    >
                      <span className="truncate font-mono text-[11px]">
                        {column.name}
                      </span>
                      {column.typeName ? (
                        <span className="ml-auto truncate text-[9.5px] font-normal text-muted-foreground/70 lowercase">
                          {column.typeName}
                        </span>
                      ) : null}
                      {onSortChange ? (
                        <SortIcon
                          className={cn(
                            "size-3 shrink-0",
                            isSorted ? "text-primary opacity-100" : "opacity-0 group-hover/th:opacity-50",
                          )}
                        />
                      ) : null}
                    </button>
                  </div>
                  {/* Drag handle for resizing the column. */}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    onMouseDown={(event) => beginResize(index, event)}
                    className="absolute top-0 -right-px h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/60"
                  />
                </th>
              );
            })}
            <th
              scope="col"
              aria-hidden="true"
              className="sticky top-0 z-20 h-[30px] border-b border-border bg-muted"
            />
          </tr>
        </thead>

        <tbody>
          {rows.map((row, rowIndex) => {
            const selected = selectedSet.has(rowIndex);
            const extraRowClass = rowClassName?.(rowIndex);
            const state = rowState?.(rowIndex);
            const label = rowNumberLabel
              ? rowNumberLabel(rowIndex)
              : String(startRowNumber + rowIndex);
            const accent =
              state === "deleted"
                ? "var(--destructive)"
                : state === "new"
                  ? "oklch(0.72 0.17 145)"
                  : state === "edited"
                    ? "var(--primary)"
                    : undefined;
            const stateBg =
              state === "deleted"
                ? "bg-destructive/10"
                : state === "new"
                  ? "bg-emerald-500/10"
                  : state === "edited"
                    ? "bg-primary/[0.06]"
                    : undefined;
            return (
              <tr
                key={rowIndex}
                data-selected={selected}
                data-state={state}
                onClick={(event) => handleRowClick(rowIndex, event)}
                className={cn(
                  "transition-colors",
                  selected
                    ? "bg-secondary hover:bg-secondary/80"
                    : cn(stateBg, "hover:bg-accent/45"),
                  onSelectedRowsChange && "cursor-default",
                  extraRowClass,
                )}
              >
                <td
                  className={cn(
                    "sticky left-0 z-10 h-[29px] border-r border-b border-border px-2 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground select-none",
                    selected
                      ? "bg-secondary font-semibold text-foreground"
                      : "bg-muted",
                  )}
                  style={{
                    boxShadow: accent ? `inset 3px 0 0 ${accent}` : undefined,
                  }}
                >
                  {label}
                </td>
                {columns.map((column, colIndex) => {
                  const value = row[colIndex] ?? { type: "null" as const };
                  const isEditing =
                    editing?.col === colIndex && editing?.row === rowIndex;
                  return (
                    <td
                      key={`${column.name}-${colIndex}`}
                      className={cn(
                        "h-[29px] overflow-hidden border-r border-b border-border/60 px-2.5 align-middle text-ellipsis whitespace-nowrap",
                        activeCell?.col === colIndex && activeCell?.row === rowIndex &&
                          "ring-1 ring-ring ring-inset",
                        cellClassName?.(colIndex, rowIndex, value),
                      )}
                      onClick={() => onCellClick?.(colIndex, rowIndex)}
                      onDoubleClick={() => {
                        if (editable) {
                          startEdit(colIndex, rowIndex, value);
                        } else {
                          onCellActivated?.(colIndex, rowIndex);
                        }
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          aria-label={`Edit ${column.name}`}
                          value={draft}
                          spellCheck={false}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitEdit();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              skipCommitRef.current = true;
                              commitEdit();
                            }
                          }}
                          className="h-[22px] w-full rounded-sm border border-ring bg-background px-1.5 font-mono text-[11px] outline-none ring-2 ring-ring/20"
                        />
                      ) : column.foreignKey &&
                        value.type !== "null" &&
                        onForeignKeyActivated ? (
                        <span className="group/fk flex items-center gap-1">
                          <span className="min-w-0 flex-1 truncate">
                            <CellContent value={value} column={column} blank={state === "new"} />
                          </span>
                          <button
                            type="button"
                            aria-label={`Go to ${column.foreignKey.refTable}.${column.foreignKey.refColumn}`}
                            title={`Go to ${column.foreignKey.refTable}.${column.foreignKey.refColumn}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onForeignKeyActivated(colIndex, rowIndex);
                            }}
                            className="grid size-4 shrink-0 place-items-center rounded text-primary opacity-0 transition-opacity group-hover/fk:opacity-100 focus-visible:opacity-100"
                          >
                            <ArrowRightIcon className="size-3" />
                          </button>
                        </span>
                      ) : (
                        <CellContent value={value} column={column} blank={state === "new"} />
                      )}
                    </td>
                  );
                })}
                <td aria-hidden="true" className="h-[29px] border-b border-border/60" />
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + 2}
                className="border-b border-border px-3 py-10 text-center text-xs text-muted-foreground"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function isNumericType(typeName?: string): boolean {
  if (!typeName) {
    return false;
  }
  const type = typeName.toLowerCase();
  return (
    type.includes("int") ||
    type.includes("serial") ||
    type.includes("real") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("money")
  );
}

function CellContent({
  value,
  column,
  blank = false,
}: {
  value: CellValue;
  column: DataTableColumn;
  blank?: boolean;
}) {
  if (value.type === "null") {
    if (blank) {
      return <span className="text-[11.5px] text-transparent select-none">·</span>;
    }
    return (
      <span className="text-[11.5px] text-muted-foreground/70 italic">NULL</span>
    );
  }
  if (value.type === "boolean") {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px]">
        <span
          className={cn(
            "size-1.5 rounded-full",
            value.value ? "bg-emerald-500" : "bg-muted-foreground",
          )}
        />
        {value.value ? "true" : "false"}
      </span>
    );
  }
  if (value.type === "integer" || value.type === "float" || value.type === "decimal") {
    return (
      <span className="block text-right font-mono text-[11.5px] tabular-nums">
        {formatCellValue(value)}
      </span>
    );
  }
  if (isNumericType(column.typeName) && value.type === "text") {
    return (
      <span className="block text-right font-mono text-[11.5px] tabular-nums">
        {value.value}
      </span>
    );
  }
  if (value.type === "bytes") {
    return <span className="font-mono text-[11.5px]">{formatCellValue(value)}</span>;
  }
  return <span className="text-[12.5px]">{value.value}</span>;
}
