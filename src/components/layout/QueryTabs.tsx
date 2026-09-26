import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { EditorResultsSplit } from "./EditorResultsSplit";

export interface QueryTabsProps {
  className?: string;
}

const QUERY_TABS = ["Query 1", "Query 2"] as const;

/** Placeholder query-tab strip wired to the editor/results split. */
export function QueryTabs({ className }: QueryTabsProps) {
  return (
    <Tabs
      defaultValue="query-1"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-1">
        <TabsList aria-label="Query tabs" className="min-w-0 overflow-x-auto">
          {QUERY_TABS.map((label, index) => (
            <TabsTrigger key={label} value={`query-${index + 1}`}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <Button
          variant="ghost"
          size="icon"
          aria-label="New query tab"
          disabled
          title="Multiple query tabs arrive in a later milestone."
        >
          +
        </Button>
      </div>

      {QUERY_TABS.map((label, index) => (
        <TabsContent
          key={label}
          value={`query-${index + 1}`}
          className="flex min-h-0 flex-1"
        >
          <EditorResultsSplit label={label} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
