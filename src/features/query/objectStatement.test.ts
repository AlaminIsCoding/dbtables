import { describe, expect, it } from "vitest";

import { quoteIdentifier, selectStatementFor } from "./objectStatement";

describe("quoteIdentifier", () => {
  it("wraps a plain name in double quotes", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
  });

  it("doubles embedded double quotes so a name cannot break out", () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
  });
});

describe("selectStatementFor", () => {
  it("builds a starter select for a table", () => {
    expect(selectStatementFor({ name: "users", kind: "table" })).toBe(
      'SELECT * FROM "users";',
    );
  });

  it("quotes a view name with special characters", () => {
    expect(selectStatementFor({ name: 'my "view"', kind: "view" })).toBe(
      'SELECT * FROM "my ""view""";',
    );
  });
});
