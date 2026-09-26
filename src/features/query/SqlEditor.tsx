import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

import { cn } from "../../components/ui/cn";

export interface SqlEditorProps {
  /** Controlled SQL text. External changes replace the whole document. */
  value: string;
  /** Called with the full document whenever the user edits the text. */
  onChange: (value: string) => void;
  /** Called for `Ctrl`/`Cmd` + `Enter` while the editor has focus. */
  onRun?: () => void;
  /** Accessible name for the editor surface. */
  ariaLabel?: string;
  className?: string;
}

/**
 * CodeMirror 6 SQL editor.
 *
 * The view is created once and kept for the component's lifetime; React only
 * feeds it the controlled `value` and receives edits through `onChange`. The
 * custom keymap binds `Ctrl`/`Cmd` + `Enter` to run without a mouse, and the
 * editor theme reads the app's CSS variables so it follows light/dark tokens.
 */
export function SqlEditor({
  value,
  onChange,
  onRun,
  ariaLabel = "SQL editor",
  className,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);

  // Keep the latest callbacks without recreating the editor view.
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return;
    }

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        sql(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Highest precedence so the run shortcut cannot be swallowed by the
        // default keymaps.
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onRunRef.current?.();
                return true;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
          "aria-multiline": "true",
          spellcheck: "false",
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            color: "var(--foreground)",
            backgroundColor: "var(--background)",
            fontSize: "0.75rem",
          },
          ".cm-scroller": {
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            lineHeight: "1.5",
          },
          ".cm-content": { padding: "0.5rem 0" },
          ".cm-gutters": {
            backgroundColor: "var(--muted)",
            color: "var(--muted-foreground)",
            border: "none",
          },
          ".cm-activeLine": { backgroundColor: "var(--accent)" },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--accent)",
            color: "var(--accent-foreground)",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--foreground)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "var(--ring)",
            opacity: "0.35",
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is mounted once; controlled `value` changes are pushed in the
    // effect below and `ariaLabel` is intentionally fixed at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external value changes (for example, switching query tabs) into the
  // document without echoing an edit back through `onChange`.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      data-testid="sql-editor"
      className={cn(
        "min-h-24 overflow-hidden rounded-md border border-input focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    />
  );
}
