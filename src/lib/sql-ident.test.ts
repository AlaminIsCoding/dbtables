import { describe, expect, it } from "vitest";

import { quoteIdentifierFor, quotedObjectName } from "./sql-ident";

describe("quoteIdentifierFor", () => {
  it("uses backticks for MySQL and double quotes otherwise", () => {
    expect(quoteIdentifierFor("mysql", "notes")).toBe("`notes`");
    expect(quoteIdentifierFor("postgres", "notes")).toBe('"notes"');
    expect(quoteIdentifierFor("sqlite", "notes")).toBe('"notes"');
    expect(quoteIdentifierFor(null, "notes")).toBe('"notes"');
  });

  it("doubles embedded quote characters", () => {
    expect(quoteIdentifierFor("mysql", "we`ird")).toBe("`we``ird`");
    expect(quoteIdentifierFor("postgres", 'we"ird')).toBe('"we""ird"');
  });
});

describe("quotedObjectName", () => {
  it("qualifies the schema for PostgreSQL", () => {
    expect(
      quotedObjectName("postgres", { kind: "table", name: "notes", schema: "public" }),
    ).toBe('"public"."notes"');
  });

  it("qualifies the database for MySQL with backticks", () => {
    expect(
      quotedObjectName("mysql", { kind: "table", name: "notes", database: "app" }),
    ).toBe("`app`.`notes`");
  });

  it("uses the bare quoted name for SQLite", () => {
    expect(quotedObjectName("sqlite", { kind: "table", name: "notes" })).toBe(
      '"notes"',
    );
  });
});
