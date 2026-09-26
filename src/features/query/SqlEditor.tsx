import { autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import { cn } from "../../components/ui/cn";

/** Selection context handed to the run handler. */
export interface SqlEditorSelection {
  /** Selected text, or an empty string when the cursor has no selection. */
  selectedText: string;
  /** Cursor head offset in the document. */
  cursor: number;
}

export interface SqlEditorProps {
  /** Controlled SQL text. External changes replace the whole document. */
  value: string;
  /** Called with the full document whenever the user edits the text. */
  onChange: (value: string) => void;
  /** Called for `Ctrl`/`Cmd` + `Enter`, with the current selection context. */
  onRun?: (selection: SqlEditorSelection) => void;
  /** Called whenever the cursor or selection changes. */
  onSelectionChange?: (selection: SqlEditorSelection) => void;
  /** Accessible name for the editor surface. */
  ariaLabel?: string;
  className?: string;
}

/**
 * SQL syntax highlighting that reads the app's design tokens, so the editor
 * follows the light/dark theme instead of CodeMirror's built-in palette.
 */
const sqlHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--primary)", fontWeight: "600" },
  { tag: [t.typeName, t.typeOperator, t.standard(t.name)], color: "oklch(0.72 0.15 210)" },
  { tag: [t.string, t.special(t.string), t.character], color: "oklch(0.72 0.17 145)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "oklch(0.68 0.15 300)" },
  {
    tag: [t.lineComment, t.blockComment, t.comment],
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--muted-foreground)" },
  { tag: [t.function(t.variableName), t.labelName, t.propertyName], color: "var(--foreground)" },
  { tag: t.variableName, color: "var(--foreground)" },
  { tag: t.invalid, color: "var(--destructive)" },
]);

/** Reads the primary selection and cursor head from an editor view. */
function readSelection(view: EditorView): SqlEditorSelection {
  const range = view.state.selection.main;
  return {
    selectedText: view.state.sliceDoc(range.from, range.to),
    cursor: range.head,
  };
}

/**
 * CodeMirror 6 SQL editor.
 *
 * The view is created once and kept for the component's lifetime; React only
 * feeds it the controlled `value` and receives edits through `onChange`. The
 * custom keymap binds `Ctrl`/`Cmd` + `Enter` to run without a mouse, keyword and
 * schema completion is enabled through `autocompletion`, and the highlighting
 * plus UI chrome read the app's CSS variables so the editor follows the theme.
 */
export function SqlEditor({
  value,
  onChange,
  onRun,
  onSelectionChange,
  ariaLabel = "SQL editor",
  className,
}: SqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onSelectionChangeRef = useRef(onSelectionChange);

  // Keep the latest callbacks without recreating the editor view.
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  onSelectionChangeRef.current = onSelectionChange;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) {
      return;
    }

    const state = EditorState.create({
      doc: value,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        autocompletion({ activateOnTyping: true }),
        syntaxHighlighting(sqlHighlightStyle),
        sql(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Highest precedence so the run shortcut cannot be swallowed by the
        // default keymaps.
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: (view) => {
                onRunRef.current?.(readSelection(view));
                return true;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            onSelectionChangeRef.current?.(readSelection(update.view));
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
            backgroundColor: "transparent",
            fontSize: "0.78rem",
          },
          ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            lineHeight: "1.65",
            scrollbarWidth: "thin",
            scrollbarColor:
              "color-mix(in oklch, var(--muted-foreground) 35%, transparent) transparent",
          },
          ".cm-content": { padding: "0.75rem 0.875rem", caretColor: "var(--primary)" },
          ".cm-gutters": {
            backgroundColor: "transparent",
            color: "var(--muted-foreground)",
            border: "none",
          },
          ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 6px" },
          "&.cm-focused": { outline: "none" },
          "&.cm-focused .cm-cursor": { borderLeftColor: "var(--primary)" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
          },
          ".cm-activeLine": { backgroundColor: "transparent" },
          ".cm-activeLineGutter": { backgroundColor: "transparent" },
          ".cm-tooltip": {
            border: "1px solid var(--border)",
            backgroundColor: "var(--popover)",
            color: "var(--popover-foreground)",
            borderRadius: "calc(var(--radius) - 2px)",
            boxShadow: "var(--shadow-md)",
          },
          ".cm-tooltip-autocomplete ul li": {
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            padding: "2px 6px",
          },
          ".cm-tooltip-autocomplete ul li[aria-selected]": {
            backgroundColor: "var(--accent)",
            color: "var(--accent-foreground)",
          },
          ".cm-completionLabel": { color: "inherit" },
          ".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal" },
        }),
      ],
    });

    const view = new EditorView({ state, parent });
    viewRef.current = view;
    // Report the initial (empty) selection so a run handler always has a cursor.
    onSelectionChangeRef.current?.(readSelection(view));

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
      className={cn("min-h-0 overflow-hidden", className)}
    />
  );
}
