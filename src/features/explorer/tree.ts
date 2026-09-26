import type { ObjectRef, ScopeListing } from "../../domain";

/**
 * Stable key for an object in the explorer tree.
 *
 * Two objects with the same name but different kinds, schemas, or databases are
 * distinct rows, so every scope component participates in the key.
 */
export function objectKey(object: ObjectRef): string {
  return [
    object.kind,
    object.database ?? "",
    object.schema ?? "",
    object.name,
  ].join("\u0000");
}

/** Qualified display name including any database/schema the engine exposes. */
export function qualifiedObjectName(object: ObjectRef): string {
  return [object.database, object.schema, object.name]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(".");
}

/**
 * Filters objects by a case-insensitive substring of name, schema, or database.
 *
 * An empty/whitespace filter returns the input unchanged, so clearing the field
 * never hides objects.
 */
export function filterObjects(
  objects: ObjectRef[],
  filter: string,
): ObjectRef[] {
  const query = filter.trim().toLowerCase();
  if (query.length === 0) {
    return objects;
  }

  return objects.filter((object) =>
    [object.name, object.schema, object.database]
      .filter((part): part is string => typeof part === "string")
      .some((part) => part.toLowerCase().includes(query)),
  );
}

/**
 * One node of the explorer tree.
 *
 * `objects` are the tables/views directly under this node; `groups` are nested
 * database/schema nodes (used when an engine exposes both namespaces).
 */
export interface ExplorerGroup {
  /** Stable key for React and expansion state. */
  id: string;
  /** User-facing group label. */
  label: string;
  /** Objects directly contained by this group. */
  objects: ObjectRef[];
  /** Nested groups, when a database contains schemas. */
  groups: ExplorerGroup[];
}

function schemaGroups(
  schemas: string[],
  objects: ObjectRef[],
  idPrefix: string,
): ExplorerGroup[] {
  return schemas
    .map((schema) => ({
      id: `${idPrefix}schema:${schema}`,
      label: schema,
      objects: objects.filter((object) => object.schema === schema),
      groups: [],
    }))
    .filter((group) => group.objects.length > 0);
}

/**
 * Builds the grouped tree for the visible objects.
 *
 * Grouping follows the engine's exposed scopes: MySQL-style databases nest
 * schemas when both are exposed, PostgreSQL-style schemas group directly, and
 * an engine with neither (SQLite) gets one flat group. Groups that contain no
 * visible objects after filtering are omitted so a filter never leaves empty
 * headers behind.
 */
export function buildExplorerGroups(
  listing: ScopeListing | null,
  objects: ObjectRef[],
  filter: string,
): ExplorerGroup[] {
  const visible = filterObjects(objects, filter);
  const databases = listing?.databases ?? [];
  const schemas = listing?.schemas ?? [];

  if (databases.length > 0) {
    const groups = databases
      .map((database) => {
        const inDatabase = visible.filter(
          (object) => object.database === database,
        );
        const nested =
          schemas.length > 0
            ? schemaGroups(schemas, inDatabase, `${database}:`)
            : [];

        return {
          id: `database:${database}`,
          label: database,
          objects: nested.length > 0 ? [] : inDatabase,
          groups: nested,
        };
      })
      .filter((group) => group.objects.length > 0 || group.groups.length > 0);

    return groups;
  }

  if (schemas.length > 0) {
    const groups = schemaGroups(schemas, visible, "");
    const ungrouped = visible.filter(
      (object) =>
        object.schema === undefined || !schemas.includes(object.schema),
    );
    if (ungrouped.length > 0) {
      groups.push({
        id: "schema:",
        label: "Other",
        objects: ungrouped,
        groups: [],
      });
    }
    return groups;
  }

  if (visible.length === 0) {
    return [];
  }

  return [
    { id: "objects", label: "Tables & views", objects: visible, groups: [] },
  ];
}
