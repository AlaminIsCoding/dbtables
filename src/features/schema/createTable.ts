import type {
  ColumnDefinition,
  EngineId,
  ForeignKeyDefinition,
  TableDefinition,
} from "@/domain";

import { renderCreateTable } from "./sql";

/** One editable column row in the create-table form. */
export interface DraftColumn {
  id: string;
  name: string;
  typeName: string;
  nullable: boolean;
  primaryKey: boolean;
  default: string;
}

/** One editable foreign-key row in the create-table form. */
export interface DraftForeignKey {
  id: string;
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  referencedSchema: string;
}

/** Full create-table form state. */
export interface CreateTableDraft {
  name: string;
  columns: DraftColumn[];
  foreignKeys: DraftForeignKey[];
}

/** Per-field messages plus form-level errors. */
export interface CreateTableValidation {
  valid: boolean;
  tableName?: string;
  columns: Record<string, string>;
  foreignKeys: Record<string, string>;
  form: string[];
}

/** A fresh column row. `id` is caller-minted so it stays stable across edits. */
export function emptyDraftColumn(id: string): DraftColumn {
  return {
    id,
    name: "",
    typeName: "TEXT",
    nullable: true,
    primaryKey: false,
    default: "",
  };
}

/** A fresh foreign-key row. */
export function emptyDraftForeignKey(id: string): DraftForeignKey {
  return {
    id,
    name: "",
    column: "",
    referencedTable: "",
    referencedColumn: "",
    referencedSchema: "",
  };
}

/** A draft with one column row and no foreign keys. */
export function createEmptyDraft(
  columnId: string,
  tableName = "",
): CreateTableDraft {
  return { name: tableName, columns: [emptyDraftColumn(columnId)], foreignKeys: [] };
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Validates a create-table draft.
 *
 * Enforces the rules the backend would otherwise reject late: a table name, at
 * least one column, unique (case-insensitive) column names and types, exactly
 * one primary key column for SQLite, and fully specified foreign keys.
 */
export function validateCreateTableDraft(
  draft: CreateTableDraft,
): CreateTableValidation {
  const form: string[] = [];
  const columns: Record<string, string> = {};
  const foreignKeys: Record<string, string> = {};

  const tableName = isBlank(draft.name) ? "Enter a table name." : undefined;

  if (draft.columns.length === 0) {
    form.push("Add at least one column.");
  }

  const counts = new Map<string, number>();
  for (const column of draft.columns) {
    if (!isBlank(column.name)) {
      const key = column.name.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  for (const column of draft.columns) {
    if (isBlank(column.name)) {
      columns[column.id] = "Enter a column name.";
    } else if ((counts.get(column.name.trim().toLowerCase()) ?? 0) > 1) {
      columns[column.id] = "Duplicate column name.";
    } else if (isBlank(column.typeName)) {
      columns[column.id] = "Enter a column type.";
    }
  }

  if (draft.columns.length > 0) {
    const primaryKeys = draft.columns.filter((column) => column.primaryKey).length;
    if (primaryKeys !== 1) {
      form.push(
        primaryKeys === 0
          ? "Select one primary key column."
          : "Select exactly one primary key column.",
      );
    }
  }

  const known = new Set(
    draft.columns
      .map((column) => column.name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );

  for (const foreignKey of draft.foreignKeys) {
    if (
      isBlank(foreignKey.column) &&
      isBlank(foreignKey.referencedTable) &&
      isBlank(foreignKey.referencedColumn)
    ) {
      foreignKeys[foreignKey.id] = "Complete the foreign key or remove it.";
    } else if (isBlank(foreignKey.column)) {
      foreignKeys[foreignKey.id] = "Choose a local column.";
    } else if (!known.has(foreignKey.column.trim().toLowerCase())) {
      foreignKeys[foreignKey.id] = "Local column is not one of this table's columns.";
    } else if (isBlank(foreignKey.referencedTable)) {
      foreignKeys[foreignKey.id] = "Enter the referenced table.";
    } else if (isBlank(foreignKey.referencedColumn)) {
      foreignKeys[foreignKey.id] = "Enter the referenced column.";
    }
  }

  const valid =
    tableName === undefined &&
    form.length === 0 &&
    Object.keys(columns).length === 0 &&
    Object.keys(foreignKeys).length === 0;

  return { valid, tableName, columns, foreignKeys, form };
}

function draftColumnToDefinition(column: DraftColumn): ColumnDefinition {
  const fallback = column.default.trim();
  const definition: ColumnDefinition = {
    name: column.name.trim(),
    typeName: column.typeName.trim(),
    nullable: column.nullable,
    primaryKey: column.primaryKey,
  };
  if (fallback.length > 0) {
    definition.default = fallback;
  }
  return definition;
}

function draftForeignKeyToDefinition(
  foreignKey: DraftForeignKey,
): ForeignKeyDefinition {
  const definition: ForeignKeyDefinition = {
    columns: [foreignKey.column.trim()],
    referencedTable: foreignKey.referencedTable.trim(),
    referencedColumns: [foreignKey.referencedColumn.trim()],
  };
  const schema = foreignKey.referencedSchema.trim();
  if (schema.length > 0) {
    definition.referencedSchema = schema;
  }
  const name = foreignKey.name.trim();
  if (name.length > 0) {
    definition.name = name;
  }
  return definition;
}

/** Converts a valid draft to a {@link TableDefinition}; `null` when invalid. */
export function draftToTableDefinition(
  draft: CreateTableDraft,
): TableDefinition | null {
  if (!validateCreateTableDraft(draft).valid) {
    return null;
  }
  return {
    object: { name: draft.name.trim(), kind: "table" },
    columns: draft.columns.map(draftColumnToDefinition),
    foreignKeys: draft.foreignKeys.map(draftForeignKeyToDefinition),
  };
}

/** Best-effort SQL preview, tolerant of incomplete rows. */
export function previewCreateTable(
  draft: CreateTableDraft,
  engine?: EngineId | null,
): string {
  const definition: TableDefinition = {
    object: { name: draft.name.trim() || "new_table", kind: "table" },
    columns: draft.columns.map((column) => {
      const fallback = column.default.trim();
      const definitionColumn: ColumnDefinition = {
        name: column.name.trim() || "column_name",
        typeName: column.typeName.trim() || "TEXT",
        nullable: column.nullable,
        primaryKey: column.primaryKey,
      };
      if (fallback.length > 0) {
        definitionColumn.default = fallback;
      }
      return definitionColumn;
    }),
    foreignKeys: draft.foreignKeys.map(draftForeignKeyToDefinition),
  };
  return renderCreateTable(definition, engine);
}
