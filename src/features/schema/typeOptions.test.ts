import { describe, expect, it } from "vitest";

import { typeOptionsFor } from "./typeOptions";

describe("typeOptionsFor", () => {
  it("offers engine-appropriate types", () => {
    const mysql = typeOptionsFor("mysql");
    const postgres = typeOptionsFor("postgres");
    const sqlite = typeOptionsFor("sqlite");

    // MySQL has no UUID type; PostgreSQL has neither BLOB nor DATETIME.
    expect(mysql).toContain("INT");
    expect(mysql).toContain("DATETIME");
    expect(mysql).not.toContain("UUID");
    expect(postgres).toContain("UUID");
    expect(postgres).toContain("BYTEA");
    expect(postgres).not.toContain("BLOB");
    expect(postgres).not.toContain("DATETIME");
    expect(sqlite).toContain("BLOB");
  });

  it("falls back to the SQLite list when the engine is unknown", () => {
    expect(typeOptionsFor(null)).toEqual(typeOptionsFor("sqlite"));
    expect(typeOptionsFor(undefined)).toEqual(typeOptionsFor("sqlite"));
  });
});
