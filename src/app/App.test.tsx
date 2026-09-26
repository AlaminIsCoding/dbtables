import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectProfile, listConnectionProfiles } from "@/services/connections";
import { listObjects, listScopes } from "@/services/metadata";

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

vi.mock("@/services/metadata", () => ({
  listObjects: vi.fn().mockResolvedValue([]),
  listScopes: vi.fn().mockResolvedValue({ databases: [], schemas: [] }),
}));

import App from "./App";

const connectMock = vi.mocked(connectProfile);
const listProfilesMock = vi.mocked(listConnectionProfiles);
const listObjectsMock = vi.mocked(listObjects);
const listScopesMock = vi.mocked(listScopes);

afterEach(() => {
  cleanup();
  connectMock.mockReset();
  listProfilesMock.mockReset();
  listProfilesMock.mockResolvedValue([]);
  listObjectsMock.mockClear();
  listScopesMock.mockReset();
  listScopesMock.mockResolvedValue({ databases: [], schemas: [] });
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

const profile = {
  id: "p1",
  name: "app_production",
  descriptor: { engine: "sqlite" as const, filePath: "C:/data/app.sqlite" },
};

describe("App workspace shell", () => {
  it("shows the connections page and disables workspace actions while disconnected", async () => {
    render(<App />);

    expect(screen.getByAltText("dbtables")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Connections" }),
    ).toBeTruthy();
    // The connections page lists saved connections instead of opening a form.
    expect(await screen.findByText(/No saved connections yet/)).toBeTruthy();
    // No schema sidebar until a database is open.
    expect(
      screen.queryByRole("complementary", { name: "Workspace navigation" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "New query",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows connections as cards and opens details from More", async () => {
    listProfilesMock.mockResolvedValue([profile]);
    render(<App />);

    expect(await screen.findByText("app_production")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Connect app_production" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "More about app_production" }),
    );

    expect(screen.getByText("Edit profile")).toBeTruthy();
    expect(screen.getByLabelText("Database file")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete connection" }),
    ).toBeTruthy();
  });

  it("selects a saved connection from the top bar and opens the workspace", async () => {
    listProfilesMock.mockResolvedValue([profile]);
    connectMock.mockResolvedValue("conn-1");
    render(<App />);

    const trigger = await screen.findByRole("button", {
      name: /^Connection:/,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /app_production/ }),
    );

    await waitFor(() => expect(connectMock).toHaveBeenCalledWith("p1"));
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Workspace navigation" }),
      ).toBeTruthy(),
    );

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

  it("prompts for a database after connecting to a multi-database engine", async () => {
    const mysqlProfile = {
      id: "p2",
      name: "b",
      descriptor: {
        engine: "mysql" as const,
        host: "localhost",
        port: 3306,
        username: "root",
        tls: "preferred" as const,
      },
    };
    listProfilesMock.mockResolvedValue([mysqlProfile]);
    connectMock.mockResolvedValue("conn-1");
    listScopesMock.mockResolvedValue({
      databases: ["analytics", "app_db"],
      schemas: [],
    });
    render(<App />);

    const trigger = await screen.findByRole("button", { name: /^Connection:/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "b" }));
    await waitFor(() => expect(connectMock).toHaveBeenCalledWith("p2"));

    // The same picker opens automatically with the databases fetched from "b".
    const picker = await screen.findByRole("dialog");
    expect(within(picker).getByText("Open a database")).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: "analytics" }));

    // Choosing a database re-lists objects scoped to it.
    await waitFor(() =>
      expect(listObjectsMock).toHaveBeenCalledWith("conn-1", {
        database: "analytics",
      }),
    );
  });

  it("toggles the dark class on the document root", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
