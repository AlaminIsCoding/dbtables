import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createOperationId,
  type ColumnDefinition,
  type ConstraintInfo,
  type ForeignKeyDefinition,
  type ObjectRef,
  type QueryError,
  type TableDescription,
} from "@/domain";
import { toQueryError } from "@/services/errors";
import { describeTable } from "@/services/metadata";
import {
  addColumn,
  addForeignKey,
  dropColumn,
  dropForeignKey,
  renameColumn,
} from "@/services/schema";
import { reportError } from "@/lib/notify";
import { cn } from "@/lib/utils";

import {
  pendingChangesToSql,
  pendingColumnNames,
  validateNewColumn,
  validateRename,
  type PendingColumnChange,
} from "./columnEdits";
import { ErrorBanner, SqlPreview } from "./parts";
import { NONE, TYPE_OPTIONS } from "./typeOptions";

export interface DefinitionTabViewProps {
  connectionId: string;
  object: ObjectRef;
}

type AddChange = Extract<PendingColumnChange, { kind: "add" }>;

/** Grid shared by the column header and its rows. */
const COLUMN_GRID =
  "grid grid-cols-[minmax(9rem,1.3fr)_minmax(8rem,1.1fr)_56px_52px_minmax(8rem,1fr)_72px] items-center gap-2";

/** Grid shared by the foreign-key header and its rows. */
const FK_GRID =
  "grid grid-cols-[minmax(9rem,1.2fr)_minmax(7rem,1fr)_minmax(9rem,1.3fr)_36px] items-center gap-2";

function fieldLabel(text: string) {
  return (
    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
      {text}
    </span>
  );
}

function inputClass(extra?: string): string {
  return cn(
    "h-7 rounded-sm px-1.5 font-mono text-[11px] focus-visible:ring-1",
    extra,
  );
}

interface RefTableInfo {
  columns: string[];
  primaryKey: string | null;
}

/**
 * Table/view definition editor.
 *
 * A flat, borderless form matching the new-table page. Columns are edited by
 * staging local add/rename/drop changes, previewing the exact `ALTER TABLE`
 * statements, then applying them in order. SQLite cannot change an existing
 * column's type, nullability, or default, so those cells are shown read-only
 * rather than pretending to be editable. Foreign-key fields are chosen from the
 * live schema.
 */
