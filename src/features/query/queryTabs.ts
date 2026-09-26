/**
 * Query-tab editor state.
 *
 * Editor/tab state is deliberately kept separate from per-query execution and
 * result state: a tab owns only its label and SQL text, so switching tabs (or a
 * future persisted workspace) never disturbs connection or result state.
 *
 * A tab is "dirty" when its editor text differs from the text that last ran.
 * Because saved query files are out of scope for this milestone, the last run
 * is the only durable baseline the app has; the indicator warns that the
 * editor holds changes that have not yet been executed.
 */
export interface QueryTab {
  /** Stable identifier used as the tab value. */
  id: string;
  /** User-facing tab label. */
  label: string;
  /** Current editor content. */
  sql: string;
  /** SQL text that last ran in this tab; empty until the first run. */
  lastRunSql: string;
}

export interface QueryTabsState {
  tabs: QueryTab[];
  activeId: string;
}

/** Builds a fresh, empty tab. */
export function createQueryTab(id: string, label: string): QueryTab {
  return { id, label, sql: "", lastRunSql: "" };
}

/** Whether the tab holds edits that have not been executed. */
export function isTabDirty(tab: QueryTab): boolean {
  return tab.sql !== tab.lastRunSql;
}

/** Produces the next unused `Query N` label for the tab strip. */
export function nextQueryTabLabel(tabs: QueryTab[]): string {
  const used = new Set(tabs.map((tab) => tab.label));
  let index = 1;
  while (used.has(`Query ${index}`)) {
    index += 1;
  }
  return `Query ${index}`;
}

let fallbackTabCounter = 0;

/** Mints an identifier unique to this session's tab strip. */
export function nextQueryTabId(tabs: QueryTab[]): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `tab-${crypto.randomUUID()}`;
  }
  fallbackTabCounter += 1;
  return `tab-${Date.now()}-${tabs.length}-${fallbackTabCounter}`;
}

/** Appends a tab and makes it active. */
export function addQueryTab(
  state: QueryTabsState,
  tab: QueryTab,
): QueryTabsState {
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * Removes a tab, activating its nearest neighbor.
 *
 * The last remaining tab is never closed: the workspace always keeps one editor
 * tab so the query surface cannot disappear.
 */
export function closeQueryTab(state: QueryTabsState, id: string): QueryTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1 || state.tabs.length <= 1) {
    return state;
  }

  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId =
    state.activeId === id
      ? tabs[Math.min(index, tabs.length - 1)].id
      : state.activeId;

  return { tabs, activeId };
}

/** Selects an existing tab; unknown ids are ignored. */
export function selectQueryTab(
  state: QueryTabsState,
  id: string,
): QueryTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) {
    return state;
  }
  return { ...state, activeId: id };
}

/** Replaces one tab's editor text. */
export function setQueryTabSql(
  state: QueryTabsState,
  id: string,
  sql: string,
): QueryTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, sql } : tab)),
  };
}

/**
 * Records that a tab's current editor text was executed.
 *
 * Only `lastRunSql` changes, so text typed during an in-flight run stays
 * marked as unsaved.
 */
export function markQueryTabRun(
  state: QueryTabsState,
  id: string,
  sql: string,
): QueryTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, lastRunSql: sql } : tab,
    ),
  };
}
