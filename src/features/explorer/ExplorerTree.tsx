import { useId } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { ObjectRef } from "../../domain";
import { qualifiedObjectName, type ExplorerGroup } from "./tree";
import type { ExplorerController } from "./useExplorer";

export interface ExplorerTreeProps {
  /** Explorer controller supplying target, scopes, objects, and selection. */
  controller: ExplorerController;
  className?: string;
}

function ScopePicker({ controller }: { controller: ExplorerController }) {
  const baseId = useId();

  if (controller.scopes.status !== "ready") {
    return null;
  }

  const databases = controller.scopes.listing.databases ?? [];
  const schemas = controller.scopes.listing.schemas ?? [];

  if (databases.length === 0 && schemas.length === 0) {
    return null;
  }

  const selectClass =
    "h-6 min-w-0 flex-1 rounded-md border border-input bg-background px-1 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      {databases.length > 0 ? (
        <label
          htmlFor={`${baseId}-database`}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
        >
          <span className="w-14 shrink-0">Database</span>
          <select
            id={`${baseId}-database`}
            className={selectClass}
            value={controller.scope.database ?? ""}
            onChange={(event) =>
              controller.setScope({
                ...controller.scope,
                database: event.target.value || undefined,
              })
            }
          >
            <option value="">Default</option>
            {databases.map((database) => (
              <option key={database} value={database}>
                {database}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {schemas.length > 0 ? (
        <label
          htmlFor={`${baseId}-schema`}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
        >
          <span className="w-14 shrink-0">Schema</span>
          <select
            id={`${baseId}-schema`}
            className={selectClass}
            value={controller.scope.schema ?? ""}
            onChange={(event) =>
              controller.setScope({
                ...controller.scope,
                schema: event.target.value || undefined,
              })
            }
          >
            <option value="">Default</option>
            {schemas.map((schema) => (
              <option key={schema} value={schema}>
                {schema}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function ObjectButton({
  object,
  selected,
  onSelect,
}: {
  object: ObjectRef;
  selected: boolean;
  onSelect: (object: ObjectRef) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-label={`${qualifiedObjectName(object)} ${object.kind}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(object)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-0.5 text-left text-xs hover:bg-accent",
          selected && "bg-accent",
        )}
      >
        <span className="truncate">{object.name}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {object.kind}
        </span>
      </button>
    </li>
  );
}

function GroupSection({
  group,
  selected,
  onSelect,
}: {
  group: ExplorerGroup;
  selected: ObjectRef | null;
  onSelect: (object: ObjectRef) => void;
}) {
  return (
    <li>
      <p className="px-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {group.label}
      </p>
      {group.objects.length > 0 ? (
        <ul aria-label={group.label} className="flex flex-col gap-0.5">
          {group.objects.map((object) => (
            <ObjectButton
              key={`${group.id}\u0000${object.kind}\u0000${object.name}`}
              object={object}
              selected={selected !== null && sameObject(selected, object)}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
      {group.groups.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {group.groups.map((nested) => (
            <GroupSection
              key={nested.id}
              group={nested}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function sameObject(left: ObjectRef, right: ObjectRef): boolean {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    left.database === right.database &&
    left.schema === right.schema
  );
}

function ObjectTree({ controller }: { controller: ExplorerController }) {
  const { objects } = controller;

  if (objects.status === "idle") {
    return null;
  }

  if (objects.status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="px-3 py-2 text-[11px] text-muted-foreground"
      >
        Loading objects…
      </p>
    );
  }

  if (objects.status === "error") {
    return (
      <p role="alert" className="px-3 py-2 text-[11px] text-destructive">
        {objects.error.message}
      </p>
    );
  }

  if (controller.groups.length === 0) {
    const filtered = controller.filter.trim().length > 0;
    return (
      <p className="px-3 py-2 text-[11px] text-muted-foreground">
        {filtered ? "No objects match the filter." : "No tables or views."}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 py-1">
      {controller.groups.map((group) => (
        <GroupSection
          key={group.id}
          group={group}
          selected={controller.selected}
          onSelect={(object) => controller.select(object)}
        />
      ))}
    </ul>
  );
}

/**
 * Explorer tree: active target status, database/schema scope pickers, an object
 * filter, and the grouped table/view list. Loading, empty, error, and
 * unsupported states are rendered explicitly rather than as an empty success.
 */
export function ExplorerTree({ controller, className }: ExplorerTreeProps) {
  const { target } = controller;
  const connected = target.status === "connected";
  const filterId = useId();

  return (
    <section
      aria-label="Explorer"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Explorer
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          onClick={controller.refresh}
          disabled={!connected}
          aria-label="Refresh objects"
        >
          Refresh
        </Button>
      </div>

      {target.status === "disconnected" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Connect to a database to browse schemas, tables, and views.
        </p>
      ) : target.status === "connecting" ? (
        <p
          role="status"
          aria-live="polite"
          className="px-3 py-2 text-xs text-muted-foreground"
        >
          Connecting…
        </p>
      ) : target.status === "error" ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {target.error.message}
        </p>
      ) : (
        <>
          <ScopePicker controller={controller} />

          <div className="shrink-0 px-3 py-1">
            <label htmlFor={filterId} className="sr-only">
              Filter objects
            </label>
            <input
              id={filterId}
              type="search"
              value={controller.filter}
              onChange={(event) => controller.setFilter(event.target.value)}
              placeholder="Filter objects"
              spellCheck={false}
              className="h-6 w-full rounded-md border border-input bg-background px-2 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {controller.scopes.status === "error" ? (
            <p role="alert" className="px-3 py-1 text-[11px] text-destructive">
              {controller.scopes.error.message}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            <ObjectTree controller={controller} />
          </div>
        </>
      )}
    </section>
  );
}
