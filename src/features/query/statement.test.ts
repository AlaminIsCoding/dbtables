import { describe, expect, it } from "vitest";

import {
  hasExecutableStatement,
  resolveRunSql,
  scanStatements,
  statementAtCursor,
} from "./statement";

describe("scanStatements", () => {
  it("splits multiple statements and excludes the trailing semicolon", () => {
    const ranges = scanStatements("SELECT 1;\nSELECT 2;");

    expect(ranges.map((range) => range.text)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a semicolon inside a string literal", () => {
    const ranges = scanStatements("SELECT ';' AS marker; SELECT 2;");

    expect(ranges.map((range) => range.text)).toEqual([
      "SELECT ';' AS marker",
      "SELECT 2",
    ]);
  });

  it("keeps a semicolon inside a line comment and a block comment", () => {
    const ranges = scanStatements(
      "SELECT 1 -- one; two;\n;\nSELECT 2 /* three; four */ + 1;",
    );

    expect(ranges.map((range) => range.text)).toEqual([
      "SELECT 1 -- one; two;",
      "SELECT 2 /* three; four */ + 1",
    ]);
  });

  it("ignores escaped quotes inside string and quoted identifiers", () => {
    const ranges = scanStatements(
      "SELECT 'it''s; fine', \"a;\"\"b\" FROM t; SELECT 2;",
    );

    expect(ranges.map((range) => range.text)).toEqual([
      "SELECT 'it''s; fine', \"a;\"\"b\" FROM t",
      "SELECT 2",
    ]);
  });

  it("keeps a semicolon inside a dollar-quoted body", () => {
    const ranges = scanStatements("SELECT $$a;b$$; SELECT 2;");

    expect(ranges.map((range) => range.text)).toEqual(["SELECT $$a;b$$", "SELECT 2"]);
  });

  it("does not treat a comment-only segment as an executable statement", () => {
    const ranges = scanStatements("SELECT 1; -- trailing note\n;");

    expect(ranges.map((range) => range.text)).toEqual(["SELECT 1"]);
    expect(hasExecutableStatement("SELECT 1; -- trailing note")).toBe(true);
    expect(hasExecutableStatement("-- just a note")).toBe(false);
    expect(hasExecutableStatement("   \n\t")).toBe(false);
  });

  it("includes a leading comment with the statement it precedes", () => {
    const ranges = scanStatements("-- explanation\nSELECT 1;");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].text).toBe("-- explanation\nSELECT 1");
  });
});

describe("statementAtCursor", () => {
  const sql = "SELECT 1;\nSELECT 2;";

  it("returns the statement containing the cursor", () => {
    expect(statementAtCursor(sql, 2)?.text).toBe("SELECT 1");
    expect(statementAtCursor(sql, 12)?.text).toBe("SELECT 2");
  });

  it("returns the preceding statement for a cursor in the gap", () => {
    // Offset 8 is the semicolon ending the first statement.
    expect(statementAtCursor(sql, 8)?.text).toBe("SELECT 1");
    // Offset 9 is the newline between the two statements.
    expect(statementAtCursor(sql, 9)?.text).toBe("SELECT 1");
  });

  it("returns the last statement for a cursor past the end", () => {
    expect(statementAtCursor(sql, sql.length + 50)?.text).toBe("SELECT 2");
  });

  it("returns null when there is no executable statement", () => {
    expect(statementAtCursor("-- only a comment", 3)).toBeNull();
    expect(statementAtCursor("", 0)).toBeNull();
  });
});

describe("resolveRunSql", () => {
  it("prefers a non-blank selection and trims it", () => {
    const resolved = resolveRunSql("SELECT 1;\nSELECT 2;", "  SELECT 9  ", 0);

    expect(resolved).toEqual({ sql: "SELECT 9", source: "selection" });
  });

  it("falls back to the statement at the cursor when nothing is selected", () => {
    const resolved = resolveRunSql("SELECT 1;\nSELECT 2;", "   ", 12);

    expect(resolved.sql).toBe("SELECT 2");
    expect(resolved.source).toBe("statement");
    expect(resolved.statement?.text).toBe("SELECT 2");
  });

  it("returns no SQL when the cursor is not in a statement", () => {
    expect(resolveRunSql("-- a note", "", 3)).toEqual({
      sql: "",
      source: "none",
    });
  });

  it("never runs a comment-only segment", () => {
    const resolved = resolveRunSql("SELECT 1; -- trailing note\n;", "", 9);

    expect(resolved.sql).toBe("SELECT 1");
  });
});
