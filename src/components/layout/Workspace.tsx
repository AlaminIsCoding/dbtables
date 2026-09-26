import {
  DatabaseIcon,
  LayersIcon,
  ListIcon,
  PlusIcon,
  SquarePenIcon,
  TableIcon,
  TerminalIcon,
} from "lucide-react";

import { useWorkspace } from "@/app/store";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { CreateTableTabView, DefinitionTabView, IndexTabView } from "@/features/schema";
import { QueryTabView } from "@/features/query";
import { TableTabView } from "@/features/table-data";
import {
  qualifiedObjectName,
  type TableSubTab,
  type WorkspaceTab,
} from "@/lib/workspace/tabs";
import { cn } from "@/lib/utils";

import { MessagesDrawer } from "./MessagesDrawer";
import { TabBar } from "./TabBar";

export interface WorkspaceProps {
  className?: string;
}

/** Main workspace: tab strip plus the active tab's content. */
export function Workspace({ className }: WorkspaceProps) {
  const { activeTab, connectionId, updateTab } = useWorkspace();

  return (
    <main
      aria-label="Workspace"
      className={cn(
        "relative flex min-w-0 flex-1 flex-col bg-background",
        className,
      )}
    >
      <TabBar />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab ? (
          <TabBody
            tab={activeTab}
            connectionId={connectionId}
            onSubChange={(sub) => updateTab(activeTab.id, { sub })}
            onSqlChange={(sql) => updateTab(activeTab.id, { sql })}
            onExecuted={(sql) => updateTab(activeTab.id, { sql, lastRunSql: sql })}
            onFocusFilterConsumed={() =>
              updateTab(activeTab.id, { focusFilter: undefined })
            }
          />
        ) : (
          <Welcome />
        )}
        <MessagesDrawer />
      </div>
    </main>
  );
}

function TabBody({
  tab,
  connectionId,
  onSubChange,
  onSqlChange,
  onExecuted,
  onFocusFilterConsumed,
}: {
  tab: WorkspaceTab;
  connectionId: string | null;
  onSubChange: (sub: TableSubTab) => void;
  onSqlChange: (sql: string) => void;
  onExecuted: (sql: string) => void;
  onFocusFilterConsumed: () => void;
}) {
  if (tab.kind === "query") {
    return (
      <QueryTabView
        connectionId={connectionId}
        sql={tab.sql}
        onSqlChange={onSqlChange}
        onExecuted={onExecuted}
      />
    );
  }

  if (tab.kind === "create-table") {
    return connectionId ? (
      <CreateTableTabView connectionId={connectionId} />
    ) : (
      <Disconnected />
    );
  }

  if (!connectionId) {
    return <Disconnected />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <span className="truncate font-mono text-xs">
          {qualifiedObjectName(tab.object)}
        </span>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
          {tab.object.kind}
        </span>
      </div>
      <SubTabs sub={tab.sub} onChange={onSubChange} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab.sub === "data" ? (
          <TableTabView
            connectionId={connectionId}
            object={tab.object}
            focusFilter={tab.focusFilter}
            onFocusFilterConsumed={onFocusFilterConsumed}
          />
        ) : tab.sub === "definition" ? (
          <DefinitionTabView connectionId={connectionId} object={tab.object} />
        ) : (
          <IndexTabView connectionId={connectionId} object={tab.object} />
        )}
      </div>
    </div>
  );
}

function SubTabs({
  sub,
  onChange,
}: {
  sub: TableSubTab;
  onChange: (sub: TableSubTab) => void;
}) {
  const items: { id: TableSubTab; label: string; Icon: typeof TableIcon }[] = [
    { id: "data", label: "Data", Icon: TableIcon },
    { id: "definition", label: "Definition", Icon: ListIcon },
    { id: "index", label: "Indexes", Icon: LayersIcon },
  ];
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-0.5 border-b border-border bg-background px-2.5">
      {items.map(({ id, label, Icon }) => {
        const active = sub === id;
        return (
          <button
            key={id}
            type="button"
            data-active={active}
            onClick={() => onChange(id)}
            className={
              "inline-flex h-6 items-center gap-1.5 rounded-[4px] px-2.5 text-xs font-medium transition-colors " +
              (active
                ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")
            }
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Welcome() {
  const { connectionId, openQuery, openCreateTable } = useWorkspace();
  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <DatabaseIcon />
        </EmptyMedia>
        <EmptyTitle>
          {connectionId ? "Select a table" : "No database open"}
        </EmptyTitle>
        <EmptyDescription>
          {connectionId
            ? "Pick an object from the sidebar, or start a new SQL query."
            : "Open a database from the top bar to browse tables and run queries."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => openQuery()}>
            <TerminalIcon />
            New query
          </Button>
          {connectionId ? (
            <Button variant="outline" size="sm" onClick={openCreateTable}>
              <PlusIcon />
              Create table
            </Button>
          ) : null}
        </div>
      </EmptyContent>
    </Empty>
  );
}

function Disconnected() {
  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquarePenIcon />
        </EmptyMedia>
        <EmptyTitle>No active connection</EmptyTitle>
        <EmptyDescription>
          Open a database from the top bar to use this tab.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
