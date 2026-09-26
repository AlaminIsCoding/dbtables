import { useId, useRef, useState } from "react";

import { SplitPane } from "../../components/layout/SplitPane";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { ObjectRef } from "../../domain";
import { ResultsPanel } from "../results";
import { selectStatementFor } from "./objectStatement";
import type { QueryHistoryEntry } from "./queryHistory";
import { describeQueryStatus, formatQueryStatus } from "./queryStatus";
import { SqlEditor, type SqlEditorSelection } from "./SqlEditor";
import { hasExecutableStatement, resolveRunSql } from "./statement";
import {
  useQuerySession,
  type ConnectionStatus,
  type ObjectListState,
  type QuerySession,
} from "./useQuerySession";

export interface QueryWorkspaceProps {
  /** Query-tab label, shown in the editor header. */
  label: string;
  /** Controlled SQL text for this tab. */
  sql: string;
  /** Replaces this tab's SQL text. */
  onSqlChange: (sql: string) => void;
  /** Whether this tab has edits that have not been executed. */
  dirty?: boolean;
  /** Called with the executed text when a run is started. */
  onExecuted?: (sql: string) => void;
  className?: string;
}

function describeConnection(connection: ConnectionStatus): string {
  switch (connection.status) {
    case "disconnected":
      return "Not connected";
    case "connecting":
      return "Connecting…";
    case "connected":
      return connection.filePath;
    case "error":
      return connection.error.message;
  }
}

const EMPTY_OBJECTS: ObjectListState = { status: "ready", objects: [] };

