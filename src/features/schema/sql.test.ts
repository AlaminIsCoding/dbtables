import { describe, expect, it } from "vitest";

import type { ColumnDefinition, ObjectRef, TableDefinition } from "@/domain";

import {
  generatedForeignKeyName,
  quoteIdentifier,
  quoteObject,
  renderAddColumn,
  renderAddForeignKey,
  renderAlterColumn,
  renderCreateIndex,
  renderCreateTable,
  renderDropColumn,
  renderDropForeignKey,
  renderDropIndex,
  renderRenameColumn,
} from "./sql";

const users: ObjectRef = { name: "users", kind: "table" };

describe("schema SQL generation", () => {
  it("quotes identifiers and escapes embedded quotes", () => {
    expect(quoteIdentifier("id")).toBe('"id"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteObject({ database: "db", schema: "public", name: "users", kind: "table" })).toBe(
      '"db"."public"."users"',
    );
    expect(quoteObject(users)).toBe('"users"');
  });

  it("renders a column clause with constraints and default", () => {
    const id: ColumnDefinition = {
      name: "id",
      typeName: "integer",
      nullable: false,
      primaryKey: true,
    };
    expect(
      renderAddColumn(users, { ...id, default: "1" }),
    ).toBe('ALTER TABLE "users" ADD COLUMN "id" integer NOT NULL PRIMARY KEY DEFAULT 1;');

    expect(
      renderAddColumn(users, {
        name: "note",
        typeName: "TEXT",
        nullable: true,
        primaryKey: false,
      }),
    ).toBe('ALTER TABLE "users" ADD COLUMN "note" TEXT;');
  });

  it("renders rename and drop column statements", () => {
    expect(renderRenameColumn(users, "nickname", "alias")).toBe(
      'ALTER TABLE "users" RENAME COLUMN "nickname" TO "alias";',
    );
    expect(renderDropColumn(users, "alias")).toBe(
      'ALTER TABLE "users" DROP COLUMN "alias";',
    );
  });

  it("renders index statements", () => {
    expect(renderCreateIndex(users, "users_email_idx", ["email", "name"], true)).toBe(
      'CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email", "name");',
    );
    expect(renderCreateIndex(users, "users_email_idx", ["email"], false)).toBe(
      'CREATE INDEX "users_email_idx" ON "users" ("email");',
    );
    expect(renderDropIndex("users_email_idx")).toBe(
      'DROP INDEX "users_email_idx";',
    );
  });

  it("renders foreign-key statements with a generated name", () => {
    expect(generatedForeignKeyName("pets", ["owner_id"])).toBe(
      "pets_owner_id_fkey",
    );
    expect(
      renderAddForeignKey(users, {
        columns: ["team_id"],
        referencedTable: "teams",
        referencedColumns: ["id"],
      }),
    ).toBe(
      'ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams" ("id");',
    );
    expect(renderDropForeignKey(users, "users_team_id_fkey")).toBe(
      'ALTER TABLE "users" DROP CONSTRAINT "users_team_id_fkey";',
    );
  });

  it("renders a full create-table statement", () => {
    const definition: TableDefinition = {
      object: { name: "pets", kind: "table" },
      columns: [
        {
          name: "name",
          typeName: "TEXT",
          nullable: true,
          primaryKey: false,
        },
        {
          name: "id",
          typeName: "integer",
          nullable: false,
          primaryKey: true,
        },
      ],
      foreignKeys: [
        {
          columns: ["owner_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          name: "fk_owner",
        },
      ],
    };

    expect(renderCreateTable(definition)).toBe(
      [
        'CREATE TABLE "pets" (',
        '  "name" TEXT,',
        '  "id" integer NOT NULL PRIMARY KEY,',
        '  CONSTRAINT "fk_owner" FOREIGN KEY ("owner_id") REFERENCES "users" ("id")',
        ");",
      ].join("\n"),
    );
  });
});

describe("engine-aware SQL preview", () => {
  it("uses backticks for MySQL", () => {
    const mysqlTable: ObjectRef = {
      database: "app",
      name: "notes",
      kind: "table",
    };
    expect(
      renderAddColumn(
        mysqlTable,
        { name: "body", typeName: "TEXT", nullable: true, primaryKey: false },
        "mysql",
      ),
    ).toBe("ALTER TABLE `app`.`notes` ADD COLUMN `body` TEXT;");
  });

  it("renders a PostgreSQL alteration as separate actions", () => {
    const table: ObjectRef = { schema: "public", name: "notes", kind: "table" };
    expect(
      renderAlterColumn(
        table,
        { name: "body", typeName: "text", nullable: false },
        "postgres",
      ),
    ).toBe(
      'ALTER TABLE "public"."notes" ALTER COLUMN "body" TYPE text, ALTER COLUMN "body" SET NOT NULL;',
    );
  });

  it("renders a MySQL alteration with MODIFY COLUMN", () => {
    const table: ObjectRef = { database: "app", name: "notes", kind: "table" };
    expect(
      renderAlterColumn(
        table,
        { name: "body", typeName: "TEXT", nullable: false },
        "mysql",
      ),
    ).toBe("ALTER TABLE `app`.`notes` MODIFY COLUMN `body` TEXT NOT NULL;");
  });
});
