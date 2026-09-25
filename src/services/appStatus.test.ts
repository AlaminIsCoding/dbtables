import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_STATUS_COMMAND,
  getAppStatus,
  type AppStatusResponse,
} from "./appStatus";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const okResponse: AppStatusResponse = {
  app: "dbtables",
  status: "ok",
  message: "dbtables backend is ready.",
};

describe("getAppStatus", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the app_status command with the typed request", async () => {
    invokeMock.mockResolvedValue(okResponse);

    const result = await getAppStatus({ requestedBy: "contributor" });

    expect(invokeMock).toHaveBeenCalledWith(APP_STATUS_COMMAND, {
      request: { requestedBy: "contributor" },
    });
    expect(result).toEqual(okResponse);
  });

  it("sends an empty request by default", async () => {
    invokeMock.mockResolvedValue(okResponse);

    await getAppStatus();

    expect(invokeMock).toHaveBeenCalledWith(APP_STATUS_COMMAND, {
      request: {},
    });
  });

  it("surfaces backend failures to the caller", async () => {
    invokeMock.mockRejectedValue(new Error("backend unavailable"));

    await expect(getAppStatus()).rejects.toThrow("backend unavailable");
  });
});
