import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { useWorkspace } from "@/app/store";
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
import { createOperationId } from "@/domain";
import { reportError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { toQueryError } from "@/services/errors";
import { describeTable } from "@/services/metadata";
import { createTable } from "@/services/schema";

import {
  createEmptyDraft,
  draftToTableDefinition,
  emptyDraftColumn,
  emptyDraftForeignKey,
  previewCreateTable,
  validateCreateTableDraft,
  type CreateTableDraft,
  type DraftColumn,
  type DraftForeignKey,
} from "./createTable";
import { SqlPreview } from "./parts";
import { NONE, TYPE_OPTIONS } from "./typeOptions";
export interface CreateTableTabViewProps {
  connectionId: string;
}

/** Shared column layout so the header and rows stay aligned. */
const GRID_COLUMNS =
  "grid grid-cols-[minmax(8rem,1.4fr)_minmax(7rem,1.1fr)_56px_48px_minmax(7rem,1fr)_32px] items-center gap-2";

function inputClass(extra?: string): string {
  return cn(
    "h-7 rounded-sm px-1.5 font-mono text-[11px] focus-visible:ring-1",
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

interface RefTableInfo {
  columns: string[];
  primaryKey: string | null;
}

/**
 * New-table editor.
 *
 * A flat, borderless form: one column grid, a foreign-key list whose fields are
 * chosen from the live schema (instead of typed by hand), and a generated SQL
 * preview. Columns and keys are validated locally, then the table is created,
 * the schema refreshed, and the new table opened in place of this tab.
 */
export function CreateTableTabView({ connectionId }: CreateTableTabViewProps) {
  const { activeTabId, closeTab, openTable, refreshSchema, schema, log } =
    useWorkspace();

  const [draft, setDraft] = useState<CreateTableDraft>(() =>
    createEmptyDraft(createOperationId()),
  );
  const [submitted, setSubmitted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refTables, setRefTables] = useState<Record<string, RefTableInfo>>({});

  const validation = useMemo(() => validateCreateTableDraft(draft), [draft]);
  const showErrors = submitted;
  const preview = useMemo(() => previewCreateTable(draft), [draft]);

  const tableOptions = useMemo(
    () => (schema.status === "ready" ? schema.tables : []),
    [schema],
  );

  const updateColumn = useCallback(
    (id: string, patch: Partial<DraftColumn>) => {
      setDraft((current) => ({
        ...current,
        columns: current.columns.map((column) =>
          column.id === id ? { ...column, ...patch } : column,
        ),
      }));
    },
    [],
  );

  const addColumn = useCallback(() => {
    setDraft((current) => ({
      ...current,
      columns: [...current.columns, emptyDraftColumn(createOperationId())],
    }));
  }, []);

  const removeColumn = useCallback((id: string) => {
    setDraft((current) => ({
      ...current,
      columns: current.columns.filter((column) => column.id !== id),
    }));
  }, []);

  const setPrimaryKey = useCallback((id: string) => {
    setDraft((current) => ({
      ...current,
      columns: current.columns.map((column) => ({
        ...column,
        primaryKey: column.id === id ? !column.primaryKey : false,
      })),
    }));
  }, []);

  const updateForeignKey = useCallback(
    (id: string, patch: Partial<DraftForeignKey>) => {
      setDraft((current) => ({
        ...current,
        foreignKeys: current.foreignKeys.map((foreignKey) =>
          foreignKey.id === id ? { ...foreignKey, ...patch } : foreignKey,
        ),
      }));
    },
    [],
  );

  const addForeignKey = useCallback(() => {
    setDraft((current) => ({
      ...current,
      foreignKeys: [
        ...current.foreignKeys,
        emptyDraftForeignKey(createOperationId()),
      ],
    }));
  }, []);

  const removeForeignKey = useCallback((id: string) => {
    setDraft((current) => ({
      ...current,
      foreignKeys: current.foreignKeys.filter(
        (foreignKey) => foreignKey.id !== id,
      ),
    }));
  }, []);

  const loadRefTable = useCallback(
    async (table: string): Promise<RefTableInfo | null> => {
      if (!table) {
        return null;
      }
      try {
        const description = await describeTable(connectionId, {
          kind: "table",
          name: table,
        });
        const info: RefTableInfo = {
          columns: description.columns.map((column) => column.name),
          primaryKey: description.primaryKeyColumns?.[0] ?? null,
        };
        setRefTables((current) => ({ ...current, [table]: info }));
        return info;
      } catch {
        // A view or an engine without inspection: fall back to free text.
        const info: RefTableInfo = { columns: [], primaryKey: null };
        setRefTables((current) => ({ ...current, [table]: info }));
        return info;
      }
    },
    [connectionId],
  );

  // Load metadata for any referenced table so its column dropdown is filled.
  const refTableSignature = draft.foreignKeys
    .map((foreignKey) => foreignKey.referencedTable)
    .filter((name) => name.length > 0)
    .join("|");
  useEffect(() => {
    for (const name of new Set(refTableSignature.split("|").filter(Boolean))) {
      if (!refTables[name]) {
        void loadRefTable(name);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refTableSignature]);

  const handleRefTableChange = useCallback(
    async (foreignKeyId: string, table: string) => {
      updateForeignKey(foreignKeyId, {
        referencedTable: table,
        referencedColumn: "",
      });
      if (table) {
        const info = await loadRefTable(table);
        if (info?.primaryKey) {
          updateForeignKey(foreignKeyId, {
            referencedColumn: info.primaryKey,
          });
        }
      }
    },
    [loadRefTable, updateForeignKey],
  );

  const handleCreate = useCallback(async () => {
    setSubmitted(true);
    const definition = draftToTableDefinition(draft);
    if (!definition) {
      return;
    }
    const createTabId = activeTabId;
    setCreating(true);
    try {
      await createTable(connectionId, definition);
      toast.success(`Created table ${definition.object.name}`);
      log("success", `Created table ${definition.object.name}`);
      await refreshSchema();
      openTable(definition.object, "definition");
      if (createTabId) {
        closeTab(createTabId);
      }
    } catch (cause) {
      const normalized = toQueryError(cause);
      toast.error(normalized.message);
      reportError(log, `Could not create table ${definition.object.name}`, normalized);
      setCreating(false);
    }
  }, [
    activeTabId,
    closeTab,
    connectionId,
    draft,
    log,
    openTable,
    refreshSchema,
  ]);

  return (
    <section
      aria-label="Create table"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="shrink-0 font-semibold tracking-wide text-muted-foreground uppercase">
          New table
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(createEmptyDraft(createOperationId()));
              setSubmitted(false);
            }}
            disabled={creating}
          >
            <RefreshCwIcon />
            Reset
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating}
            data-testid="create-table"
          >
            <CheckIcon />
            {creating ? "Creating…" : "Create table"}
          </Button>
        </div>
      </header>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={68} minSize={30} className="min-h-0">
          <div className="h-full overflow-auto p-3">
            <div className="flex flex-col gap-5">
              <label className="flex max-w-sm flex-col gap-1">
                {fieldLabel("Table name")}
                <Input
                  aria-label="Table name"
                  value={draft.name}
                  spellCheck={false}
                  className={inputClass("h-8 text-xs")}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                {showErrors && validation.tableName ? (
                  <span role="alert" className="text-[11px] text-destructive">
                    {validation.tableName}
                  </span>
                ) : null}
              </label>

              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Columns
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {draft.columns.length}
                  </span>
                </div>

                <div
                  className={cn(
                    GRID_COLUMNS,
                    "px-1 text-[10px] tracking-wide text-muted-foreground uppercase",
                  )}
                >
                  <span>Name</span>
                  <span>Type</span>
                  <span className="text-center">Null</span>
                  <span className="text-center">PK</span>
                  <span>Default</span>
                  <span />
                </div>

                <div className="flex flex-col">
                  {draft.columns.map((column) => {
                    const columnError = validation.columns[column.id];
                    return (
                      <div
                        key={column.id}
                        className="border-t border-border/60 py-1"
                      >
                        <div className={GRID_COLUMNS}>
                          <Input
                            aria-label={`Column ${column.id} name`}
                            value={column.name}
                            spellCheck={false}
                            className={inputClass()}
                            onChange={(event) =>
                              updateColumn(column.id, {
                                name: event.target.value,
                              })
                            }
                          />
                          <Select
                            value={column.typeName}
                            onValueChange={(value) =>
                              updateColumn(column.id, { typeName: value })
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`Column ${column.id} type`}
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
                              aria-label={`Column ${column.id} nullable`}
                              checked={column.nullable}
                              onCheckedChange={(checked) =>
                                updateColumn(column.id, {
                                  nullable: checked === true,
                                })
                              }
                            />
                          </span>
                          <span className="flex justify-center">
                            <Checkbox
                              aria-label={`Column ${column.id} primary key`}
                              checked={column.primaryKey}
                              onCheckedChange={() => setPrimaryKey(column.id)}
                            />
                          </span>
                          <Input
                            aria-label={`Column ${column.id} default`}
                            value={column.default}
                            spellCheck={false}
                            placeholder="(none)"
                            className={inputClass()}
                            onChange={(event) =>
                              updateColumn(column.id, {
                                default: event.target.value,
                              })
                            }
                          />
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="justify-self-center text-muted-foreground hover:text-destructive"
                            aria-label={`Remove column ${column.id}`}
                            onClick={() => removeColumn(column.id)}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                        {showErrors && columnError ? (
                          <span
                            role="alert"
                            className="mt-0.5 block text-[10px] text-destructive"
                          >
                            {columnError}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {draft.columns.length === 0 ? (
                    <p className="border-t border-border/60 py-3 text-center text-[11px] text-muted-foreground">
                      No columns yet.
                    </p>
                  ) : null}
                </div>

                <div>
                  <Button size="sm" variant="outline" onClick={addColumn}>
                    <PlusIcon />
                    Add column
                  </Button>
                </div>
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      Foreign keys
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {draft.foreignKeys.length}
                    </span>
                  </div>
                  <Button size="sm" variant="outline" onClick={addForeignKey}>
                    <PlusIcon />
                    Add foreign key
                  </Button>
                </div>

                {draft.foreignKeys.length === 0 ? (
                  <p className="py-1 text-[11px] text-muted-foreground">
                    No foreign keys.
                  </p>
                ) : (
                  draft.foreignKeys.map((foreignKey) => {
                    const foreignKeyError =
                      validation.foreignKeys[foreignKey.id];
                    const refInfo = refTables[foreignKey.referencedTable];
                    const refColumnOptions = refInfo?.columns ?? [];
                    const includeCurrent =
                      foreignKey.referencedColumn.length > 0 &&
                      !refColumnOptions.includes(foreignKey.referencedColumn);
                    return (
                      <div
                        key={foreignKey.id}
                        className="flex flex-col gap-1 border-t border-border/60 py-2"
                      >
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="flex flex-col gap-1">
                            {fieldLabel("Local column")}
                            <Select
                              value={foreignKey.column === "" ? NONE : foreignKey.column}
                              onValueChange={(value) =>
                                updateForeignKey(foreignKey.id, {
                                  column: value === NONE ? "" : value,
                                })
                              }
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label={`Foreign key ${foreignKey.id} local column`}
                                className="h-7 w-40 font-mono text-[11px]"
                              >
                                <SelectValue placeholder="-" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NONE}>-</SelectItem>
                                {draft.columns
                                  .filter(
                                    (column) => column.name.trim().length > 0,
                                  )
                                  .map((column) => (
                                    <SelectItem
                                      key={column.id}
                                      value={column.name.trim()}
                                    >
                                      {column.name.trim()}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </label>
                          <label className="flex flex-col gap-1">
                            {fieldLabel("References table")}
                            <Select
                              value={
                                foreignKey.referencedTable === ""
                                  ? NONE
                                  : foreignKey.referencedTable
                              }
                              onValueChange={(value) =>
                                void handleRefTableChange(
                                  foreignKey.id,
                                  value === NONE ? "" : value,
                                )
                              }
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label={`Foreign key ${foreignKey.id} referenced table`}
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
                                {foreignKey.referencedTable &&
                                !tableOptions.some(
                                  (table) =>
                                    table.name === foreignKey.referencedTable,
                                ) ? (
                                  <SelectItem value={foreignKey.referencedTable}>
                                    {foreignKey.referencedTable}
                                  </SelectItem>
                                ) : null}
                              </SelectContent>
                            </Select>
                          </label>
                          <label className="flex flex-col gap-1">
                            {fieldLabel("References column")}
                            <Select
                              value={
                                foreignKey.referencedColumn === ""
                                  ? NONE
                                  : foreignKey.referencedColumn
                              }
                              onValueChange={(value) =>
                                updateForeignKey(foreignKey.id, {
                                  referencedColumn: value === NONE ? "" : value,
                                })
                              }
                              disabled={refColumnOptions.length === 0}
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label={`Foreign key ${foreignKey.id} referenced column`}
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
                                {includeCurrent ? (
                                  <SelectItem value={foreignKey.referencedColumn}>
                                    {foreignKey.referencedColumn}
                                  </SelectItem>
                                ) : null}
                              </SelectContent>
                            </Select>
                          </label>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="mb-0.5 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove foreign key ${foreignKey.id}`}
                            onClick={() => removeForeignKey(foreignKey.id)}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="flex flex-col gap-1">
                            {fieldLabel("Reference schema")}
                            <Input
                              aria-label={`Foreign key ${foreignKey.id} referenced schema`}
                              value={foreignKey.referencedSchema}
                              spellCheck={false}
                              placeholder="(none)"
                              className={inputClass("w-28")}
                              onChange={(event) =>
                                updateForeignKey(foreignKey.id, {
                                  referencedSchema: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            {fieldLabel("Constraint name")}
                            <Input
                              aria-label={`Foreign key ${foreignKey.id} name`}
                              value={foreignKey.name}
                              spellCheck={false}
                              placeholder="(generated)"
                              className={inputClass("w-48")}
                              onChange={(event) =>
                                updateForeignKey(foreignKey.id, {
                                  name: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                        {showErrors && foreignKeyError ? (
                          <span
                            role="alert"
                            className="text-[10px] text-destructive"
                          >
                            {foreignKeyError}
                          </span>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </section>

              {showErrors && validation.form.length > 0 ? (
                <ul
                  role="alert"
                  className="flex flex-col gap-0.5 text-[11px] text-destructive"
                >
                  {validation.form.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
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
              statements={[preview]}
              emptyLabel="Define a table to preview it."
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}
