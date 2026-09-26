import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The store lists saved profiles on mount; keep the shell test independent of
// Tauri and of a real settings file.
vi.mock("@/services/connections", () => ({
  connectSqlite: vi.fn(),
  disconnectConnection: vi.fn(),
  getConnectionState: vi.fn(),
  listConnectionProfiles: vi.fn().mockResolvedValue([]),
  saveConnectionProfile: vi.fn(),
  deleteConnectionProfile: vi.fn(),
  testConnectionProfile: vi.fn(),
  connectProfile: vi.fn(),
}));

import App from "./App";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("App workspace shell", () => {
  it("renders the sidebar, brand, and welcome state", async () => {
    render(<App />);

    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).toBeTruthy();
    expect(screen.getByAltText("dbtables")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open database" }),
    ).toBeTruthy();
    expect(await screen.findByText("No database open")).toBeTruthy();
  });

  it("opens a query tab from the top bar", () => {
    render(<App />);

    fireEvent.click(
      within(screen.getByRole("banner")).getByRole("button", {
        name: "New query",
      }),
    );

    expect(screen.getByRole("tab", { name: /Query 1/ })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: /Query 1/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("toggles the dark class on the document root", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
