import { SplitPane } from "./SplitPane";

interface EditorResultsSplitProps {
  /** Query-tab label shown in the editor placeholder. */
  label: string;
}

function EditorPane({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2 text-[11px] text-muted-foreground">
        <span>SQL editor</span>
        <span>Read-only placeholder</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <p className="text-xs text-muted-foreground">
          CodeMirror integration arrives in a later milestone.
        </p>
        <pre className="mt-2 rounded-md border border-border bg-muted/40 p-2 font-mono text-xs leading-5 text-foreground/80">
          {`-- ${label}\nselect * from example_table;`}
        </pre>
      </div>
    </div>
  );
}

function ResultsPane() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2 text-[11px] text-muted-foreground">
        <span>Results</span>
        <span>0 rows</span>
      </div>
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm font-medium">No results yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            Run a query to see rows. The Glide grid prototype is the next task.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Editor-over-results split used by each query tab placeholder. */
export function EditorResultsSplit({ label }: EditorResultsSplitProps) {
  return (
    <SplitPane
      start={<EditorPane label={label} />}
      end={<ResultsPane />}
      startLabel="Editor"
      endLabel="Results"
    />
  );
}
