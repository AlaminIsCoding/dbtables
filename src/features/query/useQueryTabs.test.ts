import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useQueryTabs } from "./useQueryTabs";

afterEach(cleanup);

describe("useQueryTabs", () => {
  it("starts with a single active, clean, non-closable tab", () => {
    const { result } = renderHook(() => useQueryTabs());

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTab.label).toBe("Query 1");
    expect(result.current.activeId).toBe(result.current.activeTab.id);
    expect(result.current.canClose).toBe(false);
    expect(result.current.isDirty(result.current.activeId)).toBe(false);
  });

  it("adds a uniquely labeled tab and activates it", () => {
    const { result } = renderHook(() => useQueryTabs());

    act(() => result.current.addTab());

    expect(result.current.tabs.map((tab) => tab.label)).toEqual([
      "Query 1",
      "Query 2",
    ]);
    expect(result.current.activeTab.label).toBe("Query 2");
    expect(result.current.canClose).toBe(true);
  });

  it("marks a tab dirty on edit and clean after its text runs", () => {
    const { result } = renderHook(() => useQueryTabs());
    const id = result.current.activeId;

    act(() => result.current.setSql(id, "SELECT 1"));
    expect(result.current.isDirty(id)).toBe(true);

    act(() => result.current.markRun(id, "SELECT 1"));
    expect(result.current.isDirty(id)).toBe(false);
  });

  it("closes a tab and selects its neighbor without removing the last tab", () => {
    const { result } = renderHook(() => useQueryTabs());

    act(() => result.current.addTab());
    const secondId = result.current.activeId;
    act(() => result.current.closeTab(secondId));

    expect(result.current.tabs.map((tab) => tab.label)).toEqual(["Query 1"]);
    expect(result.current.canClose).toBe(false);

    const remainingId = result.current.activeId;
    act(() => result.current.closeTab(remainingId));
    expect(result.current.tabs).toHaveLength(1);
  });

  it("selects an existing tab", () => {
    const { result } = renderHook(() => useQueryTabs());
    const firstId = result.current.activeId;

    act(() => result.current.addTab());
    const secondId = result.current.activeId;
    expect(secondId).not.toBe(firstId);

    act(() => result.current.selectTab(firstId));
    expect(result.current.activeId).toBe(firstId);
  });
});
