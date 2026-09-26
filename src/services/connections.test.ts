import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTION_STATE_COMMAND,
  CONNECT_SQLITE_COMMAND,
  DISCONNECT_CONNECTION_COMMAND,
  connectSqlite,
  disconnectConnection,
  getConnectionState,
} from "./connections";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

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
});
