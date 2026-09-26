import { EyeIcon, PlusIcon, SquarePenIcon, TableIcon, TerminalIcon, XIcon } from "lucide-react";

import { useWorkspace } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { qualifiedObjectName } from "@/lib/workspace/tabs";

/** Tab strip for the workspace: table, query, and create-table tabs. */
export function TabBar() {
  const { tabs, activeTabId, selectTab, closeTab, openQuery } = useWorkspace();

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/40">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title =
            tab.kind === "query"
              ? tab.title
              : tab.kind === "create-table"
                ? "New table"
                : qualifiedObjectName(tab.object);
          const Icon =
            tab.kind === "query"
              ? TerminalIcon
              : tab.kind === "create-table"
                ? SquarePenIcon
                : tab.object.kind === "view"
                  ? EyeIcon
                  : TableIcon;
          const dirty = tab.kind === "query" && tab.sql !== tab.lastRunSql;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              className={
                "group flex max-w-56 shrink-0 items-center gap-1 border-r border-border pl-2.5 text-xs " +
                (active
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-accent/50")
              }
            >
              <button
                type="button"
                onClick={() => selectTab(tab.id)}
                className="flex min-w-0 items-center gap-1.5 py-2"
              >
                <Icon
                  className={
                    "size-3.5 shrink-0 " + (active ? "text-primary" : "")
                  }
                />
                <span className="truncate">{title}</span>
                {dirty ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                ) : null}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="mr-0.5 opacity-0 group-hover:opacity-100 aria-expanded:opacity-100"
                onClick={() => closeTab(tab.id)}
                aria-label={`Close ${title}`}
              >
                <XIcon />
              </Button>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center px-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => openQuery()}
              aria-label="New query tab"
            >
              <PlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New query</TooltipContent>
        </Tooltip>
        <SquarePenIcon className="hidden" />
      </div>
    </div>
  );
}
