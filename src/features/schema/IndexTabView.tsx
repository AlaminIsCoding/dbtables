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
import type { IndexInfo, ObjectRef, QueryError, TableDescription } from "@/domain";
import { toQueryError } from "@/services/errors";
import { describeTable } from "@/services/metadata";
import { createIndex, dropIndex } from "@/services/schema";
import { cn } from "@/lib/utils";

import { ErrorBanner, SqlPreview } from "./parts";
import { renderCreateIndex } from "./sql";

export interface IndexTabViewProps {
  connectionId: string;
  object: ObjectRef;
}

/**
 * Index editor for a table or view.
 *
 * Lists inspected indexes (distinguishing "unsupported" from "none"), and
 * creates/drops indexes through the backend. Primary-key indexes cannot be
 * dropped through this adapter.
 */
export function IndexTabView({ connectionId, object }: IndexTabViewProps) {
  const { refreshSchema } = useWorkspace();
  const canCreate = object.kind === "table";

  const [description, setDescription] = useState<TableDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<QueryError | null>(null);

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<QueryError | null>(null);
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
    setActionError(null);
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
    setActionError(null);
    try {
      await createIndex(connectionId, object, name.trim(), selected, unique);
      toast.success(`Created index ${name.trim()}`);
      setName("");
      setSelected([]);
      setUnique(false);
      setFormError(null);
      await refreshSchema();
      await load();
    } catch (error) {
      setActionError(toQueryError(error));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    connectionId,
    load,
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
    setActionError(null);
    try {
      await dropIndex(connectionId, object, dropTarget.name);
      toast.success(`Dropped index ${dropTarget.name}`);
      await refreshSchema();
      await load();
    } catch (error) {
      setActionError(toQueryError(error));
    } finally {
      setBusy(false);
    }
  }, [busy, connectionId, dropTarget, load, object, refreshSchema]);

  const indexes = description?.indexes;

  return (
    <section
      aria-label="Object indexes"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-semibold tracking-wide uppercase text-muted-foreground">
            Indexes
          </span>
          <span className="truncate font-mono" title={object.name}>
            {object.name}
          </span>
          {indexes ? (
            <span className="text-muted-foreground">{indexes.length}</span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={loading || busy}
        >
          <RefreshCwIcon />
          Refresh
        </Button>
      </header>

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
            <div className="h-full overflow-auto p-2">
              <div className="flex flex-col gap-3">
              {indexes === undefined ? (
                <p
                  role="status"
                  className="rounded-md border border-dashed border-border px-2 py-3 text-[11px] text-muted-foreground"
                >
                  Index inspection is not supported for this object.
                </p>
              ) : indexes.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-2 py-3 text-[11px] text-muted-foreground">
                  No indexes.
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
                          Unique
                        </TableHead>
                        <TableHead className="h-7 px-2 text-[10px] tracking-wide uppercase">
                          Primary
                        </TableHead>
                        {canCreate ? (
                          <TableHead className="h-7 w-16 px-2 text-[10px] tracking-wide uppercase">
                            Edit
                          </TableHead>
                        ) : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {indexes.map((index) => (
                        <TableRow key={index.name}>
                          <TableCell className="px-2 py-1 font-mono text-[11px]">
                            {index.name}
                          </TableCell>
                          <TableCell className="px-2 py-1 font-mono text-[11px]">
                            {(index.columns ?? []).join(", ") || "-"}
                          </TableCell>
                          <TableCell className="px-2 py-1 text-[11px]">
                            {index.unique ? "Yes" : "No"}
                          </TableCell>
                          <TableCell className="px-2 py-1">
                            {index.primary ? (
                              <Badge
                                variant="outline"
                                className="h-4 px-1 text-[9px]"
                              >
                                <KeyRoundIcon className="size-3" />
                                PK
                              </Badge>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          {canCreate ? (
                            <TableCell className="px-2 py-1">
                              {index.primary ? (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="inline-flex">
                                        <Button
                                          size="xs"
                                          variant="ghost"
                                          disabled
                                          aria-label={`Drop index ${index.name}`}
                                        >
                                          <Trash2Icon className="size-3" />
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
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`Drop index ${index.name}`}
                                  onClick={() => setDropTarget(index)}
                                  disabled={busy}
                                >
                                  <Trash2Icon className="size-3" />
                                </Button>
                              )}
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {canCreate ? (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                        Name
                      </span>
                      <Input
                        aria-label="New index name"
                        value={name}
                        spellCheck={false}
                        className="h-6 w-44 font-mono text-[11px]"
                        onChange={(event) => {
                          setName(event.target.value);
                          setFormError(null);
                        }}
                      />
                    </label>
                    <label className="flex items-center gap-1 pb-1 text-[11px]">
                      <Checkbox
                        aria-label="Index is unique"
                        checked={unique}
                        onCheckedChange={(checked) => setUnique(checked === true)}
                      />
                      Unique
                    </label>
                    <Button
                      size="xs"
                      className="mb-0.5"
                      onClick={() => void handleCreate()}
                      disabled={busy || columns.length === 0}
                      data-testid="create-index"
                    >
                      <PlusIcon className="size-3" />
                      Create index
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                      Columns
                    </span>
                    {columns.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">-</span>
                    ) : (
                      columns.map((column) => (
                        <label
                          key={column.name}
                          className={cn(
                            "flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px]",
                            selected.includes(column.name) && "bg-muted",
                          )}
                        >
                          <Checkbox
                            aria-label={`Index column ${column.name}`}
                            checked={selected.includes(column.name)}
                            onCheckedChange={() => toggleColumn(column.name)}
                          />
                          {column.name}
                        </label>
                      ))
                    )}
                  </div>

                  {formError ? (
                    <p role="alert" className="text-[11px] text-destructive">
                      {formError}
                    </p>
                  ) : null}

                  {actionError ? (
                    <ErrorBanner error={actionError} title="Index operation failed" />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={32} minSize={15} className="min-h-0">
            <div className="flex h-full flex-col">
              <div className="flex h-6 shrink-0 items-center justify-between border-b border-border bg-card px-2 text-[10px] tracking-wide uppercase text-muted-foreground">
                <span>Generated SQL</span>
              </div>
              <SqlPreview
                statements={indexPreview}
                emptyLabel="Enter an index name and columns to preview its SQL."
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
