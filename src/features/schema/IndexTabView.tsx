import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRoundIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { IndexInfo, ObjectRef, QueryError, TableDescription } from "@/domain";
import { toQueryError } from "@/services/errors";
import { describeTable } from "@/services/metadata";
import { createIndex, dropIndex } from "@/services/schema";
import { reportError } from "@/lib/notify";
import { cn } from "@/lib/utils";

import { ErrorBanner, SqlPreview } from "./parts";
import { renderCreateIndex } from "./sql";

export interface IndexTabViewProps {
  connectionId: string;
  object: ObjectRef;
}

/** Grid shared by the index header and its rows. */
const INDEX_GRID =
  "grid grid-cols-[minmax(10rem,1.5fr)_minmax(9rem,1.3fr)_72px_36px] items-center gap-2";

function fieldLabel(text: string) {
  return (
    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
      {text}
    </span>
  );
}

/**
 * Index editor for a table or view.
 *
 * A flat, borderless layout matching the other schema pages. Lists inspected
 * indexes (distinguishing "unsupported" from "none"), and creates/drops indexes
 * through the backend. Primary-key indexes cannot be dropped through this
 * adapter.
 */
export function IndexTabView({ connectionId, object }: IndexTabViewProps) {
  const { refreshSchema, log } = useWorkspace();
  const canCreate = object.kind === "table";

  const [description, setDescription] = useState<TableDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<QueryError | null>(null);

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<IndexInfo | null>(null);

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
  }, [connectionId, object.name, object.database, object.schema, object.kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setName("");
    setSelected([]);
    setUnique(false);
    setFormError(null);
    setDropTarget(null);
  }, [connectionId, object.name, object.database, object.schema, object.kind]);

  const columns = useMemo(() => description?.columns ?? [], [description]);

  const indexPreview = useMemo(
    () =>
      name.trim().length > 0 || selected.length > 0
        ? [
            renderCreateIndex(
              object,
              name.trim() || "index_name",
              selected.length > 0 ? selected : ["column"],
              unique,
            ),
          ]
        : [],
    [name, object, selected, unique],
  );

  const toggleColumn = useCallback((column: string) => {
    setSelected((current) =>
      current.includes(column)
        ? current.filter((candidate) => candidate !== column)
        : [...current, column],
    );
    setFormError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (busy) {
      return;
    }
    if (name.trim().length === 0) {
      setFormError("Enter an index name.");
      return;
    }
    if (selected.length === 0) {
      setFormError("Select at least one column.");
      return;
    }
    setBusy(true);
    try {
      await createIndex(connectionId, object, name.trim(), selected, unique);
      toast.success(`Created index ${name.trim()}`);
      log("success", `Created index ${name.trim()} on ${object.name}`);
      setName("");
      setSelected([]);
      setUnique(false);
      setFormError(null);
      await refreshSchema();
      await load();
    } catch (error) {
      const normalized = toQueryError(error);
      toast.error(normalized.message);
      reportError(
        log,
        `Could not create index ${name.trim()} on ${object.name}`,
        normalized,
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    connectionId,
    load,
    log,
    name,
    object,
    refreshSchema,
    selected,
    unique,
  ]);

  const handleDrop = useCallback(async () => {
    if (!dropTarget || busy) {
      return;
    }
    setBusy(true);
    try {
      await dropIndex(connectionId, object, dropTarget.name);
      toast.success(`Dropped index ${dropTarget.name}`);
      log("success", `Dropped index ${dropTarget.name} on ${object.name}`);
      await refreshSchema();
      await load();
    } catch (error) {
      const normalized = toQueryError(error);
      toast.error(normalized.message);
      reportError(
        log,
        `Could not drop index ${dropTarget.name} on ${object.name}`,
        normalized,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, connectionId, dropTarget, load, log, object, refreshSchema]);

  const indexes = description?.indexes;

  return (
    <section
      aria-label="Object indexes"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      {loading && description === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <Spinner className="size-3" /> Loading indexes…
        </div>
      ) : loadError ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4">
          <ErrorBanner error={loadError} title="Could not load indexes" />
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
                      Indexes
                    </span>
                    {indexes ? (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {indexes.length}
                      </span>
                    ) : null}
                  </div>

                  {indexes === undefined ? (
                    <p
                      role="status"
                      className="text-[11px] text-muted-foreground"
                    >
                      Index inspection is not supported for this object.
                    </p>
                  ) : indexes.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No indexes.
                    </p>
                  ) : (
                    <>
                      <div
                        className={cn(
                          INDEX_GRID,
                          "px-1 text-[10px] tracking-wide text-muted-foreground uppercase",
                        )}
                      >
                        <span>Name</span>
                        <span>Columns</span>
                        <span className="text-center">Unique</span>
                        <span />
                      </div>
                      <div className="flex flex-col">
                        {indexes.map((index) => (
                          <div
                            key={index.name}
                            className={cn(INDEX_GRID, "border-t border-border/60 py-1")}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate font-mono text-[11px]">
                                {index.name}
                              </span>
                              {index.primary ? (
                                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                                  <KeyRoundIcon className="size-3" />
                                  PK
                                </Badge>
                              ) : null}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {(index.columns ?? []).join(", ") || "-"}
                            </span>
                            <span className="text-center text-[11px] text-muted-foreground">
                              {index.unique ? "Yes" : "No"}
                            </span>
                            <div className="flex justify-end">
                              {canCreate ? (
                                index.primary ? (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="inline-flex">
                                          <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            disabled
                                            aria-label={`Drop index ${index.name}`}
                                          >
                                            <Trash2Icon />
                                          </Button>
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        The primary-key index cannot be dropped.
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ) : (
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    className="text-muted-foreground hover:text-destructive"
                                    aria-label={`Drop index ${index.name}`}
                                    onClick={() => setDropTarget(index)}
                                    disabled={busy}
                                  >
                                    <Trash2Icon />
                                  </Button>
                                )
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {canCreate ? (
                  <>
                    <Separator />

                    <section className="flex flex-col gap-2">
                      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                        New index
                      </span>

                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1">
                          {fieldLabel("Name")}
                          <Input
                            aria-label="New index name"
                            value={name}
                            spellCheck={false}
                            placeholder="idx_table_column"
                            className="h-7 w-56 rounded-sm px-1.5 font-mono text-[11px] focus-visible:ring-1"
                            onChange={(event) => {
                              setName(event.target.value);
                              setFormError(null);
                            }}
                          />
                        </label>
                        <label className="flex items-center gap-2 pb-2 text-[11px]">
                          <Checkbox
                            aria-label="Index is unique"
                            checked={unique}
                            onCheckedChange={(checked) => setUnique(checked === true)}
                          />
                          Unique
                        </label>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {fieldLabel("Columns")}
                        {columns.length === 0 ? (
                          <span className="text-[11px] text-muted-foreground">-</span>
                        ) : (
                          columns.map((column) => {
                            const isSelected = selected.includes(column.name);
                            return (
                              <label
                                key={column.name}
                                className={cn(
                                  "flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                                  isSelected
                                    ? "bg-primary/15 text-foreground"
                                    : "bg-muted text-muted-foreground hover:bg-accent",
                                )}
                              >
                                <Checkbox
                                  aria-label={`Index column ${column.name}`}
                                  checked={isSelected}
                                  onCheckedChange={() => toggleColumn(column.name)}
                                />
                                {column.name}
                              </label>
                            );
                          })
                        )}
                      </div>

                      <div>
                        <Button
                          size="sm"
                          onClick={() => void handleCreate()}
                          disabled={busy || columns.length === 0}
                          data-testid="create-index"
                        >
                          <PlusIcon />
                          Create index
                        </Button>
                      </div>

                      {formError ? (
                        <p role="alert" className="text-[11px] text-destructive">
                          {formError}
                        </p>
                      ) : null}
                    </section>
                  </>
                ) : null}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={32} minSize={15} className="min-h-0">
            <div className="flex h-full flex-col">
              <div className="flex h-7 shrink-0 items-center border-b border-border px-3 text-[10px] tracking-wide text-muted-foreground uppercase">
                Generated SQL
              </div>
              <SqlPreview
                statements={indexPreview}
                emptyLabel="Enter an index name and columns to preview its SQL."
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      <footer className="flex h-9 shrink-0 items-center gap-1 border-t border-border bg-muted px-2 text-xs select-none">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => void load()}
          disabled={loading || busy}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </Button>
        <div className="flex-1" />
      </footer>

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
            <AlertDialogTitle>Drop index</AlertDialogTitle>
            <AlertDialogDescription>
              Drop index “{dropTarget?.name}”? This runs immediately against the
              database.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void handleDrop()}
            >
              Drop index
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
