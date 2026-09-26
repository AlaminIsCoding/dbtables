import { describe, expect, it } from "vitest";

import type { ConnectionProfile } from "../../domain";
import {
  MAX_PROFILE_NAME_LENGTH,
  defaultPortFor,
  describeDescriptor,
  describeProfile,
  descriptorFromDraft,
  draftFromProfile,
  emptyDraft,
  isServerEngine,
  toProfileInput,
  validateDraft,
  withEngine,
} from "./profileDraft";

const sqliteProfile: ConnectionProfile = {
  id: "p1",
  name: "Local app",
  descriptor: { engine: "sqlite", filePath: "C:/data/app.sqlite" },
};

const postgresProfile: ConnectionProfile = {
  id: "p2",
  name: "Reporting",
  descriptor: {
    engine: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "app",
    username: "app_user",
    tls: "preferred",
  },
};

describe("profile draft", () => {
  it("creates engine-appropriate defaults", () => {
    const sqlite = emptyDraft();
    expect(sqlite.engine).toBe("sqlite");
    expect(sqlite.port).toBe("");
    expect(sqlite.host).toBe("");

    const mysql = emptyDraft("mysql");
    expect(mysql.port).toBe("3306");
    expect(mysql.host).toBe("localhost");
    expect(mysql.tls).toBe("preferred");
    expect(mysql.password).toBe("");

    expect(isServerEngine("sqlite")).toBe(false);
    expect(isServerEngine("postgres")).toBe(true);
    expect(defaultPortFor("postgres")).toBe("5432");
  });

  it("switches engine and fills the default port when unchanged", () => {
    const switched = withEngine(emptyDraft("sqlite"), "postgres");
    expect(switched.engine).toBe("postgres");
    expect(switched.port).toBe("5432");
    expect(switched.host).toBe("localhost");

    const custom = withEngine({ ...emptyDraft("mysql"), port: "6000" }, "postgres");
    expect(custom.port).toBe("6000");
  });

  it("builds a secret-free draft from a saved profile", () => {
    const draft = draftFromProfile(postgresProfile);

    expect(draft.id).toBe("p2");
    expect(draft.name).toBe("Reporting");
    expect(draft.engine).toBe("postgres");
    expect(draft.host).toBe("db.example.com");
    expect(draft.port).toBe("5432");
    expect(draft.database).toBe("app");
    expect(draft.username).toBe("app_user");
    // The saved secret is never returned to the form.
    expect(draft.password).toBe("");
    expect(Object.values(draft)).not.toContain("hunter2");
  });

  it("validates sqlite drafts", () => {
    const draft = { ...emptyDraft("sqlite"), name: "Local", filePath: "C:/data/app.sqlite" };
    expect(validateDraft(draft)).toBeNull();

    expect(validateDraft({ ...draft, name: "   " })?.category).toBe("validation");
    expect(validateDraft({ ...draft, name: "n".repeat(MAX_PROFILE_NAME_LENGTH + 1) })?.category).toBe(
      "validation",
    );
    expect(validateDraft({ ...draft, filePath: "  " })?.category).toBe("validation");
  });

  it("validates server drafts", () => {
    const draft = draftFromProfile(postgresProfile);
    expect(validateDraft(draft)).toBeNull();

    expect(validateDraft({ ...draft, host: "" })?.category).toBe("validation");
    expect(validateDraft({ ...draft, username: " " })?.category).toBe("validation");
    expect(validateDraft({ ...draft, port: "0" })?.category).toBe("validation");
    expect(validateDraft({ ...draft, port: "70000" })?.category).toBe("validation");
    expect(validateDraft({ ...draft, port: "abc" })?.category).toBe("validation");
    expect(validateDraft({ ...draft, database: "   " })?.category).toBe("validation");
    // An absent database is valid.
    expect(validateDraft({ ...draft, database: "" })).toBeNull();
  });

  it("converts a draft to service input without a blank password", () => {
    const draft = { ...draftFromProfile(postgresProfile), password: "" };
    const input = toProfileInput(draft);

    expect(input.id).toBe("p2");
    expect(input.name).toBe("Reporting");
    expect(input.password).toBeUndefined();
    expect(input.descriptor).toEqual({
      engine: "postgres",
      host: "db.example.com",
      port: 5432,
      database: "app",
      username: "app_user",
      tls: "preferred",
    });
  });

  it("includes a non-empty password and omits a blank database", () => {
    const draft = {
      ...emptyDraft("mysql"),
      name: "Sales",
      username: "sales_user",
      password: "s3cret",
    };
    const input = toProfileInput(draft);

    expect(input.password).toBe("s3cret");
    expect(input.id).toBeUndefined();
    const descriptor = descriptorFromDraft(draft);
    expect(descriptor).toEqual({
      engine: "mysql",
      host: "localhost",
      port: 3306,
      database: undefined,
      username: "sales_user",
      tls: "preferred",
    });
  });

  it("describes profiles without exposing secrets", () => {
    expect(describeProfile(sqliteProfile)).toBe("C:/data/app.sqlite");
    expect(describeProfile(postgresProfile)).toBe("db.example.com:5432 / app");
    expect(describeDescriptor({ engine: "mysql", host: "h", port: 3306, username: "u", tls: "disabled" })).toBe(
      "h:3306",
    );
    expect(JSON.stringify(toProfileInput(draftFromProfile(postgresProfile)))).not.toContain(
      "password",
    );
  });
});
