import { describe, expect, it } from "vitest";

import type { ObjectRef, ScopeListing } from "../../domain";
import {
  buildExplorerGroups,
  filterObjects,
  objectKey,
  qualifiedObjectName,
} from "./tree";

const users: ObjectRef = { name: "users", kind: "table" };
const activeUsers: ObjectRef = { name: "active_users", kind: "view" };
const publicUsers: ObjectRef = {
  schema: "public",
  name: "users",
  kind: "table",
};
const auditUsers: ObjectRef = {
  schema: "audit",
  name: "users",
  kind: "table",
};
const appTables: ObjectRef = {
  database: "app",
  schema: "public",
  name: "orders",
  kind: "table",
};
const reportingTables: ObjectRef = {
  database: "reporting",
  schema: "public",
  name: "orders",
  kind: "table",
};

describe("filterObjects", () => {
  it("returns the input for an empty or whitespace filter", () => {
    const objects = [users, activeUsers];
    expect(filterObjects(objects, "")).toBe(objects);
    expect(filterObjects(objects, "   ")).toBe(objects);
  });

  it("matches names case-insensitively", () => {
    expect(filterObjects([users, activeUsers], "ACTIVE")).toEqual([activeUsers]);
  });

  it("matches schema and database names", () => {
    const objects = [publicUsers, auditUsers];
    expect(filterObjects(objects, "audit")).toEqual([auditUsers]);
  });
});

describe("qualifiedObjectName", () => {
  it("joins only the namespaces the engine exposes", () => {
    expect(qualifiedObjectName(users)).toBe("users");
    expect(qualifiedObjectName(publicUsers)).toBe("public.users");
    expect(qualifiedObjectName(appTables)).toBe("app.public.orders");
  });
});

describe("objectKey", () => {
  it("distinguishes objects that differ only by scope or kind", () => {
    expect(objectKey(publicUsers)).not.toBe(objectKey(auditUsers));
    expect(objectKey(users)).not.toBe(
      objectKey({ ...users, kind: "view" }),
    );
  });
});

describe("buildExplorerGroups", () => {
  it("uses one flat group for an engine without scopes", () => {
    const groups = buildExplorerGroups(null, [users, activeUsers], "");

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Tables & views");
    expect(groups[0].objects).toEqual([users, activeUsers]);
  });

  it("groups by schema and omits empty groups", () => {
    const listing: ScopeListing = { schemas: ["public", "audit", "empty"] };
    const groups = buildExplorerGroups(
      listing,
      [publicUsers, auditUsers],
      "",
    );

    expect(groups.map((group) => group.label)).toEqual(["public", "audit"]);
    expect(groups[0].objects).toEqual([publicUsers]);
  });

  it("groups by database and nests schemas when both are exposed", () => {
    const listing: ScopeListing = {
      databases: ["app", "reporting"],
      schemas: ["public"],
    };
    const groups = buildExplorerGroups(
      listing,
      [appTables, reportingTables],
      "",
    );

    expect(groups.map((group) => group.label)).toEqual(["app", "reporting"]);
    expect(groups[0].objects).toEqual([]);
    expect(groups[0].groups[0].label).toBe("public");
    expect(groups[0].groups[0].objects).toEqual([appTables]);
  });

  it("drops group headers that filtering empties", () => {
    const listing: ScopeListing = { schemas: ["public", "audit"] };
    const groups = buildExplorerGroups(listing, [publicUsers, auditUsers], "audit");

    expect(groups.map((group) => group.label)).toEqual(["audit"]);
  });
});
