import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  EyeIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TableIcon,
  TerminalIcon,
  Trash2Icon,
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
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ObjectRef } from "@/domain";
import { reportError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { qualifiedObjectName } from "@/lib/workspace/tabs";
import { toQueryError } from "@/services/errors";
import { dropTable } from "@/services/schema";

export interface SidebarProps {
  className?: string;
  /** When true the sidebar animates to zero width and becomes inert. */
  collapsed?: boolean;
}

/** Explorer sidebar: schema sections, search, and per-object actions. */
export function Sidebar({ className, collapsed = false }: SidebarProps) {
  const {
    connectionId,
    schema,
    rowCounts,
    refreshSchema,
    openTable,
    openQuery,
    closeTabsForObject,
    log,
  } = useWorkspace();
  const [filter, setFilter] = useState("");
  const [pendingDrop, setPendingDrop] = useState<ObjectRef | null>(null);
  const [dropping, setDropping] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<
    Record<string, boolean>
  >({});

  const toggleSection = (key: string) =>
    setCollapsedSections((current) => ({
      ...current,
      [key]: !current[key],
    }));

  const tables = schema.status === "ready" ? schema.tables : [];
  const views = schema.status === "ready" ? schema.views : [];

  const query = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      (objects: ObjectRef[]) =>
        query.length === 0
          ? objects
          : objects.filter((object) =>
              object.name.toLowerCase().includes(query),
            ),
    [query],
  );

  const filteredTables = matches(tables);
  const filteredViews = matches(views);

  const handleDrop = async () => {
    if (!pendingDrop || !connectionId) {
      return;
    }
    setDropping(true);
    try {
      await dropTable(connectionId, pendingDrop);
      toast.success(`Dropped ${qualifiedObjectName(pendingDrop)}`);
      log("warning", `Dropped table ${qualifiedObjectName(pendingDrop)}`);
      closeTabsForObject(pendingDrop);
      setPendingDrop(null);
      await refreshSchema();
    } catch (error) {
      const normalized = toQueryError(error);
      toast.error(normalized.message);
      reportError(
        log,
        `Could not drop table ${qualifiedObjectName(pendingDrop)}`,
        normalized,
      );
    } finally {
      setDropping(false);
    }
  };

  return (
    <aside
      aria-label="Workspace navigation"
      aria-hidden={collapsed || undefined}
      inert={collapsed || undefined}
      className={cn(
        "sidebar-anim flex shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
        collapsed
          ? "pointer-events-none w-0 border-r-0 opacity-0"
          : "w-64 border-r border-sidebar-border opacity-100",
        className,
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <span className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">
          Schema
        </span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void refreshSchema()}
              disabled={!connectionId}
              aria-label="Refresh schema"
            >
              <RefreshCwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh schema</TooltipContent>
        </Tooltip>
        <CreateMenu>
          <Button variant="ghost" size="icon-xs" aria-label="Create">
            <PlusIcon />
          </Button>
        </CreateMenu>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search schema…"
            className="h-7 pl-7 text-xs"
            disabled={!connectionId}
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {connectionId === null ? (
          <p className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            No database open.
            <br />
            Use <span className="font-medium">Open database</span> to connect.
          </p>
        ) : schema.status === "loading" ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Loading schema…
          </p>
        ) : schema.status === "error" ? (
          <p className="px-3 py-6 text-center text-xs text-destructive">
            {schema.error.message}
          </p>
        ) : (
          <div className="flex flex-col gap-1 px-1.5 pb-2">
            <SchemaSection
              label="Tables"
              count={filteredTables.length}
              collapsed={Boolean(collapsedSections.tables)}
              onToggle={() => toggleSection("tables")}
            >
              {filteredTables.map((object) => (
                <SchemaItem
                  key={qualifiedObjectName(object)}
                  object={object}
                  count={rowCounts[object.name]}
                  onOpen={openTable}
                  onQuery={openQuery}
                  onDrop={setPendingDrop}
                />
              ))}
            </SchemaSection>
            <SchemaSection
              label="Views"
              count={filteredViews.length}
              collapsed={Boolean(collapsedSections.views)}
              onToggle={() => toggleSection("views")}
            >
              {filteredViews.map((object) => (
                <SchemaItem
                  key={qualifiedObjectName(object)}
                  object={object}
                  onOpen={openTable}
                  onQuery={openQuery}
                  onDrop={setPendingDrop}
                />
              ))}
            </SchemaSection>
          </div>
        )}
      </ScrollArea>

      <div className="flex shrink-0 justify-center p-2">
        <CreateMenu align="start">
          <Button variant="outline" size="sm" className="justify-center">
            <PlusIcon />
            Add
          </Button>
        </CreateMenu>
      </div>

      <AlertDialog
        open={pendingDrop !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDrop(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Drop table</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently drop{" "}
              <span className="font-mono">
                {pendingDrop ? qualifiedObjectName(pendingDrop) : ""}
              </span>
              ? All rows and column definitions are removed. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dropping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDrop();
              }}
              disabled={dropping}
            >
              {dropping ? "Dropping…" : "Drop table"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

function SchemaSection({
  label,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1.5 rounded-md px-2 pt-2 pb-1 text-left text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
        />
        <span>{label}</span>
        <span className="tabular-nums opacity-70">{count}</span>
      </button>
      {collapsed ? null : count === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">None</p>
      ) : (
        <div className="flex flex-col gap-0.5">{children}</div>
      )}
    </section>
  );
}

function SchemaItem({
  object,
  count,
  onOpen,
  onQuery,
  onDrop,
}: {
  object: ObjectRef;
  count?: number;
  onOpen: (object: ObjectRef, sub?: "data" | "definition" | "index") => void;
  onQuery: (sql?: string) => void;
  onDrop: (object: ObjectRef) => void;
}) {
  const isTable = object.kind === "table";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen(object, "data")}
          onDoubleClick={() => onOpen(object, "data")}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {isTable ? (
            <TableIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <EyeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate font-mono text-[11px]">
            {object.name}
          </span>
          {typeof count === "number" ? (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {count.toLocaleString()}
            </span>
          ) : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onOpen(object, "data")}>
          Open data
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpen(object, "definition")}>
          Open definition
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpen(object, "index")}>
          Open indexes
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onQuery(`SELECT * FROM "${object.name}" LIMIT 100;`)}
        >
          <TerminalIcon />
          New query on this object
        </ContextMenuItem>
        {isTable ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDrop(object)}>
              <Trash2Icon />
              Drop table…
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Shared "create" dropdown, used by the header and the footer Add button. */
function CreateMenu({
  children,
  align = "end",
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  const { openCreateTable, openQuery } = useWorkspace();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <DropdownMenuItem onSelect={() => openCreateTable()}>
          <TableIcon />
          New table
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openQuery()}>
          <TerminalIcon />
          New SQL query
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <EyeIcon />
          New view
          <DropdownMenuShortcut>soon</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
