import { QueryWorkspace } from "../../features/query";

interface EditorResultsSplitProps {
  /** Query-tab label shown in the editor header. */
  label: string;
}

/**
 * Editor-over-results split used by each query tab.
 *
 * Delegates to the query feature, which owns connection, editor, and results
 * state so the layout stays presentation-only.
 */
export function EditorResultsSplit({ label }: EditorResultsSplitProps) {
  return <QueryWorkspace label={label} />;
}
