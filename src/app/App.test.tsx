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
}));

import App from "./App";

const connectMock = vi.mocked(connectProfile);
const listProfilesMock = vi.mocked(listConnectionProfiles);

afterEach(() => {
  cleanup();
  connectMock.mockReset();
  listProfilesMock.mockReset();
  listProfilesMock.mockResolvedValue([]);
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
  it("shows the connect screen and disables workspace actions while disconnected", async () => {
    render(<App />);

    expect(screen.getByAltText("dbtables")).toBeTruthy();
    expect(
      await screen.findByText("Connect to a database"),
    ).toBeTruthy();
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

  it("lists saved connections and opens the workspace after connecting", async () => {
    listProfilesMock.mockResolvedValue([profile]);
    connectMock.mockResolvedValue("conn-1");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

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

  it("toggles the dark class on the document root", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
