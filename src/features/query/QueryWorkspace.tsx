import { useId, useState } from "react";

import { SplitPane } from "../../components/layout/SplitPane";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { ObjectRef } from "../../domain";
import { ResultsPanel } from "../results";
import { selectStatementFor } from "./objectStatement";
import {
  useQuerySession,
  type ConnectionStatus,
  type ObjectListState,
  type QuerySession,
} from "./useQuerySession";

export interface QueryWorkspaceProps {
  /** Query-tab label, shown in the editor header. */
  label: string;
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

function EditorPane({ session, label }: { session: QuerySession; label: string }) {
  const [filePath, setFilePath] = useState("");
  const baseId = useId();
  const filePathId = `${baseId}-file-path`;
  const sqlId = `${baseId}-sql`;
  const { connection } = session;
  const connected = connection.status === "connected";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2 text-[11px] text-muted-foreground">
        <span>SQL editor · {label}</span>
        <span>Read-only</span>
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
            role="status"
            aria-live="polite"
            className={cn(
              "truncate text-[11px]",
              connection.status === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {describeConnection(connection)}
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
              onPick={(object) => session.setSql(selectStatementFor(object))}
            />
          </div>
        </div>

        <label htmlFor={sqlId} className="text-[11px] font-medium">
          SQL
        </label>
        <textarea
          id={sqlId}
          aria-label="SQL editor"
          value={session.sql}
          onChange={(event) => session.setSql(event.target.value)}
          rows={6}
          spellCheck={false}
          placeholder="SELECT * FROM table_name;"
          className="min-h-24 w-full resize-y rounded-md border border-input bg-background p-2 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        <div className="flex items-center justify-between gap-2">
          <Button
            onClick={() => {
              void session.runQuery();
            }}
            disabled={!session.canRun}
          >
            {session.isRunning ? "Running…" : "Run"}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Results are capped for responsiveness.
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Query tab workspace: SQLite connection controls, object list, SQL editor, and
 * the results pane, all driven by {@link useQuerySession}.
 */
export function QueryWorkspace({ label, className }: QueryWorkspaceProps) {
  const session = useQuerySession();

  return (
    <SplitPane
      className={className}
      start={<EditorPane session={session} label={label} />}
      end={<ResultsPanel outcome={session.outcome} />}
      startLabel="Editor"
      endLabel="Results"
    />
  );
}
