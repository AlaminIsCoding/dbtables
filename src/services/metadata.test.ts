import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ObjectRef, ScopeListing, TableDescription } from "../domain";
import {
  DESCRIBE_TABLE_COMMAND,
  LIST_OBJECTS_COMMAND,
  LIST_SCOPES_COMMAND,
  describeTable,
  listObjects,
  listScopes,
} from "./metadata";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const objects: ObjectRef[] = [
  { name: "users", kind: "table" },
  { name: "active_users", kind: "view" },
];

const scopes: ScopeListing = { schemas: ["public", "audit"] };

const users: ObjectRef = { schema: "public", name: "users", kind: "table" };

const description: TableDescription = {
  columns: [
    { name: "id", typeName: "integer", nullable: false },
    { name: "email", typeName: "text", nullable: false },
  ],
  primaryKeyColumns: ["id"],
  indexes: [{ name: "users_pkey", columns: ["id"], unique: true, primary: true }],
  constraints: [{ name: "users_pkey", kind: "primary_key", columns: ["id"] }],
};

describe("metadata service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  describe("listObjects", () => {
    it("invokes the list_objects command with the connection id", async () => {
      invokeMock.mockResolvedValue(objects);

      await expect(listObjects("sqlite-1")).resolves.toEqual(objects);

      expect(invokeMock).toHaveBeenCalledWith(LIST_OBJECTS_COMMAND, {
        connectionId: "sqlite-1",
      });
    });

    it("forwards a database/schema scope when one is supplied", async () => {
      invokeMock.mockResolvedValue(objects);

      await expect(
        listObjects("pg-1", { schema: "public" }),
      ).resolves.toEqual(objects);

      expect(invokeMock).toHaveBeenCalledWith(LIST_OBJECTS_COMMAND, {
        connectionId: "pg-1",
        scope: { schema: "public" },
      });
    });
  });

  describe("listScopes", () => {
    it("invokes the list_scopes command with the connection id", async () => {
      invokeMock.mockResolvedValue(scopes);

      await expect(listScopes("pg-1")).resolves.toEqual(scopes);

      expect(invokeMock).toHaveBeenCalledWith(LIST_SCOPES_COMMAND, {
        connectionId: "pg-1",
      });
    });
  });

  describe("describeTable", () => {
    it("invokes describe_table with the connection id and object", async () => {
      invokeMock.mockResolvedValue(description);

      await expect(describeTable("pg-1", users)).resolves.toEqual(description);

      expect(invokeMock).toHaveBeenCalledWith(DESCRIBE_TABLE_COMMAND, {
        connectionId: "pg-1",
        object: users,
      });
    });
  });
});
