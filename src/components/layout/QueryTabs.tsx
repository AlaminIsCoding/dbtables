import { useQueryTabs } from "../../features/query";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { EditorResultsSplit } from "./EditorResultsSplit";

export interface QueryTabsProps {
  className?: string;
}

/**
 * Stateful query-tab strip.
 *
 * Owns which editor tabs exist and each tab's editor text/dirty state (through
 * {@link useQueryTabs}); the per-tab workspace owns connection and execution
 * state. The "+" control opens a new tab and each non-last tab can be closed.
 */
export function QueryTabs({ className }: QueryTabsProps) {
  const tabs = useQueryTabs();

  return (
    <Tabs
      value={tabs.activeId}
      onValueChange={tabs.selectTab}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-1">
        <TabsList aria-label="Query tabs" className="min-w-0 overflow-x-auto">
          {tabs.tabs.map((tab) => {
            const dirty = tabs.isDirty(tab.id);
            return (
              <div key={tab.id} className="flex items-center">
                <TabsTrigger value={tab.id}>
                  <span>{tab.label}</span>
                  {dirty ? (
                    <span
                      aria-label="Unsaved changes"
                      title="Unsaved changes"
                      className="ml-1 text-[10px] text-primary"
                    >
                      ●
                    </span>
                  ) : null}
                </TabsTrigger>
                {tabs.canClose ? (
                  <button
                    type="button"
                    aria-label={`Close ${tab.label}`}
                    onClick={() => tabs.closeTab(tab.id)}
                    className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            );
          })}
        </TabsList>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New query tab"
          title="New query tab"
          onClick={tabs.addTab}
        >
          +
        </Button>
      </div>

      {tabs.tabs.map((tab) => (
        <TabsContent
          key={tab.id}
          value={tab.id}
          className="flex min-h-0 flex-1"
        >
          <EditorResultsSplit
            label={tab.label}
            sql={tab.sql}
            dirty={tabs.isDirty(tab.id)}
            onSqlChange={(sql) => tabs.setSql(tab.id, sql)}
            onExecuted={(sql) => tabs.markRun(tab.id, sql)}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
