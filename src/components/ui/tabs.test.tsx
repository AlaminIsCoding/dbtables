import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

afterEach(cleanup);

function renderTabs() {
  render(
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">Tab A</TabsTrigger>
        <TabsTrigger value="b">Tab B</TabsTrigger>
      </TabsList>
      <TabsContent value="a">Panel A</TabsContent>
      <TabsContent value="b">Panel B</TabsContent>
    </Tabs>,
  );
}

describe("Tabs", () => {
  it("shows the default panel and marks the active tab", () => {
    renderTabs();

    expect(
      screen.getByRole("tab", { name: "Tab A" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Tab B" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getByText("Panel A")).toBeTruthy();
    expect(screen.queryByText("Panel B")).toBeNull();
  });

  it("switches panels when another tab is clicked", () => {
    renderTabs();

    // Radix activates tabs on pointer-down rather than click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Tab B" }));

    expect(
      screen.getByRole("tab", { name: "Tab B" }).getAttribute("aria-selected"),
    ).toBe("true");
    const panel = screen.getByText("Panel B").closest('[role="tabpanel"]');
    expect(panel?.hasAttribute("hidden")).toBe(false);
  });
});
