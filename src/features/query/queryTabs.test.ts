import { describe, expect, it } from "vitest";

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
  type QueryTabsState,
} from "./queryTabs";

function state(...tabs: ReturnType<typeof createQueryTab>[]): QueryTabsState {
  return { tabs, activeId: tabs[0].id };
}

describe("isTabDirty", () => {
  it("is false for a fresh tab", () => {
    expect(isTabDirty(createQueryTab("a", "Query 1"))).toBe(false);
  });

  it("is true once the editor text differs from the last run", () => {
    const tab = { ...createQueryTab("a", "Query 1"), sql: "SELECT 1" };
    expect(isTabDirty(tab)).toBe(true);
  });

  it("is false again once the same text has run", () => {
    const tab = {
      id: "a",
      label: "Query 1",
      sql: "SELECT 1",
      lastRunSql: "SELECT 1",
    };
    expect(isTabDirty(tab)).toBe(false);
  });
});

describe("nextQueryTabLabel", () => {
  it("starts at Query 1", () => {
    expect(nextQueryTabLabel([])).toBe("Query 1");
  });

  it("skips labels still in use", () => {
    const tabs = [
      createQueryTab("a", "Query 1"),
      createQueryTab("b", "Query 3"),
    ];
    expect(nextQueryTabLabel(tabs)).toBe("Query 2");
  });
});

describe("nextQueryTabId", () => {
  it("returns a unique identifier per call", () => {
    const tabs = [createQueryTab("a", "Query 1")];
    expect(nextQueryTabId(tabs)).not.toBe(nextQueryTabId(tabs));
  });
});

describe("addQueryTab", () => {
  it("appends and activates the new tab", () => {
    const first = createQueryTab("a", "Query 1");
    const second = createQueryTab("b", "Query 2");

    expect(addQueryTab(state(first), second)).toEqual({
      tabs: [first, second],
      activeId: "b",
    });
  });
});

describe("closeQueryTab", () => {
  it("refuses to close the last remaining tab", () => {
    const only = createQueryTab("a", "Query 1");
    expect(closeQueryTab(state(only), "a")).toEqual(state(only));
  });

  it("activates the previous neighbor when the active tab closes", () => {
    const a = createQueryTab("a", "Query 1");
    const b = createQueryTab("b", "Query 2");
    const c = createQueryTab("c", "Query 3");
    const closingActive: QueryTabsState = { tabs: [a, b, c], activeId: "c" };

    expect(closeQueryTab(closingActive, "c")).toEqual({
      tabs: [a, b],
      activeId: "b",
    });
  });

  it("keeps the active tab when an inactive tab closes", () => {
    const a = createQueryTab("a", "Query 1");
    const b = createQueryTab("b", "Query 2");
    const current: QueryTabsState = { tabs: [a, b], activeId: "a" };

    expect(closeQueryTab(current, "b")).toEqual({ tabs: [a], activeId: "a" });
  });
});

describe("selectQueryTab", () => {
  it("activates a known tab", () => {
    const a = createQueryTab("a", "Query 1");
    const b = createQueryTab("b", "Query 2");
    const current: QueryTabsState = { tabs: [a, b], activeId: "a" };

    expect(selectQueryTab(current, "b").activeId).toBe("b");
  });

  it("ignores an unknown tab id", () => {
    const current = state(createQueryTab("a", "Query 1"));
    expect(selectQueryTab(current, "missing")).toBe(current);
  });
});

describe("setQueryTabSql and markQueryTabRun", () => {
  it("updates only the targeted tab's text", () => {
    const a = createQueryTab("a", "Query 1");
    const b = createQueryTab("b", "Query 2");
    const current: QueryTabsState = { tabs: [a, b], activeId: "a" };

    const next = setQueryTabSql(current, "b", "SELECT 2");
    expect(next.tabs[0].sql).toBe("");
    expect(next.tabs[1].sql).toBe("SELECT 2");
  });

  it("records the run without overwriting later edits", () => {
    const a = createQueryTab("a", "Query 1");
    const current = setQueryTabSql(state(a), "a", "SELECT 1");

    const next = markQueryTabRun(current, "a", "SELECT 1");
    expect(next.tabs[0].lastRunSql).toBe("SELECT 1");
    expect(isTabDirty(next.tabs[0])).toBe(false);
  });
});