export function DefinitionTabView({
  connectionId,
  object,
}: DefinitionTabViewProps) {
  const { refreshSchema, schema, log } = useWorkspace();
  const canEdit = object.kind === "table";

  const [description, setDescription] = useState<TableDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<QueryError | null>(null);
  const [pending, setPending] = useState<PendingColumnChange[]>([]);
  const [isApplying, setIsApplying] = useState(false);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("TEXT");
  const [newNullable, setNewNullable] = useState(true);
  const [newPrimary, setNewPrimary] = useState(false);
  const [newDefault, setNewDefault] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [fkName, setFkName] = useState("");
  const [fkColumn, setFkColumn] = useState("");
  const [fkRefTable, setFkRefTable] = useState("");
  const [fkRefColumn, setFkRefColumn] = useState("");
  const [fkRefSchema, setFkRefSchema] = useState("");
  const [fkNotice, setFkNotice] = useState<string | null>(null);
  const [fkBusy, setFkBusy] = useState(false);
  const [refTables, setRefTables] = useState<Record<string, RefTableInfo>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setDescription(await describeTable(connectionId, object));
    } catch (error) {
      setLoadError(toQueryError(error));
    } finally {
      setLoading(false);
    }
  }, [
    connectionId,
    object.name,
    object.database,
    object.schema,
    object.kind,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPending([]);
    setRenaming(null);
    setDropTarget(null);
    setAddError(null);
    setFkNotice(null);
  }, [connectionId, object.name, object.database, object.schema, object.kind]);

  const columns = useMemo(() => description?.columns ?? [], [description]);
  const primaryKeyColumns = useMemo(
    () => description?.primaryKeyColumns ?? [],
    [description],
  );
  const effectiveNames = useMemo(
    () => pendingColumnNames(columns, pending),
    [columns, pending],
  );
  const pendingSql = useMemo(
    () => pendingChangesToSql(object, pending),
    [object, pending],
  );

  const pendingAdds = useMemo(
    () =>
      pending.filter((change): change is AddChange => change.kind === "add"),
    [pending],
  );

  const foreignKeys = useMemo<ConstraintInfo[]>(
    () =>
      (description?.constraints ?? []).filter(
        (constraint) => constraint.kind === "foreign_key",
      ),
    [description],
  );

  const tableOptions = useMemo(
    () => (schema.status === "ready" ? schema.tables : []),
    [schema],
  );

  const loadRefTable = useCallback(
    async (table: string): Promise<RefTableInfo | null> => {
      if (!table) {
        return null;
      }
      try {
        const info = await describeTable(connectionId, {
          kind: "table",
          name: table,
        });
        const next: RefTableInfo = {
          columns: info.columns.map((column) => column.name),
          primaryKey: info.primaryKeyColumns?.[0] ?? null,
        };
        setRefTables((current) => ({ ...current, [table]: next }));
        return next;
      } catch {
        const next: RefTableInfo = { columns: [], primaryKey: null };
        setRefTables((current) => ({ ...current, [table]: next }));
        return next;
      }
    },
    [connectionId],
  );

  const discardChange = useCallback((id: string) => {
    setPending((current) => current.filter((change) => change.id !== id));
  }, []);

  const handleAddColumn = useCallback(() => {
    const message = validateNewColumn(newName, newType, effectiveNames);
    if (message) {
      setAddError(message);
      return;
    }
    const column: ColumnDefinition = {
      name: newName.trim(),
      typeName: newType.trim(),
      nullable: newNullable,
      primaryKey: newPrimary,
    };
    const fallback = newDefault.trim();
    if (fallback.length > 0) {
      column.default = fallback;
    }
    setPending((current) => [
      ...current,
      { id: createOperationId(), kind: "add", column },
    ]);
    setNewName("");
    setNewType("TEXT");
    setNewNullable(true);
    setNewPrimary(false);
    setNewDefault("");
    setAddError(null);
  }, [
    effectiveNames,
    newDefault,
    newName,
    newNullable,
    newPrimary,
    newType,
  ]);

  const saveRename = useCallback(() => {
    if (!renaming) {
      return;
    }
    const message = validateRename(renaming.from, renaming.to, effectiveNames);
    if (message) {
      setAddError(message);
      return;
    }
    const next = renaming.to.trim();
    setPending((current) => {
      const index = current.findIndex(
        (change) => change.kind === "rename" && change.from === renaming.from,
      );
      if (index >= 0) {
        const existing = current[index];
        const copy = [...current];
        copy[index] = {
          id: existing.id,
          kind: "rename",
          from: renaming.from,
          to: next,
        };
        return copy;
      }
      return [
        ...current,
        { id: createOperationId(), kind: "rename", from: renaming.from, to: next },
      ];
    });
    setRenaming(null);
    setAddError(null);
  }, [effectiveNames, renaming]);

  const stageDrop = useCallback((name: string) => {
    setPending((current) => {
      // Dropping a not-yet-applied addition just removes that addition.
      const added = current.find(
        (change) => change.kind === "add" && change.column.name === name,
      );
      if (added) {
        return current.filter((change) => change.id !== added.id);
      }
      const filtered = current.filter(
        (change) => !(change.kind === "rename" && change.from === name),
      );
      return [
        ...filtered,
        { id: createOperationId(), kind: "drop", column: name },
      ];
    });
  }, []);

  const handleApply = useCallback(async () => {
    if (pending.length === 0 || isApplying) {
      return;
    }
    setIsApplying(true);
    let remaining = [...pending];
    try {
      while (remaining.length > 0) {
        const change = remaining[0];
        if (change.kind === "add") {
          await addColumn(connectionId, object, change.column);
        } else if (change.kind === "rename") {
          await renameColumn(connectionId, object, change.from, change.to);
        } else {
          await dropColumn(connectionId, object, change.column);
        }
        remaining = remaining.slice(1);
        setPending(remaining);
      }
      toast.success(`Applied schema changes to ${object.name}`);
      log("success", `Applied schema changes to ${object.name}`);
      await refreshSchema();
      await load();
    } catch (error) {
      const normalized = toQueryError(error);
      toast.error(normalized.message);
      reportError(
        log,
        `Could not apply schema changes to ${object.name}`,
        normalized,
      );
    } finally {
      setIsApplying(false);
    }
  }, [connectionId, isApplying, load, log, object, pending, refreshSchema]);

  const handleRefTableChange = useCallback(
    async (table: string) => {
      setFkRefTable(table);
      setFkRefColumn("");
      if (table) {
        const info = await loadRefTable(table);
        if (info?.primaryKey) {
          setFkRefColumn(info.primaryKey);
        }
      }
    },
    [loadRefTable],
  );

  const handleAddForeignKey = useCallback(async () => {
    if (fkBusy) {
      return;
    }
    const column = fkColumn.trim();
    const referencedTable = fkRefTable.trim();
    const referencedColumn = fkRefColumn.trim();
    if (!column || !referencedTable || !referencedColumn) {
      setFkNotice("Choose a local column and a referenced table and column.");
      return;
    }
    const foreignKey: ForeignKeyDefinition = {
      columns: [column],
      referencedTable,
      referencedColumns: [referencedColumn],
    };
    if (fkRefSchema.trim().length > 0) {
      foreignKey.referencedSchema = fkRefSchema.trim();
    }
    if (fkName.trim().length > 0) {
      foreignKey.name = fkName.trim();
    }
    setFkBusy(true);
    setFkNotice(null);
    try {
      await addForeignKey(connectionId, object, foreignKey);
      toast.success("Foreign key added");
      log("success", `Added a foreign key on ${object.name}`);
      setFkName("");
      setFkColumn("");
      setFkRefTable("");
      setFkRefColumn("");
      setFkRefSchema("");
      await refreshSchema();
      await load();
    } catch (error) {
      const normalized = toQueryError(error);
      toast.error(normalized.message);
      reportError(
        log,
        `Could not add a foreign key on ${object.name}`,
        normalized,
      );
    } finally {
      setFkBusy(false);
    }
  }, [
    connectionId,
    fkBusy,
    fkColumn,
    fkName,
    fkRefColumn,
    fkRefSchema,
    fkRefTable,
    load,
    log,
    object,
    refreshSchema,
  ]);

  const handleDropForeignKey = useCallback(
    async (name: string) => {
      if (fkBusy) {
        return;
      }
      setFkBusy(true);
      try {
        await dropForeignKey(connectionId, object, name);
        toast.success(`Dropped foreign key ${name}`);
        log("success", `Dropped foreign key ${name} on ${object.name}`);
        await refreshSchema();
        await load();
      } catch (error) {
        const normalized = toQueryError(error);
        toast.error(normalized.message);
        reportError(
          log,
          `Could not drop foreign key ${name} on ${object.name}`,
          normalized,
        );
      } finally {
        setFkBusy(false);
      }
    },
    [connectionId, fkBusy, load, log, object, refreshSchema],
  );

  const refColumnOptions = refTables[fkRefTable]?.columns ?? [];
  const fkDisabled =
    !canEdit || pending.length > 0 || fkBusy || columns.length === 0;

  return (
    <section
      aria-label="Object definition"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-semibold tracking-wide text-muted-foreground uppercase">
            Definition
          </span>
          <span className="truncate font-mono text-[11px]" title={object.name}>
            {object.name}
          </span>
          {pending.length > 0 ? (
            <span data-testid="pending-count" className="text-[11px] text-muted-foreground">
              {pending.length} pending
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            disabled={loading || isApplying}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
          {canEdit ? (
            <>
              <Button
                size="sm"
                onClick={() => void handleApply()}
                disabled={pending.length === 0 || isApplying}
                data-testid="apply-changes"
              >
                <CheckIcon />
                {isApplying ? "Applying…" : `Apply (${pending.length})`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPending([]);
                }}
                disabled={pending.length === 0 || isApplying}
              >
                <Undo2Icon />
                Discard
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {object.kind === "view" ? (
        <p
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          Views are read-only; their definition cannot be altered here.
        </p>
      ) : null}

      {loading && description === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <Spinner className="size-3" /> Loading definition…
        </div>
      ) : loadError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4">
          <ErrorBanner error={loadError} title="Could not load definition" />
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={68} minSize={30} className="min-h-0">
            <div className="h-full overflow-auto p-3">
              <div className="flex flex-col gap-5">
                <section className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      Columns
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {columns.length}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    SQLite cannot change a column type, nullability, or default.
                    Add, rename, or drop columns instead.
                  </p>

                  <div
                    className={cn(
                      COLUMN_GRID,
                      "px-1 text-[10px] tracking-wide text-muted-foreground uppercase",
                    )}
                  >
                    <span>Name</span>
                    <span>Type</span>
                    <span className="text-center">Null</span>
                    <span className="text-center">PK</span>
                    <span>Default</span>
                    <span className="text-right">Actions</span>
                  </div>

                  <div className="flex flex-col">
                    {columns.map((column) => {
                      const rename = pending.find(
                        (change) =>
                          change.kind === "rename" && change.from === column.name,
                      );
                      const drop = pending.find(
                        (change) =>
                          change.kind === "drop" && change.column === column.name,
                      );
                      let displayName = column.name;
                      if (rename && rename.kind === "rename") {
                        displayName = rename.to;
                      }
                      const isPrimary = primaryKeyColumns.includes(column.name);
                      return (
                        <div
                          key={column.name}
                          className={cn(
                            "border-t border-border/60 py-1",
                            drop && "opacity-60",
                          )}
                        >
                          <div className={COLUMN_GRID}>
                            {renaming?.from === column.name ? (
                              <div className="flex items-center gap-1">
                                <Input
                                  aria-label={`Rename ${column.name}`}
                                  value={renaming.to}
                                  spellCheck={false}
                                  className={inputClass()}
                                  onChange={(event) =>
                                    setRenaming({
                                      from: column.name,
                                      to: event.target.value,
                                    })
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      saveRename();
                                    }
                                    if (event.key === "Escape") {
                                      setRenaming(null);
                                    }
                                  }}
                                />
                                <Button
                                  size="icon-xs"
                                  aria-label="Save rename"
                                  onClick={saveRename}
                                >
                                  <CheckIcon />
                                </Button>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label="Cancel rename"
                                  onClick={() => setRenaming(null)}
                                >
                                  <XIcon />
                                </Button>
                              </div>
                            ) : (
                              <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
                                <span className={cn("truncate", drop && "line-through")}>
                                  {displayName}
                                </span>
                                {rename ? (
                                  <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                                    renamed
                                  </Badge>
                                ) : null}
                                {drop ? (
                                  <Badge
                                    variant="destructive"
                                    className="h-4 px-1 text-[9px]"
                                  >
                                    drop
                                  </Badge>
                                ) : null}
                              </span>
                            )}
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {column.typeName ?? "-"}
                            </span>
                            <span className="text-center text-[11px] text-muted-foreground">
                              {column.nullable === undefined
                                ? "-"
                                : column.nullable
                                  ? "Yes"
                                  : "No"}
                            </span>
                            <span className="flex justify-center">
                              {isPrimary ? (
                                <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                  PK
                                </Badge>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">-</span>
                              )}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              -
                            </span>
                            <div className="flex justify-end gap-0.5">
                              {drop ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => {
                                    const target = pending.find(
                                      (change) =>
                                        change.kind === "drop" &&
                                        change.column === column.name,
                                    );
                                    if (target) {
                                      discardChange(target.id);
                                    }
                                  }}
                                >
                                  Undo
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={`Rename ${column.name}`}
                                    onClick={() =>
                                      setRenaming({
                                        from: column.name,
                                        to: displayName,
                                      })
                                    }
                                  >
                                    <PencilIcon />
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    className="text-muted-foreground hover:text-destructive"
                                    aria-label={`Drop ${column.name}`}
                                    onClick={() => setDropTarget(column.name)}
                                  >
                                    <Trash2Icon />
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {pendingAdds.map((change) => (
                      <div
                        key={change.id}
                        className="border-t border-border/60 bg-emerald-500/5 py-1"
                      >
                        <div className={COLUMN_GRID}>
                          <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
                            <span className="truncate">{change.column.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                              new
                            </Badge>
                          </span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {change.column.typeName}
                          </span>
                          <span className="text-center text-[11px] text-muted-foreground">
                            {change.column.nullable ? "Yes" : "No"}
                          </span>
                          <span className="flex justify-center">
                            {change.column.primaryKey ? (
                              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                PK
                              </Badge>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">-</span>
                            )}
                          </span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {change.column.default ?? "-"}
                          </span>
                          <div className="flex justify-end">
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => discardChange(change.id)}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {canEdit ? (
                    <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
                      <div className={COLUMN_GRID}>
                        <Input
                          aria-label="New column name"
                          value={newName}
                          spellCheck={false}
                          placeholder="column_name"
                          className={inputClass()}
                          onChange={(event) => {
                            setNewName(event.target.value);
                            setAddError(null);
                          }}
                        />
                        <Select
                          value={newType}
                          onValueChange={(value) => {
                            setNewType(value);
                            setAddError(null);
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label="New column type"
                            className="h-7 w-full font-mono text-[11px]"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TYPE_OPTIONS.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="flex justify-center">
                          <Checkbox
                            aria-label="New column nullable"
                            checked={newNullable}
                            onCheckedChange={(checked) =>
                              setNewNullable(checked === true)
                            }
                          />
                        </span>
                        <span className="flex justify-center">
                          <Checkbox
                            aria-label="New column primary key"
                            checked={newPrimary}
                            onCheckedChange={(checked) =>
                              setNewPrimary(checked === true)
                            }
                          />
                        </span>
                        <Input
                          aria-label="New column default"
                          value={newDefault}
                          spellCheck={false}
                          placeholder="(none)"
                          className={inputClass()}
                          onChange={(event) => setNewDefault(event.target.value)}
                        />
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleAddColumn}
                            data-testid="stage-add-column"
                          >
                            <PlusIcon />
                            Add
                          </Button>
                        </div>
                      </div>
                      {addError ? (
                        <p role="alert" className="text-[11px] text-destructive">
                          {addError}
                        </p>
                      ) : null}
                      {newPrimary ? (
                        <p className="text-[10px] text-muted-foreground">
                          SQLite cannot add a PRIMARY KEY column to an existing
                          table; applying this will return an unsupported error.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                <Separator />

                <section className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5">
                    <LinkIcon className="size-3 text-muted-foreground" />
                    <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      Foreign keys
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {foreignKeys.length}
                    </span>
                  </div>

                  {description?.constraints === undefined ? (
                    <p className="text-[11px] text-muted-foreground">
                      Foreign-key inspection is not supported for this object.
                    </p>
                  ) : foreignKeys.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No foreign keys.
                    </p>
                  ) : (
                    <>
                      <div
                        className={cn(
                          FK_GRID,
                          "px-1 text-[10px] tracking-wide text-muted-foreground uppercase",
                        )}
                      >
                        <span>Name</span>
                        <span>Columns</span>
                        <span>References</span>
                        <span />
                      </div>
                      <div className="flex flex-col">
                        {foreignKeys.map((constraint) => (
                          <div
                            key={constraint.name}
                            className={cn(FK_GRID, "border-t border-border/60 py-1")}
                          >
                            <span className="truncate font-mono text-[11px]">
                              {constraint.name}
                            </span>
                            <span className="truncate font-mono text-[11px]">
                              {(constraint.columns ?? []).join(", ") || "-"}
                            </span>
                            <span className="truncate font-mono text-[11px]">
                              {constraint.referencedTable ?? "-"}
                              {constraint.referencedColumns?.length
                                ? ` (${constraint.referencedColumns.join(", ")})`
                                : ""}
                            </span>
                            <div className="flex justify-end">
                              {canEdit ? (
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  className="text-muted-foreground hover:text-destructive"
                                  aria-label={`Drop foreign key ${constraint.name}`}
                                  onClick={() =>
                                    void handleDropForeignKey(constraint.name)
                                  }
                                  disabled={fkBusy}
                                >
                                  <Trash2Icon />
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {canEdit ? (
                    <div className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-2">
                      <label className="flex flex-col gap-1">
                        {fieldLabel("Local column")}
                        <Select
                          value={fkColumn === "" ? NONE : fkColumn}
                          onValueChange={(value) =>
                            setFkColumn(value === NONE ? "" : value)
                          }
                          disabled={pending.length > 0}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label="Foreign key local column"
                            className="h-7 w-36 font-mono text-[11px]"
                          >
                            <SelectValue placeholder="-" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>-</SelectItem>
                            {columns.map((column) => (
                              <SelectItem key={column.name} value={column.name}>
                                {column.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                      <label className="flex flex-col gap-1">
                        {fieldLabel("References table")}
                        <Select
                          value={fkRefTable === "" ? NONE : fkRefTable}
                          onValueChange={(value) =>
                            void handleRefTableChange(value === NONE ? "" : value)
                          }
                          disabled={pending.length > 0}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label="Foreign key referenced table"
                            className="h-7 w-40 font-mono text-[11px]"
                          >
                            <SelectValue placeholder="-" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>-</SelectItem>
                            {tableOptions.map((table) => (
                              <SelectItem key={table.name} value={table.name}>
                                {table.name}
                              </SelectItem>
                            ))}
                            {fkRefTable &&
                            !tableOptions.some((table) => table.name === fkRefTable) ? (
                              <SelectItem value={fkRefTable}>{fkRefTable}</SelectItem>
                            ) : null}
                          </SelectContent>
                        </Select>
                      </label>
                      <label className="flex flex-col gap-1">
                        {fieldLabel("References column")}
                        <Select
                          value={fkRefColumn === "" ? NONE : fkRefColumn}
                          onValueChange={(value) =>
                            setFkRefColumn(value === NONE ? "" : value)
                          }
                          disabled={pending.length > 0 || refColumnOptions.length === 0}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label="Foreign key referenced column"
                            className="h-7 w-40 font-mono text-[11px]"
                          >
                            <SelectValue placeholder="-" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>-</SelectItem>
                            {refColumnOptions.map((column) => (
                              <SelectItem key={column} value={column}>
                                {column}
                              </SelectItem>
                            ))}
                            {fkRefColumn && !refColumnOptions.includes(fkRefColumn) ? (
                              <SelectItem value={fkRefColumn}>{fkRefColumn}</SelectItem>
                            ) : null}
                          </SelectContent>
                        </Select>
                      </label>
                      <label className="flex flex-col gap-1">
                        {fieldLabel("Reference schema")}
                        <Input
                          aria-label="Foreign key referenced schema"
                          value={fkRefSchema}
                          spellCheck={false}
                          placeholder="(none)"
                          className={inputClass("w-28")}
                          onChange={(event) => setFkRefSchema(event.target.value)}
                          disabled={pending.length > 0}
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        {fieldLabel("Constraint name")}
                        <Input
                          aria-label="Foreign key name"
                          value={fkName}
                          spellCheck={false}
                          placeholder="(generated)"
                          className={inputClass("w-44")}
                          onChange={(event) => setFkName(event.target.value)}
                          disabled={pending.length > 0}
                        />
                      </label>
                      {pending.length > 0 ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="mb-0.5">
                                <Button size="sm" disabled>
                                  <PlusIcon />
                                  Add foreign key
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Apply or discard pending column changes first.
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <Button
                          size="sm"
                          className="mb-0.5"
                          onClick={() => void handleAddForeignKey()}
                          disabled={fkDisabled}
                        >
                          <PlusIcon />
                          Add foreign key
                        </Button>
                      )}
                    </div>
                  ) : null}

                  {fkNotice ? (
                    <p role="alert" className="text-[11px] text-destructive">
                      {fkNotice}
                    </p>
                  ) : null}
                </section>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={32} minSize={15} className="min-h-0">
            <div className="flex h-full flex-col">
              <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 text-[10px] tracking-wide text-muted-foreground uppercase">
                <span>Generated SQL</span>
                <span>{pending.length} statement(s)</span>
              </div>
              <SqlPreview
                statements={pendingSql}
                emptyLabel="No pending changes. Stage a column edit to preview its SQL."
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <AlertDialog
        open={dropTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDropTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop column</AlertDialogTitle>
            <AlertDialogDescription>
              Stage dropping “{dropTarget}”? The column is only removed when you
              apply the pending changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (dropTarget !== null) {
                  stageDrop(dropTarget);
                }
              }}
            >
              Stage drop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