function ObjectList({
  state,
  disabled,
  onPick,
}: {
  state: ObjectListState;
  disabled: boolean;
  onPick: (object: ObjectRef) => void;
}) {
  if (state.status === "loading") {
    return (
      <p className="px-1 py-1 text-[11px] text-muted-foreground">
        Loading objects…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="px-1 py-1 text-[11px] text-destructive">
        {state.error.message}
      </p>
    );
  }

  if (state.objects.length === 0) {
    return (
      <p className="px-1 py-1 text-[11px] text-muted-foreground">
        No tables or views.
      </p>
    );
  }

  return (
    <ul aria-label="Database objects" className="flex flex-col gap-0.5">
      {state.objects.map((object) => (
        <li key={`${object.kind}:${object.name}`}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(object)}
            className="flex w-full items-center justify-between gap-2 rounded-sm px-1.5 py-0.5 text-left text-xs hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="truncate">{object.name}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {object.kind}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function HistoryList({
  entries,
  onPick,
  onClear,
}: {
  entries: QueryHistoryEntry[];
  onPick: (entry: QueryHistoryEntry) => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
        <span>Recent queries</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[10px]"
          onClick={onClear}
          disabled={entries.length === 0}
        >
          Clear
        </Button>
      </div>
      <div className="max-h-32 overflow-auto p-1">
        {entries.length === 0 ? (
          <p className="px-1 py-1 text-[11px] text-muted-foreground">
            No queries run yet.
          </p>
        ) : (
          <ul aria-label="Recent queries" className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => onPick(entry)}
                  title={entry.sql}
                  className="flex w-full items-center gap-2 rounded-sm px-1.5 py-0.5 text-left text-xs hover:bg-accent"
                >
                  <span
                    className={cn(
                      "w-16 shrink-0 text-[10px] uppercase tracking-wide",
                      entry.state === "succeeded"
                        ? "text-muted-foreground"
                        : "text-destructive",
                    )}
                  >
                    {entry.state}
                  </span>
                  <span className="truncate font-mono text-[11px]">
                    {entry.sql}
                  </span>
                  {entry.durationMs !== undefined ? (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {entry.durationMs} ms
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EditorPane({
  session,
  label,
  sql,
  onSqlChange,
  dirty,
  onExecuted,
}: {
  session: QuerySession;
  label: string;
  sql: string;
  onSqlChange: (sql: string) => void;
  dirty: boolean;
  onExecuted?: (sql: string) => void;
}) {
  const [filePath, setFilePath] = useState("");
  const baseId = useId();
  const filePathId = `${baseId}-file-path`;
  const { connection } = session;
  const connected = connection.status === "connected";
  const hasStatement = hasExecutableStatement(sql);
  const canRun = session.canRun && hasStatement;
  const selectionRef = useRef<SqlEditorSelection>({
    selectedText: "",
    cursor: 0,
  });
  const status = describeQueryStatus(session.outcome);

  function run() {
    if (!session.canRun) {
      return;
    }

    const resolved = resolveRunSql(
      sql,
      selectionRef.current.selectedText,
      selectionRef.current.cursor,
    );
    if (resolved.sql.length === 0) {
      // The cursor is not inside an executable statement and nothing is
      // selected. Surface the blank-statement validation instead of executing
      // unrelated text.
      void session.runQuery("");
      return;
    }

    onExecuted?.(resolved.sql);
    void session.runQuery(resolved.sql);
  }

  const cancelTitle = session.isRunning
    ? session.cancellationSupported
      ? "Cancel the running query"
      : "Cancellation is not supported for this connection"
    : "No query is running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2 text-[11px] text-muted-foreground">
        <span>SQL editor · {label}</span>
        {dirty ? (
          <span role="status" aria-live="polite" className="text-foreground">
            Unsaved changes
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={filePathId} className="text-[11px] font-medium">
            SQLite file
          </label>
          <div className="flex items-center gap-1">
            <input
              id={filePathId}
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              placeholder="C:/path/to/database.sqlite"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              onClick={() => {
                void session.openDatabase(filePath);
              }}
              disabled={connection.status === "connecting"}
            >
              {connection.status === "connecting" ? "Opening…" : "Open"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void session.disconnectDatabase();
              }}
              disabled={!connected && connection.status !== "connecting"}
            >
              Disconnect
            </Button>
          </div>
          <p
            data-testid="query-target"
            role="status"
            aria-live="polite"
            className={cn(
              "truncate text-[11px]",
              connection.status === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            Target: {describeConnection(connection)}
          </p>
        </div>

        <div className="rounded-md border border-border">
          <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
            <span>Tables &amp; views</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => {
                void session.refreshObjects();
              }}
              disabled={!connected}
            >
              Refresh
            </Button>
          </div>
          <div className="max-h-32 overflow-auto p-1">
            <ObjectList
              state={connected ? connection.objects : EMPTY_OBJECTS}
              disabled={!connected}
              onPick={(object) => onSqlChange(selectStatementFor(object))}
            />
          </div>
        </div>

        <span className="text-[11px] font-medium">SQL</span>
        <SqlEditor
          value={sql}
          onChange={onSqlChange}
          onRun={run}
          onSelectionChange={(selection) => {
            selectionRef.current = selection;
          }}
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button
              onClick={run}
              disabled={!canRun}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title="Run selection or current statement (Ctrl/Cmd+Enter)"
            >
              {session.isRunning ? "Running…" : "Run"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void session.cancelRunningQuery();
              }}
              disabled={!session.canCancel || session.cancelRequested}
              title={cancelTitle}
            >
              {session.cancelRequested ? "Cancelling…" : "Cancel"}
            </Button>
          </div>
          <span
            data-testid="query-status"
            role="status"
            aria-live="polite"
            className="text-[11px] text-muted-foreground"
          >
            {formatQueryStatus(status)}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Runs the selected text, or the statement at the cursor · Ctrl/Cmd+Enter
        </p>
        {session.notice ? (
          <p role="alert" className="text-[11px] text-destructive">
            {session.notice}
          </p>
        ) : null}

        <HistoryList
          entries={session.history}
          onPick={(entry) => onSqlChange(entry.sql)}
          onClear={session.clearHistory}
        />
      </div>
    </div>
  );
}

/**
 * Query tab workspace: SQLite connection controls, object list, the CodeMirror
 * SQL editor, and the results pane.
 *
 * Editor text arrives as a controlled prop from the tab strip; connection and
 * query execution state stay in {@link useQuerySession}.
 */
export function QueryWorkspace({
  label,
  sql,
  onSqlChange,
  dirty = false,
  onExecuted,
  className,
}: QueryWorkspaceProps) {
  const session = useQuerySession();

  return (
    <SplitPane
      className={className}
      start={
        <EditorPane
          session={session}
          label={label}
          sql={sql}
          onSqlChange={onSqlChange}
          dirty={dirty}
          onExecuted={onExecuted}
        />
      }
      end={<ResultsPanel outcome={session.outcome} />}
      startLabel="Editor"
      endLabel="Results"
    />
  );
}
