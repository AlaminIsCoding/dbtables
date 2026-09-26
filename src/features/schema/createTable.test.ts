import { describe, expect, it } from "vitest";

import {
  createEmptyDraft,
  draftToTableDefinition,
  previewCreateTable,
  validateCreateTableDraft,
  type CreateTableDraft,
} from "./createTable";

function validDraft(): CreateTableDraft {
  return {
    name: "pets",
    columns: [
      {
        id: "c1",
        name: "id",
        typeName: "INTEGER",
        nullable: false,
        primaryKey: true,
        default: "",
      },
      {
        id: "c2",
        name: "name",
        typeName: "TEXT",
        nullable: true,
        primaryKey: false,
        default: "",
      },
    ],
    foreignKeys: [],
  };
}

describe("create-table draft", () => {
  it("starts with one empty column and is invalid until filled", () => {
    const draft = createEmptyDraft("c1");
    expect(draft.columns).toHaveLength(1);
    const validation = validateCreateTableDraft(draft);
    expect(validation.valid).toBe(false);
    expect(validation.tableName).toBe("Enter a table name.");
  });

  it("accepts a fully specified draft", () => {
    const validation = validateCreateTableDraft(validDraft());
    expect(validation).toEqual({
      valid: true,
      tableName: undefined,
      columns: {},
      foreignKeys: {},
      form: [],
    });
  });

  it("rejects duplicate column names", () => {
    const draft = validDraft();
    draft.columns[1].name = "id";
    const validation = validateCreateTableDraft(draft);
    expect(validation.valid).toBe(false);
    expect(validation.columns.c1).toBe("Duplicate column name.");
    expect(validation.columns.c2).toBe("Duplicate column name.");
  });

  it("requires exactly one primary key column", () => {
    const none = validDraft();
    none.columns[0].primaryKey = false;
    expect(validateCreateTableDraft(none).form).toContain(
      "Select one primary key column.",
    );

    const two = validDraft();
    two.columns[1].primaryKey = true;
    expect(validateCreateTableDraft(two).form).toContain(
      "Select exactly one primary key column.",
    );
  });

  it("validates foreign keys", () => {
    const draft = validDraft();
    draft.foreignKeys = [
      {
        id: "f1",
        name: "",
        column: "missing",
        referencedTable: "users",
        referencedColumn: "id",
        referencedSchema: "",
      },
    ];
    expect(validateCreateTableDraft(draft).foreignKeys.f1).toBe(
      "Local column is not one of this table's columns.",
    );
  });

  it("converts a valid draft and omits blank defaults/names", () => {
    const draft = validDraft();
    draft.columns[1].default = "  ";
    draft.foreignKeys = [
      {
        id: "f1",
        name: "",
        column: "id",
        referencedTable: "users",
        referencedColumn: "id",
        referencedSchema: "",
      },
    ];

    expect(draftToTableDefinition(draft)).toEqual({
      object: { name: "pets", kind: "table" },
      columns: [
        { name: "id", typeName: "INTEGER", nullable: false, primaryKey: true },
        { name: "name", typeName: "TEXT", nullable: true, primaryKey: false },
      ],
      foreignKeys: [
        {
          columns: ["id"],
          referencedTable: "users",
          referencedColumns: ["id"],
        },
      ],
    });
  });

  it("returns null and previews best-effort SQL", () => {
    const draft = validDraft();
    draft.name = "";
    expect(draftToTableDefinition(draft)).toBeNull();

    const preview = previewCreateTable(validDraft());
    expect(preview).toBe(
      [
        'CREATE TABLE "pets" (',
        '  "id" INTEGER NOT NULL PRIMARY KEY,',
        '  "name" TEXT',
        ");",
      ].join("\n"),
    );
  });
});
