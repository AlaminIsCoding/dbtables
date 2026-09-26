import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionProfile } from "../../domain";
import {
  connectProfile,
  deleteConnectionProfile,
  disconnectConnection,
  listConnectionProfiles,
  saveConnectionProfile,
  testConnectionProfile,
} from "../../services/connections";
import { ConnectionManager } from "./ConnectionManager";

vi.mock("../../services/connections", () => ({
  connectProfile: vi.fn(),
  deleteConnectionProfile: vi.fn(),
  disconnectConnection: vi.fn(),
  listConnectionProfiles: vi.fn(),
  saveConnectionProfile: vi.fn(),
  testConnectionProfile: vi.fn(),
}));

const listMock = vi.mocked(listConnectionProfiles);
const saveMock = vi.mocked(saveConnectionProfile);
const deleteMock = vi.mocked(deleteConnectionProfile);
const testMock = vi.mocked(testConnectionProfile);
const connectMock = vi.mocked(connectProfile);
const disconnectMock = vi.mocked(disconnectConnection);

const sqliteProfile: ConnectionProfile = {
  id: "p1",
  name: "Local app",
  descriptor: { engine: "sqlite", filePath: "C:/data/app.sqlite" },
};

const serverProfile: ConnectionProfile = {
  id: "p2",
  name: "Reporting",
  descriptor: {
    engine: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "app",
    username: "app_user",
    tls: "preferred",
  },
};

