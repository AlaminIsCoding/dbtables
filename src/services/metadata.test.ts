import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ObjectRef } from "../domain";
import { LIST_OBJECTS_COMMAND, listObjects } from "./metadata";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const objects: ObjectRef[] = [
  { name: "users", kind: "table" },
  { name: "active_users", kind: "view" },
];

describe("listObjects", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the list_objects command with the connection id", async () => {
    invokeMock.mockResolvedValue(objects);

    await expect(listObjects("sqlite-1")).resolves.toEqual(objects);

    expect(invokeMock).toHaveBeenCalledWith(LIST_OBJECTS_COMMAND, {
      connectionId: "sqlite-1",
    });
  });
});
