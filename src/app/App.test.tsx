import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAppStatus, type AppStatusResponse } from "../services/appStatus";
import App from "./App";

vi.mock("../services/appStatus", () => ({
  getAppStatus: vi.fn(),
}));

// The sidebar mounts the connection manager, which lists saved profiles on
// mount. Keep the shell test independent of Tauri and of a real settings file.
vi.mock("../services/connections", () => ({
  connectSqlite: vi.fn(),
  disconnectConnection: vi.fn(),
  getConnectionState: vi.fn(),
  listConnectionProfiles: vi.fn().mockResolvedValue([]),
  saveConnectionProfile: vi.fn(),
  deleteConnectionProfile: vi.fn(),
  testConnectionProfile: vi.fn(),
  connectProfile: vi.fn(),
}));

// The shell renders the Glide prototype in the results pane. jsdom has no
// canvas support, so the grid is stubbed to keep the shell test focused.
vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: {
    Uri: "uri",
    Text: "text",
    Image: "image",
    RowID: "row-id",
    Number: "number",
    Bubble: "bubble",
    Boolean: "boolean",
    Loading: "loading",
    Markdown: "markdown",
    Drilldown: "drilldown",
    Protected: "protected",
    Custom: "custom",
  },
  getDefaultTheme: () => ({}),
  DataEditor: () => null,
}));

const getAppStatusMock = vi.mocked(getAppStatus);

const okResponse: AppStatusResponse = {
  app: "dbtables",
  status: "ok",
  message: "dbtables backend is ready.",
};

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("App workspace shell", () => {
  beforeEach(() => {
    getAppStatusMock.mockReset();
  });

  it("renders the sidebar, query tabs, split panes, and status bar", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "dbtables" })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).toBeTruthy();
    expect(await screen.findByText("No connections yet.")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Query 1" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Query 2" })).toBeTruthy();
    expect(screen.getByText("SQL editor · Query 1")).toBeTruthy();
    expect(screen.getByText("No results yet")).toBeTruthy();
    expect(
      screen.getByRole("separator", { name: "Resize editor and results" }),
    ).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });

  it("switches the query workspace when a query tab is selected", () => {
    render(<App />);

    expect(screen.getByText("SQL editor · Query 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Query 2" }));

    expect(screen.getByText("SQL editor · Query 2")).toBeTruthy();
    expect(screen.queryByText("SQL editor · Query 1")).toBeNull();
  });

  it("shows a pending state then the backend response", async () => {
    getAppStatusMock.mockResolvedValue(okResponse);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Check backend" }));

    expect(screen.getByText("Waiting for the backend…")).toBeTruthy();
    expect(
      await screen.findByText(/dbtables backend is ready\./),
    ).toBeTruthy();
    expect(getAppStatusMock).toHaveBeenCalledWith({ requestedBy: "frontend" });
  });

  it("shows an error state when the backend request fails", async () => {
    getAppStatusMock.mockRejectedValue(new Error("backend unavailable"));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Check backend" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("backend unavailable");
  });

  it("toggles the dark class on the document root", () => {
    render(<App />);

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to dark theme" }),
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
