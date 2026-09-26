import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionProfile, QueryError } from "../../domain";
import {
  connectProfile,
  deleteConnectionProfile,
  disconnectConnection,
  listConnectionProfiles,
  saveConnectionProfile,
  testConnectionProfile,
} from "../../services/connections";
import { useConnectionManager } from "./useConnectionManager";

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

const redactedError: QueryError = {
  category: "authentication",
  message: "the server rejected the credentials",
};

async function loadedProfiles(profiles: ConnectionProfile[]) {
  listMock.mockResolvedValue(profiles);
  const hook = renderHook(() => useConnectionManager());
  await waitFor(() =>
    expect(hook.result.current.profiles.status).toBe("ready"),
  );
  return hook;
}

afterEach(cleanup);

describe("useConnectionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([]);
    disconnectMock.mockResolvedValue(undefined);
  });

  it("loads saved profiles on mount", async () => {
    const { result } = await loadedProfiles([sqliteProfile, serverProfile]);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(result.current.profiles).toEqual({
      status: "ready",
      profiles: [sqliteProfile, serverProfile],
    });
    expect(result.current.active).toEqual({ status: "disconnected" });
  });

  it("reports a profile-list failure and can retry", async () => {
    listMock.mockRejectedValueOnce(redactedError).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => expect(result.current.profiles.status).toBe("error"));

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.profiles).toEqual({ status: "ready", profiles: [] });
  });

  it("tests an unsaved draft and exposes the engine", async () => {
    const { result } = await loadedProfiles([]);
    testMock.mockResolvedValue({ engine: "postgres", serverVersion: "16.2" });

    await act(async () => {
      await result.current.testConnection(
        { name: "Draft", descriptor: serverProfile.descriptor, password: "write-only" },
        null,
      );
    });

    expect(testMock).toHaveBeenCalledWith({
      name: "Draft",
      descriptor: serverProfile.descriptor,
      password: "write-only",
    });
    expect(result.current.test).toEqual({
      status: "success",
      targetId: null,
      engine: "postgres",
      serverVersion: "16.2",
    });
  });

  it("reports a failed test as a normalized error and can clear it", async () => {
    const { result } = await loadedProfiles([]);
    testMock.mockRejectedValue(redactedError);

    await act(async () => {
      await result.current.testConnection(
        { id: "p1", name: "Local app", descriptor: sqliteProfile.descriptor },
        "p1",
      );
    });

    expect(result.current.test).toEqual({
      status: "error",
      targetId: "p1",
      error: redactedError,
    });

    act(() => result.current.clearTest());
    expect(result.current.test).toEqual({ status: "idle" });
  });

  it("saves a profile, reloads the list, and returns the saved profile", async () => {
    const { result } = await loadedProfiles([]);
    saveMock.mockResolvedValue(serverProfile);
    listMock.mockResolvedValue([serverProfile]);

    const input = {
      name: "Reporting",
      descriptor: serverProfile.descriptor,
      password: "write-only",
    };
    let saved: ConnectionProfile | null = null;
    await act(async () => {
      saved = await result.current.save(input);
    });

    expect(saveMock).toHaveBeenCalledWith(input);
    expect(saved).toEqual(serverProfile);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(result.current.profiles).toEqual({
      status: "ready",
      profiles: [serverProfile],
    });
    expect(result.current.mutation).toEqual({ status: "idle" });
  });

  it("reports a failed save without discarding the list", async () => {
    const { result } = await loadedProfiles([sqliteProfile]);
    saveMock.mockRejectedValue({
      category: "validation",
      message: "a profile name must not be empty",
    });

    await act(async () => {
      await result.current.save({
        name: "",
        descriptor: sqliteProfile.descriptor,
      });
    });

    expect(result.current.mutation).toEqual({
      status: "error",
      error: { category: "validation", message: "a profile name must not be empty" },
    });
    expect(result.current.profiles).toEqual({
      status: "ready",
      profiles: [sqliteProfile],
    });
  });

  it("connects a profile and replaces the previous connection", async () => {
    const { result } = await loadedProfiles([sqliteProfile, serverProfile]);
    connectMock.mockResolvedValueOnce("conn-1").mockResolvedValueOnce("conn-2");

    await act(async () => {
      await result.current.connect("p1");
    });
    expect(result.current.active).toEqual({
      status: "connected",
      profileId: "p1",
      connectionId: "conn-1",
    });

    await act(async () => {
      await result.current.connect("p2");
    });

    expect(disconnectMock).toHaveBeenCalledWith("conn-1");
    expect(result.current.active).toEqual({
      status: "connected",
      profileId: "p2",
      connectionId: "conn-2",
    });
  });

  it("reports a connection failure with the backend error", async () => {
    const { result } = await loadedProfiles([serverProfile]);
    connectMock.mockRejectedValue(redactedError);

    await act(async () => {
      await result.current.connect("p2");
    });

    expect(result.current.active).toEqual({
      status: "error",
      error: redactedError,
    });
    expect(result.current.profiles).toEqual({
      status: "ready",
      profiles: [serverProfile],
    });
  });

  it("disconnects the active connection", async () => {
    const { result } = await loadedProfiles([sqliteProfile]);
    connectMock.mockResolvedValue("conn-1");

    await act(async () => {
      await result.current.connect("p1");
    });
    await act(async () => {
      await result.current.disconnect();
    });

    expect(disconnectMock).toHaveBeenCalledWith("conn-1");
    expect(result.current.active).toEqual({ status: "disconnected" });
  });

  it("disconnects and removes the active profile together", async () => {
    const { result } = await loadedProfiles([sqliteProfile]);
    connectMock.mockResolvedValue("conn-1");
    deleteMock.mockResolvedValue(true);
    listMock.mockResolvedValue([]);

    await act(async () => {
      await result.current.connect("p1");
    });
    await act(async () => {
      await result.current.remove("p1");
    });

    expect(disconnectMock).toHaveBeenCalledWith("conn-1");
    expect(deleteMock).toHaveBeenCalledWith("p1");
    expect(result.current.active).toEqual({ status: "disconnected" });
    expect(result.current.profiles).toEqual({ status: "ready", profiles: [] });
  });

  it("removes a non-active profile and reports a missing one", async () => {
    const { result } = await loadedProfiles([sqliteProfile]);
    deleteMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    listMock.mockResolvedValue([]);

    let removed = false;
    await act(async () => {
      removed = await result.current.remove("p1");
    });
    expect(removed).toBe(true);
    expect(disconnectMock).not.toHaveBeenCalled();

    await act(async () => {
      removed = await result.current.remove("missing");
    });
    expect(removed).toBe(false);
  });
});