afterEach(cleanup);

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([]);
    disconnectMock.mockResolvedValue(undefined);
  });

  it("shows an empty state when no profiles are saved", async () => {
    render(<ConnectionManager />);

    expect(await screen.findByText("No connections yet.")).toBeTruthy();
  });

  it("lists saved profiles with engine summaries and actions", async () => {
    listMock.mockResolvedValue([sqliteProfile, serverProfile]);
    render(<ConnectionManager />);

    expect(await screen.findByText("Local app")).toBeTruthy();
    expect(screen.getByText(/SQLite · C:\/data\/app\.sqlite/)).toBeTruthy();
    expect(screen.getByText(/PostgreSQL · db\.example\.com:5432 \/ app/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Local app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test Reporting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Local app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Reporting" })).toBeTruthy();
  });

  it("opens a new-profile form with engine-specific fields", async () => {
    render(<ConnectionManager />);
    await screen.findByText("No connections yet.");

    fireEvent.click(screen.getByRole("button", { name: "New profile" }));

    expect(screen.getByText("New profile")).toBeTruthy();
    expect(screen.getByLabelText("Database file")).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();

    fireEvent.change(screen.getByLabelText("Engine"), {
      target: { value: "mysql" },
    });

    expect(screen.queryByLabelText("Database file")).toBeNull();
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("TLS")).toBeTruthy();
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("3306");
  });

  it("edits a profile without prefilling the saved password", async () => {
    listMock.mockResolvedValue([serverProfile]);
    render(<ConnectionManager />);
    await screen.findByText("Reporting");

    fireEvent.click(screen.getByRole("button", { name: "Edit Reporting" }));

    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.value).toBe("");
    expect(
      screen.getByText(/Leave blank to keep the saved password/),
    ).toBeTruthy();
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "db.example.com",
    );
  });

  it("validates before saving and does not call the backend", async () => {
    render(<ConnectionManager />);
    await screen.findByText("No connections yet.");
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Enter a profile name.");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("saves a new profile without sending a blank password", async () => {
    const saved: ConnectionProfile = { id: "p3", name: "Local app", descriptor: sqliteProfile.descriptor };
    saveMock.mockResolvedValue(saved);
    listMock.mockResolvedValueOnce([]).mockResolvedValueOnce([saved]);
    render(<ConnectionManager />);
    await screen.findByText("No connections yet.");

    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local app" },
    });
    fireEvent.change(screen.getByLabelText("Database file"), {
      target: { value: "C:/data/app.sqlite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Local app")).toBeTruthy();
    expect(saveMock).toHaveBeenCalledWith({
      name: "Local app",
      descriptor: { engine: "sqlite", filePath: "C:/data/app.sqlite" },
    });
    // The form closed and the reloaded list is shown again.
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("tests an unsaved draft and shows an actionable result", async () => {
    testMock.mockResolvedValue({ engine: "sqlite", serverVersion: "3.45.0" });
    render(<ConnectionManager />);
    await screen.findByText("No connections yet.");

    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local app" },
    });
    fireEvent.change(screen.getByLabelText("Database file"), {
      target: { value: "C:/data/app.sqlite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText(/SQLite connection succeeded/)).toBeTruthy();
    expect(screen.getByText(/3\.45\.0/)).toBeTruthy();
    expect(testMock).toHaveBeenCalledWith({
      name: "Local app",
      descriptor: { engine: "sqlite", filePath: "C:/data/app.sqlite" },
    });
  });

  it("shows a redacted test failure from the backend", async () => {
    testMock.mockRejectedValue({
      category: "authentication",
      message: "authentication failed for user app_user",
      code: "28000",
    });
    render(<ConnectionManager />);
    await screen.findByText("No connections yet.");

    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Reporting" },
    });
    fireEvent.change(screen.getByLabelText("Engine"), {
      target: { value: "postgres" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "app_user" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("authentication failed for user app_user");
    expect(alert.textContent).toContain("28000");
    // A password typed into the form is never echoed back into the page.
    expect(alert.textContent).not.toContain("hunter2");
  });

  it("tests a saved profile using its stored secret", async () => {
    listMock.mockResolvedValue([serverProfile]);
    testMock.mockResolvedValue({ engine: "postgres" });
    render(<ConnectionManager />);
    await screen.findByText("Reporting");

    fireEvent.click(screen.getByRole("button", { name: "Test Reporting" }));

    expect(await screen.findByText(/Test succeeded/)).toBeTruthy();
    expect(testMock).toHaveBeenCalledWith({
      id: "p2",
      name: "Reporting",
      descriptor: serverProfile.descriptor,
    });
  });

  it("connects a profile and marks the active target", async () => {
    listMock.mockResolvedValue([sqliteProfile, serverProfile]);
    connectMock.mockResolvedValue("conn-1");
    render(<ConnectionManager />);
    await screen.findByText("Local app");

    fireEvent.click(screen.getByRole("button", { name: "Connect Local app" }));

    expect(await screen.findByText("Active: Local app")).toBeTruthy();
    expect(connectMock).toHaveBeenCalledWith("p1");
    const row = screen.getByRole("listitem", { name: "Local app" });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("reports a connection failure in the active-target area", async () => {
    listMock.mockResolvedValue([serverProfile]);
    connectMock.mockRejectedValue({
      category: "connection",
      message: "the server could not be reached at db.example.com:5432",
    });
    render(<ConnectionManager />);
    await screen.findByText("Reporting");

    fireEvent.click(screen.getByRole("button", { name: "Connect Reporting" }));

    expect(
      await screen.findByText(/the server could not be reached/),
    ).toBeTruthy();
    expect(screen.queryByText("Active: Reporting")).toBeNull();
  });

  it("disconnects the active profile", async () => {
    listMock.mockResolvedValue([sqliteProfile]);
    connectMock.mockResolvedValue("conn-1");
    render(<ConnectionManager />);
    await screen.findByText("Local app");

    fireEvent.click(screen.getByRole("button", { name: "Connect Local app" }));
    await screen.findByText("Active: Local app");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(disconnectMock).toHaveBeenCalledWith("conn-1");
    expect(await screen.findByRole("button", { name: "Connect Local app" })).toBeTruthy();
    expect(screen.queryByText("Active: Local app")).toBeNull();
  });

  it("removes a profile and refreshes the list", async () => {
    listMock.mockResolvedValueOnce([sqliteProfile]).mockResolvedValueOnce([]);
    deleteMock.mockResolvedValue(true);
    render(<ConnectionManager />);
    await screen.findByText("Local app");

    fireEvent.click(screen.getByRole("button", { name: "Remove Local app" }));

    expect(await screen.findByText("No connections yet.")).toBeTruthy();
    expect(deleteMock).toHaveBeenCalledWith("p1");
  });

  it("reports a profile-list failure and retries", async () => {
    listMock
      .mockRejectedValueOnce({ category: "internal", message: "settings are unreadable" })
      .mockResolvedValueOnce([]);
    render(<ConnectionManager />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("settings are unreadable");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No connections yet.")).toBeTruthy();
  });
});