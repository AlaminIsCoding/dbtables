import { useRef } from "react";
import { PlugZapIcon, PlayIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ResultsPanel } from "../results";
import { SqlEditor, type SqlEditorSelection } from "./SqlEditor";
import { hasExecutableStatement, resolveRunSql } from "./statement";
import { useQuerySession, type QuerySession } from "./useQuerySession";

export interface QueryTabViewProps {
  connectionId: string | null;
  sql: string;
  onSqlChange: (sql: string) => void;
  onExecuted: (sql: string) => void;
}

function EditorPanel({
  session,
  connectionId,
  sql,
  onSqlChange,
  onExecuted,
}: {
  session: QuerySession;
  connectionId: string | null;
  sql: string;
  onSqlChange: (sql: string) => void;
  onExecuted: (sql: string) => void;
}) {
  const selectionRef = useRef<SqlEditorSelection>({
    selectedText: "",
    cursor: 0,
  });

  const connected = connectionId !== null;
  const hasStatement = hasExecutableStatement(sql);
  const canRun = session.canRun && hasStatement;

  async function execute(statement: string) {
    const outcome = await session.runQuery(statement);
    if (!outcome) {
      return;
    }

    switch (outcome.kind) {
      case "failed":
      case "error":
        toast.error(outcome.error.message);
        return;
      case "outcome_unknown":
        toast.error(outcome.error?.message ?? "The query outcome is unknown.");
        return;
      case "grid":
      case "partial":
      case "empty":
      case "statement":
        // A confirmed terminal success is the only path that clears the tab's
        // unsaved marker. The tab's full text is reported, not the resolved
        // statement, so running a cursor statement never truncates the editor.
        onExecuted(sql);
        return;
      default:
        return;
    }
  }

  function run(selection?: SqlEditorSelection) {
    if (!session.canRun) {
      return;
    }

    const context = selection ?? selectionRef.current;
    const resolved = resolveRunSql(sql, context.selectedText, context.cursor);
    if (resolved.sql.length === 0) {
      // The cursor is not inside an executable statement and nothing is
      // selected: surface the blank-statement validation instead of executing
      // unrelated text.
      void execute("");
      return;
    }

    void execute(resolved.sql);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="font-mono text-[10.5px] tracking-wide text-muted-foreground uppercase">
          SQL editor
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {connected ? "connected" : "no database"}
        </span>
        <div className="flex-1" />
        <span className="kbd">Ctrl</span>
        <span className="text-[10px] text-muted-foreground">+</span>
        <span className="kbd">Enter</span>
        <Button
          size="sm"
          onClick={() => run()}
          disabled={!canRun}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          className="ml-1"
        >
          <PlayIcon />
          {session.isRunning ? "Running…" : "Run"}
        </Button>
      </div>

      {!connected ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          <PlugZapIcon className="size-3.5 shrink-0" />
          <span>No active connection. Open a database to run queries.</span>
        </div>
      ) : null}

      {session.notice ? (
        <p
          role="alert"
          className="shrink-0 border-b border-border bg-destructive/10 px-3 py-1 text-[11px] text-destructive"
        >
          {session.notice}
        </p>
      ) : null}

      <SqlEditor
        value={sql}
        onChange={onSqlChange}
        onRun={(selection) => run(selection)}
        onSelectionChange={(selection) => {
          selectionRef.current = selection;
        }}
        className="min-h-0 flex-1"
      />
    </div>
  );
}

/**
 * SQL editor tab bound to the workspace's single active connection.
 *
 * The connection is supplied by the app store as an opaque `connectionId`; this
 * view never opens a connection of its own. The editor is a flat, full-bleed
 * CodeMirror surface under a compact header; `Run` (Ctrl/Cmd+Enter) executes the
 * selection or the statement at the cursor, and a confirmed success calls
 * `onExecuted` so the tab's dirty marker clears. The editor and results share a
 * vertically resizable split.
 */
export function QueryTabView({
  connectionId,
  sql,
  onSqlChange,
  onExecuted,
}: QueryTabViewProps) {
  const session = useQuerySession({ connectionId });

  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={45} minSize={15} className="min-h-0">
        <EditorPanel
          session={session}
          connectionId={connectionId}
          sql={sql}
          onSqlChange={onSqlChange}
          onExecuted={onExecuted}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={55} minSize={20} className="min-h-0">
        <ResultsPanel
          outcome={session.outcome}
          canFetchMore={session.canFetchMore}
          fetchingMore={session.isFetchingMore}
          onFetchMore={() => {
            void session.fetchMore();
          }}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
