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
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { cn } from "@/lib/utils";

import {
  pendingChangesToSql,
  pendingColumnNames,
  validateNewColumn,
  validateRename,
  type PendingColumnChange,
} from "./columnEdits";
import { ErrorBanner, SqlPreview } from "./parts";

export interface DefinitionTabViewProps {
  connectionId: string;
  object: ObjectRef;
}

type AddChange = Extract<PendingColumnChange, { kind: "add" }>;

function selectClass(extra?: string): string {
  return cn(
    "h-6 min-w-0 rounded-sm border border-input bg-background px-1 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    extra,
  );
}

function fieldLabel(text: string) {
  return (
    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
      {text}
    </span>
  );
}

/**
 * Table/view definition editor.
 *
 * Columns are edited by staging local add/rename/drop changes, previewing the
 * exact `ALTER TABLE` statements, then applying them in order. Foreign-key
 * controls call the backend directly, so an engine that cannot alter them
 * (SQLite) reports its `unsupported` error rather than pretending to succeed.
 */
export function DefinitionTabView({
  connectionId,
  object,
}: DefinitionTabViewProps) {
  const { refreshSchema } = useWorkspace();
  const canEdit = object.kind === "table";

  const [description, setDescription] = useState<TableDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<QueryError | null>(null);
  const [pending, setPending] = useState<PendingColumnChange[]>([]);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<QueryError | null>(null);
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
  const [fkError, setFkError] = useState<QueryError | null>(null);
  const [fkBusy, setFkBusy] = useState(false);

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
    setApplyError(null);
    setRenaming(null);
    setDropTarget(null);
    setAddError(null);
    setFkError(null);
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

  const discardChange = useCallback((id: string) => {
    setPending((current) => current.filter((change) => change.id !== id));
    setApplyError(null);
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
    setApplyError(null);
  }, []);

  const handleApply = useCallback(async () => {
    if (pending.length === 0 || isApplying) {
      return;
    }
    setIsApplying(true);
    setApplyError(null);
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
      await refreshSchema();
      await load();
    } catch (error) {
      const normalized = toQueryError(error);
      setApplyError(normalized);
      toast.error(normalized.message);
    } finally {
      setIsApplying(false);
    }
  }, [connectionId, isApplying, load, object, pending, refreshSchema]);

  const handleAddForeignKey = useCallback(async () => {
    if (fkBusy) {
      return;
    }
    const column = fkColumn.trim();
    const referencedTable = fkRefTable.trim();
    const referencedColumn = fkRefColumn.trim();
    if (!column || !referencedTable || !referencedColumn) {
      setFkError({
        category: "validation",
        message:
          "Choose a local column and enter the referenced table and column.",
      });
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
    setFkError(null);
    try {
      await addForeignKey(connectionId, object, foreignKey);
      toast.success("Foreign key added");
      setFkName("");
      setFkColumn("");
      setFkRefTable("");
      setFkRefColumn("");
      setFkRefSchema("");
      await refreshSchema();
      await load();
    } catch (error) {
      setFkError(toQueryError(error));
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
    object,
    refreshSchema,
  ]);

  const handleDropForeignKey = useCallback(
    async (name: string) => {
      if (fkBusy) {
        return;
      }
      setFkBusy(true);
      setFkError(null);
      try {
        await dropForeignKey(connectionId, object, name);
        toast.success(`Dropped foreign key ${name}`);
        await refreshSchema();
        await load();
      } catch (error) {
        setFkError(toQueryError(error));
      } finally {
        setFkBusy(false);
      }
    },
    [connectionId, fkBusy, load, object, refreshSchema],
  );

  const fkDisabled = !canEdit || pending.length > 0 || fkBusy || columns.length === 0;

  return (
    <section
      aria-label="Object definition"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-semibold tracking-wide uppercase text-muted-foreground">
            Definition
          </span>
          <span className="truncate font-mono" title={object.name}>
            {object.name}
          </span>
          {pending.length > 0 ? (
            <span data-testid="pending-count" className="text-muted-foreground">
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
                  setApplyError(null);
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
          className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground"
        >
          Views are read-only; their definition cannot be altered here.
        </p>
      ) : null}

      {applyError ? (
        <div className="shrink-0 px-2 pt-2">
          <ErrorBanner error={applyError} title="Apply failed" />
        </div>
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
            <div className="h-full overflow-auto p-2">
              <div className="flex flex-col gap-3">
              <p className="text-[10px] text-muted-foreground">
                Column defaults are not reported by metadata inspection; staged
                additions show the default they will create.
              </p>
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                        Name
                      </TableHead>
                      <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                        Type
                      </TableHead>
                      <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                        Nullable
                      </TableHead>
                      <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                        Key
                      </TableHead>
                      <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                        Default
                      </TableHead>
                      {canEdit ? (
                        <TableHead className="h-7 w-32 px-2 text-[10px] tracking-wide uppercase">
                          Edit
                        </TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
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
                        <TableRow
                          key={column.name}
                          className={cn(drop ? "opacity-60" : undefined)}
                        >
                          <TableCell className="px-2 py-1">
                            {renaming?.from === column.name ? (
                              <div className="flex items-center gap-1">
                                <Input
                                  aria-label={`Rename ${column.name}`}
                                  value={renaming.to}
                                  spellCheck={false}
                                  className="h-6 w-36 font-mono text-[11px]"
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
                              <span className="flex items-center gap-1 font-mono">
                                <span className={cn(drop && "line-through")}>
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
                          </TableCell>
                          <TableCell className="px-2 py-1 text-[11px] text-muted-foreground">
                            {column.typeName ?? "-"}
                          </TableCell>
                          <TableCell className="px-2 py-1 text-[11px]">
                            {column.nullable === undefined
                              ? "-"
                              : column.nullable
                                ? "Yes"
                                : "No"}
                          </TableCell>
                          <TableCell className="px-2 py-1">
                            {isPrimary ? (
                              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                PK
                              </Badge>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
                            -
                          </TableCell>
                          {canEdit ? (
                            <TableCell className="px-2 py-1">
                              <div className="flex items-center gap-0.5">
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
                                      size="xs"
                                      variant="ghost"
                                      aria-label={`Rename ${column.name}`}
                                      onClick={() =>
                                        setRenaming({
                                          from: column.name,
                                          to: displayName,
                                        })
                                      }
                                    >
                                      <PencilIcon className="size-3" />
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      aria-label={`Drop ${column.name}`}
                                      onClick={() => setDropTarget(column.name)}
                                    >
                                      <Trash2Icon className="size-3" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}

                    {pendingAdds.map((change) => (
                      <TableRow key={change.id} className="bg-muted/30">
                        <TableCell className="px-2 py-1">
                          <span className="flex items-center gap-1 font-mono">
                            {change.column.name}
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                              new
                            </Badge>
                          </span>
                        </TableCell>
                        <TableCell className="px-2 py-1 text-[11px] text-muted-foreground">
                          {change.column.typeName}
                        </TableCell>
                        <TableCell className="px-2 py-1 text-[11px]">
                          {change.column.nullable ? "Yes" : "No"}
                        </TableCell>
                        <TableCell className="px-2 py-1">
                          {change.column.primaryKey ? (
                            <Badge variant="outline" className="h-4 px-1 text-[9px]">
                              PK
                            </Badge>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        <TableCell className="px-2 py-1 font-mono text-[11px]">
                          {change.column.default ?? "-"}
                        </TableCell>
                        {canEdit ? (
                          <TableCell className="px-2 py-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => discardChange(change.id)}
                            >
                              Remove
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {canEdit ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Name")}
                      <Input
                        aria-label="New column name"
                        value={newName}
                        spellCheck={false}
                        className="h-6 w-40 font-mono text-[11px]"
                        onChange={(event) => {
                          setNewName(event.target.value);
                          setAddError(null);
                        }}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Type")}
                      <Input
                        aria-label="New column type"
                        value={newType}
                        spellCheck={false}
                        className="h-6 w-32 font-mono text-[11px]"
                        onChange={(event) => {
                          setNewType(event.target.value);
                          setAddError(null);
                        }}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Default")}
                      <Input
                        aria-label="New column default"
                        value={newDefault}
                        spellCheck={false}
                        placeholder="(none)"
                        className="h-6 w-36 font-mono text-[11px]"
                        onChange={(event) => setNewDefault(event.target.value)}
                      />
                    </label>
                    <label className="flex items-center gap-1 pb-1 text-[11px]">
                      <Checkbox
                        aria-label="New column nullable"
                        checked={newNullable}
                        onCheckedChange={(checked) =>
                          setNewNullable(checked === true)
                        }
                      />
                      Nullable
                    </label>
                    <label className="flex items-center gap-1 pb-1 text-[11px]">
                      <Checkbox
                        aria-label="New column primary key"
                        checked={newPrimary}
                        onCheckedChange={(checked) =>
                          setNewPrimary(checked === true)
                        }
                      />
                      Primary key
                    </label>
                    <Button
                      size="xs"
                      className="mb-0.5"
                      onClick={handleAddColumn}
                      data-testid="stage-add-column"
                    >
                      <PlusIcon className="size-3" />
                      Add column
                    </Button>
                  </div>
                  {addError ? (
                    <p role="alert" className="text-[11px] text-destructive">
                      {addError}
                    </p>
                  ) : null}
                  {newPrimary ? (
                    <p className="text-[10px] text-muted-foreground">
                      SQLite cannot add a PRIMARY KEY column to an existing table;
                      applying this will return an unsupported error.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <Separator />

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase text-muted-foreground">
                  <LinkIcon className="size-3" />
                  Foreign keys
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
                  <div className="rounded-md border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                            Name
                          </TableHead>
                          <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                            Columns
                          </TableHead>
                          <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                            References
                          </TableHead>
                          {canEdit ? (
                            <TableHead className="h-7 w-16 px-2 text-[10px] tracking-wide uppercase">
                              Edit
                            </TableHead>
                          ) : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {foreignKeys.map((constraint) => (
                          <TableRow key={constraint.name}>
                            <TableCell className="px-2 py-1 font-mono text-[11px]">
                              {constraint.name}
                            </TableCell>
                            <TableCell className="px-2 py-1 font-mono text-[11px]">
                              {(constraint.columns ?? []).join(", ") || "-"}
                            </TableCell>
                            <TableCell className="px-2 py-1 font-mono text-[11px]">
                              {constraint.referencedTable ?? "-"}
                              {constraint.referencedColumns?.length
                                ? ` (${constraint.referencedColumns.join(", ")})`
                                : ""}
                            </TableCell>
                            {canEdit ? (
                              <TableCell className="px-2 py-1">
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`Drop foreign key ${constraint.name}`}
                                  onClick={() =>
                                    void handleDropForeignKey(constraint.name)
                                  }
                                  disabled={fkBusy}
                                >
                                  <Trash2Icon className="size-3" />
                                </Button>
                              </TableCell>
                            ) : null}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {canEdit ? (
                  <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Local column")}
                      <select
                        aria-label="Foreign key local column"
                        className={selectClass("w-32")}
                        value={fkColumn}
                        onChange={(event) => setFkColumn(event.target.value)}
                        disabled={pending.length > 0}
                      >
                        <option value="">-</option>
                        {columns.map((column) => (
                          <option key={column.name} value={column.name}>
                            {column.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Reference table")}
                      <Input
                        aria-label="Foreign key referenced table"
                        value={fkRefTable}
                        spellCheck={false}
                        className="h-6 w-32 font-mono text-[11px]"
                        onChange={(event) => setFkRefTable(event.target.value)}
                        disabled={pending.length > 0}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Reference column")}
                      <Input
                        aria-label="Foreign key referenced column"
                        value={fkRefColumn}
                        spellCheck={false}
                        className="h-6 w-32 font-mono text-[11px]"
                        onChange={(event) => setFkRefColumn(event.target.value)}
                        disabled={pending.length > 0}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Schema")}
                      <Input
                        aria-label="Foreign key referenced schema"
                        value={fkRefSchema}
                        spellCheck={false}
                        placeholder="(none)"
                        className="h-6 w-24 font-mono text-[11px]"
                        onChange={(event) => setFkRefSchema(event.target.value)}
                        disabled={pending.length > 0}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      {fieldLabel("Name")}
                      <Input
                        aria-label="Foreign key name"
                        value={fkName}
                        spellCheck={false}
                        placeholder="(generated)"
                        className="h-6 w-32 font-mono text-[11px]"
                        onChange={(event) => setFkName(event.target.value)}
                        disabled={pending.length > 0}
                      />
                    </label>
                    {pending.length > 0 ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="mb-0.5">
                              <Button size="xs" disabled>
                                <PlusIcon className="size-3" />
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
                        size="xs"
                        className="mb-0.5"
                        onClick={() => void handleAddForeignKey()}
                        disabled={fkDisabled}
                      >
                        <PlusIcon className="size-3" />
                        Add foreign key
                      </Button>
                    )}
                  </div>
                ) : null}

                {fkError ? (
                  <ErrorBanner
                    error={fkError}
                    title="Foreign key change failed"
                  />
                ) : null}
              </div>
            </div>
          </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={32} minSize={15} className="min-h-0">
            <div className="flex h-full flex-col">
              <div className="flex h-6 shrink-0 items-center justify-between border-b border-border bg-card px-2 text-[10px] tracking-wide uppercase text-muted-foreground">
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
