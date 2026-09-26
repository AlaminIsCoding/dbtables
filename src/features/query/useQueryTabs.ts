import { useCallback, useMemo, useState } from "react";

import {
  addQueryTab,
  closeQueryTab,
  createQueryTab,
  isTabDirty,
  markQueryTabRun,
  nextQueryTabId,
  nextQueryTabLabel,
  selectQueryTab,
  setQueryTabSql,
  type QueryTab,
  type QueryTabsState,
} from "./queryTabs";

export interface QueryTabsController {
  /** All open editor tabs, in display order. */
  tabs: QueryTab[];
  /** Identifier of the visible tab. */
  activeId: string;
  /** The visible tab. Always defined because a strip always holds one tab. */
  activeTab: QueryTab;
  /** Whether closing a tab is allowed (there is more than one). */
  canClose: boolean;
  /** Opens a new empty tab and activates it. */
  addTab: () => void;
  /** Closes a tab (a no-op for the last remaining tab). */
  closeTab: (id: string) => void;
  /** Activates a tab. */
  selectTab: (id: string) => void;
  /** Replaces a tab's editor text. */
  setSql: (id: string, sql: string) => void;
  /** Marks a tab's current text as executed, clearing its unsaved marker. */
  markRun: (id: string, sql: string) => void;
  /** Whether a tab has edits that have not been executed. */
  isDirty: (id: string) => boolean;
}

function createInitialState(): QueryTabsState {
  const first = createQueryTab("tab-1", "Query 1");
  return { tabs: [first], activeId: first.id };
}

/**
 * Owns the query-tab strip: which tabs exist, which is active, and the editor
 * text and unsaved state of each. It does not touch connections or results, so
 * editor state stays independent of query execution state.
 */
export function useQueryTabs(): QueryTabsController {
  const [state, setState] = useState<QueryTabsState>(createInitialState);

  const addTab = useCallback(() => {
    setState((current) =>
      addQueryTab(
        current,
        createQueryTab(
          nextQueryTabId(current.tabs),
          nextQueryTabLabel(current.tabs),
        ),
      ),
    );
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((current) => closeQueryTab(current, id));
  }, []);

  const selectTab = useCallback((id: string) => {
    setState((current) => selectQueryTab(current, id));
  }, []);

  const setSql = useCallback((id: string, sql: string) => {
    setState((current) => setQueryTabSql(current, id, sql));
  }, []);

  const markRun = useCallback((id: string, sql: string) => {
    setState((current) => markQueryTabRun(current, id, sql));
  }, []);

  const activeTab =
    state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];

  const dirtyIds = useMemo(
    () => new Set(state.tabs.filter(isTabDirty).map((tab) => tab.id)),
    [state.tabs],
  );

  const isDirty = useCallback((id: string) => dirtyIds.has(id), [dirtyIds]);

  return {
    tabs: state.tabs,
    activeId: state.activeId,
    activeTab,
    canClose: state.tabs.length > 1,
    addTab,
    closeTab,
    selectTab,
    setSql,
    markRun,
    isDirty,
  };
}
