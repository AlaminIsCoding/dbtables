import { describe, expect, it } from "vitest";

import type { ColumnInfo, ObjectRef } from "@/domain";

import {
  columnToDefinition,
  describePendingChange,
  isColumnNameTaken,
  pendingChangesToSql,
  pendingColumnNames,
  validateNewColumn,
  validateRename,
  type PendingColumnChange,
} from "./columnEdits";

const users: ObjectRef = { name: "users", kind: "table" };

const columns: ColumnInfo[] = [
  { name: "id", typeName: "integer", nullable: false },
  { name: "nickname", typeName: "text", nullable: true },
];

describe("staged column edits", () => {
  it("applies staged changes in order to derive the effective names", () => {
    const changes: PendingColumnChange[] = [
      { id: "a", kind: "add", column: columnToDefinition({ name: "email", typeName: "text" }, false) },
      { id: "b", kind: "rename", from: "nickname", to: "alias" },
      { id: "c", kind: "drop", column: "id" },
    ];

    expect(pendingColumnNames(columns, [])).toEqual(["id", "nickname"]);
    expect(pendingColumnNames(columns, changes)).toEqual(["alias", "email"]);
  });

  it("matches names case-insensitively", () => {
    expect(isColumnNameTaken("ID", ["id"])).toBe(true);
    expect(isColumnNameTaken("id", ["ID"])).toBe(true);
    expect(isColumnNameTaken("other", ["id"])).toBe(false);
  });

  it("validates a new column", () => {
    expect(validateNewColumn("", "TEXT", ["id"])).toBe("Enter a column name.");
    expect(validateNewColumn("email", "", ["id"])).toBe("Enter a column type.");
    expect(validateNewColumn("id", "TEXT", ["id"])).toBe(
      "Column “id” already exists.",
    );
    expect(validateNewColumn("email", "TEXT", ["id"])).toBeNull();
  });

  it("validates a rename against everything but the original", () => {
    expect(validateRename("nickname", "", ["id", "nickname"])).toBe(
      "Enter a new column name.",
    );
    expect(validateRename("nickname", "id", ["id", "nickname"])).toBe(
      "Column “id” already exists.",
    );
    expect(validateRename("nickname", "alias", ["id", "nickname"])).toBeNull();
  });

  it("describes and renders staged changes", () => {
    const add: PendingColumnChange = {
      id: "a",
      kind: "add",
      column: { name: "email", typeName: "TEXT", nullable: true, primaryKey: false },
    };
    const rename: PendingColumnChange = {
      id: "b",
      kind: "rename",
      from: "nickname",
      to: "alias",
    };
    const drop: PendingColumnChange = { id: "c", kind: "drop", column: "id" };

    expect(describePendingChange(add)).toBe("Add email TEXT");
    expect(describePendingChange(rename)).toBe("Rename nickname → alias");
    expect(describePendingChange(drop)).toBe("Drop id");

    expect(pendingChangesToSql(users, [add, rename, drop])).toEqual([
      'ALTER TABLE "users" ADD COLUMN "email" TEXT;',
      'ALTER TABLE "users" RENAME COLUMN "nickname" TO "alias";',
      'ALTER TABLE "users" DROP COLUMN "id";',
    ]);
  });
});
