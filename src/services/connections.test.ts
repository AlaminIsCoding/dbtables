import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionProfile } from "../domain";
import {
  CONNECTION_STATE_COMMAND,
  CONNECT_PROFILE_COMMAND,
  CONNECT_SQLITE_COMMAND,
  DELETE_CONNECTION_PROFILE_COMMAND,
  DISCONNECT_CONNECTION_COMMAND,
  LIST_CONNECTION_PROFILES_COMMAND,
  SAVE_CONNECTION_PROFILE_COMMAND,
  TEST_CONNECTION_PROFILE_COMMAND,
  connectProfile,
  connectSqlite,
  deleteConnectionProfile,
  disconnectConnection,
  getConnectionState,
  listConnectionProfiles,
  saveConnectionProfile,
  testConnectionProfile,
} from "./connections";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const sqliteProfile: ConnectionProfile = {
  id: "p1",
  name: "Local app",
  descriptor: { engine: "sqlite", filePath: "C:/data/app.sqlite" },
};

describe("connection services", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("opens a SQLite file with the camelCase argument", async () => {
    invokeMock.mockResolvedValue("sqlite-1");

    await expect(connectSqlite("C:/data/app.sqlite")).resolves.toBe("sqlite-1");

    expect(invokeMock).toHaveBeenCalledWith(CONNECT_SQLITE_COMMAND, {
      filePath: "C:/data/app.sqlite",
    });
  });

  it("disconnects a connection", async () => {
    invokeMock.mockResolvedValue(undefined);

    await disconnectConnection("sqlite-1");

    expect(invokeMock).toHaveBeenCalledWith(DISCONNECT_CONNECTION_COMMAND, {
      connectionId: "sqlite-1",
    });
  });

  it("reads the backend connection state", async () => {
    invokeMock.mockResolvedValue("connected");

    await expect(getConnectionState("sqlite-1")).resolves.toBe("connected");

    expect(invokeMock).toHaveBeenCalledWith(CONNECTION_STATE_COMMAND, {
      connectionId: "sqlite-1",
    });
  });

  it("lists saved profiles", async () => {
    invokeMock.mockResolvedValue([sqliteProfile]);

    await expect(listConnectionProfiles()).resolves.toEqual([sqliteProfile]);

    expect(invokeMock).toHaveBeenCalledWith(LIST_CONNECTION_PROFILES_COMMAND);
  });

  it("saves a profile with a write-only password", async () => {
    invokeMock.mockResolvedValue(sqliteProfile);
    const input = {
      name: "Local app",
      descriptor: sqliteProfile.descriptor,
      password: "hunter2",
    };

    await expect(saveConnectionProfile(input)).resolves.toEqual(sqliteProfile);

    expect(invokeMock).toHaveBeenCalledWith(SAVE_CONNECTION_PROFILE_COMMAND, {
      input,
    });
  });

  it("deletes a profile", async () => {
    invokeMock.mockResolvedValue(true);

    await expect(deleteConnectionProfile("p1")).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith(DELETE_CONNECTION_PROFILE_COMMAND, {
      profileId: "p1",
    });
  });

  it("tests submitted settings without saving them", async () => {
    invokeMock.mockResolvedValue({ engine: "sqlite", serverVersion: "3.45.0" });
    const input = { name: "Local app", descriptor: sqliteProfile.descriptor };

    await expect(testConnectionProfile(input)).resolves.toEqual({
      engine: "sqlite",
      serverVersion: "3.45.0",
    });

    expect(invokeMock).toHaveBeenCalledWith(TEST_CONNECTION_PROFILE_COMMAND, {
      input,
    });
  });

  it("connects a saved profile by identifier", async () => {
    invokeMock.mockResolvedValue("conn-1");

    await expect(connectProfile("p1")).resolves.toBe("conn-1");

    expect(invokeMock).toHaveBeenCalledWith(CONNECT_PROFILE_COMMAND, {
      profileId: "p1",
    });
  });
});