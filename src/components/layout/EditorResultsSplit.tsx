import { QueryWorkspace, type QueryWorkspaceProps } from "../../features/query";

export type EditorResultsSplitProps = Omit<QueryWorkspaceProps, "className">;

/**
 * Editor-over-results split used by each query tab.
 *
 * Delegates to the query feature, which owns connection, editor, and results
 * state so the layout stays presentation-only.
 */
export function EditorResultsSplit(props: EditorResultsSplitProps) {
  return <QueryWorkspace {...props} />;
}
