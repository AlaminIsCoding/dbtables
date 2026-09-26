import type { ObjectRef, TableFilter } from "@/domain";

/** Sub-view of a table tab. */
export type TableSubTab = "data" | "definition" | "index";

/** A tab hosted by the workspace. */
export type WorkspaceTab =
  | {
      id: string;
      kind: "table";
      object: ObjectRef;
      sub: TableSubTab;
      /** One-shot filter applied when the tab opens (for FK navigation). */
      focusFilter?: TableFilter;
    }
  | {
      id: string;
      kind: "query";
      title: string;
      sql: string;
      lastRunSql: string;
    }
  | {
      id: string;
      kind: "create-table";
    };

/** Tab strip state: the open tabs and which one is visible. */
export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeId: string | null;
}

/** Fully-qualified, human-readable object name. */
export function qualifiedObjectName(object: ObjectRef): string {
  return [object.database, object.schema, object.name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(".");
}

/** Deterministic identifier for a table tab, so the same table reuses one tab. */
export function tableTabId(object: ObjectRef): string {
  return `table:${object.database ?? ""}.${object.schema ?? ""}.${object.kind}:${object.name}`;
}

let counter = 0;

function mintId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** Builds a tab for browsing a table. */
export function makeTableTab(
  object: ObjectRef,
  sub: TableSubTab = "data",
  focusFilter?: TableFilter,
): WorkspaceTab {
  return { id: tableTabId(object), kind: "table", object, sub, focusFilter };
}

/** Produces the next unused `Query N` title for the tab strip. */
export function nextQueryTitle(tabs: WorkspaceTab[]): string {
  const used = new Set(
    tabs.filter((tab) => tab.kind === "query").map((tab) => tab.title),
  );
  let index = 1;
  while (used.has(`Query ${index}`)) {
    index += 1;
  }
  return `Query ${index}`;
}

/** Builds a tab for the SQL editor. */
export function makeQueryTab(tabs: WorkspaceTab[], sql = ""): WorkspaceTab {
  return {
    id: mintId("query"),
    kind: "query",
    title: nextQueryTitle(tabs),
    sql,
    lastRunSql: "",
  };
}

/** Builds the "new table" editor tab. */
export function makeCreateTableTab(): WorkspaceTab {
  return { id: mintId("create-table"), kind: "create-table" };
}

/** Adds a tab, reusing an existing one with the same id, and activates it. */
export function openTab(
  state: WorkspaceTabsState,
  tab: WorkspaceTab,
): WorkspaceTabsState {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id);
  if (existing) {
    const tabs = state.tabs.map((candidate) =>
      candidate.id === tab.id ? mergeTab(candidate, tab) : candidate,
    );
    return { tabs, activeId: tab.id };
  }
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

function mergeTab(current: WorkspaceTab, next: WorkspaceTab): WorkspaceTab {
  if (current.kind === "table" && next.kind === "table") {
    return { ...current, sub: next.sub, focusFilter: next.focusFilter };
  }
  if (current.kind === "query" && next.kind === "query") {
    return current;
  }
  return current;
}

/** Removes a tab, activating its nearest neighbour. */
export function closeTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) {
    return state;
  }
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId =
    state.activeId === id
      ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
      : state.activeId;
  return { tabs, activeId };
}

/** Activates a tab; unknown ids are ignored. */
export function selectTab(state: WorkspaceTabsState, id: string): WorkspaceTabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

/** Replaces fields of a specific tab by id. */
export function updateTab(
  state: WorkspaceTabsState,
  id: string,
  patch: Partial<WorkspaceTab>,
): WorkspaceTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? ({ ...tab, ...patch } as WorkspaceTab) : tab,
    ),
  };
}
