import type { ColumnDefinition, ColumnInfo, ObjectRef } from "@/domain";

import {
  renderAddColumn,
  renderDropColumn,
  renderRenameColumn,
} from "./sql";

/**
 * A locally staged column edit.
 *
 * Edits are applied through separate `ALTER TABLE` calls, so they are kept in
 * order: a rename followed by a drop of the renamed column, for example, must
 * keep that sequence. `id` is stable for list rendering and discard.
 */
export type PendingColumnChange =
  | { id: string; kind: "add"; column: ColumnDefinition }
  | { id: string; kind: "rename"; from: string; to: string }
  | { id: string; kind: "drop"; column: string };

/** Engine-neutral column definition for a column discovered by inspection. */
export function columnToDefinition(
  column: ColumnInfo,
  primaryKey: boolean,
): ColumnDefinition {
  return {
    name: column.name,
    typeName: column.typeName?.trim() || "TEXT",
    nullable: column.nullable ?? true,
    primaryKey,
  };
}

/**
 * Applies the staged edits to the inspected column names and returns the names
 * the table will have once every change is applied.
 *
 * This models the same order the changes are applied in, so validation of a new
 * column name reflects what the database will actually see.
 */
export function pendingColumnNames(
  columns: readonly ColumnInfo[],
  changes: readonly PendingColumnChange[],
): string[] {
  const names = columns.map((column) => column.name);
  for (const change of changes) {
    switch (change.kind) {
      case "add":
        names.push(change.column.name);
        break;
      case "rename": {
        const index = names.findIndex((name) => name === change.from);
        if (index >= 0) {
          names[index] = change.to;
        }
        break;
      }
      case "drop": {
        const index = names.indexOf(change.column);
        if (index >= 0) {
          names.splice(index, 1);
        }
        break;
      }
    }
  }
  return names;
}

/** Case-insensitive membership test for an identifier list. */
export function isColumnNameTaken(
  name: string,
  names: readonly string[],
): boolean {
  const target = name.trim().toLowerCase();
  return names.some((candidate) => candidate.trim().toLowerCase() === target);
}

/** Returns a validation message for a column to add, or `null` when valid. */
export function validateNewColumn(
  name: string,
  typeName: string,
  names: readonly string[],
): string | null {
  if (name.trim().length === 0) {
    return "Enter a column name.";
  }
  if (typeName.trim().length === 0) {
    return "Enter a column type.";
  }
  if (isColumnNameTaken(name, names)) {
    return `Column “${name.trim()}” already exists.`;
  }
  return null;
}

/** Returns a validation message for renaming a column, or `null` when valid. */
export function validateRename(
  from: string,
  to: string,
  allNames: readonly string[],
): string | null {
  if (to.trim().length === 0) {
    return "Enter a new column name.";
  }
  const others = allNames.filter((name) => name !== from);
  if (isColumnNameTaken(to, others)) {
    return `Column “${to.trim()}” already exists.`;
  }
  return null;
}

/** Human-readable one-line description of a staged change. */
export function describePendingChange(change: PendingColumnChange): string {
  switch (change.kind) {
    case "add":
      return `Add ${change.column.name} ${
        change.column.typeName.trim() || "TEXT"
      }`;
    case "rename":
      return `Rename ${change.from} → ${change.to}`;
    case "drop":
      return `Drop ${change.column}`;
  }
}

/** SQL statements for the staged changes, in application order. */
export function pendingChangesToSql(
  object: ObjectRef,
  changes: readonly PendingColumnChange[],
): string[] {
  return changes.map((change) => {
    switch (change.kind) {
      case "add":
        return renderAddColumn(object, change.column);
      case "rename":
        return renderRenameColumn(object, change.from, change.to);
      case "drop":
        return renderDropColumn(object, change.column);
    }
  });
}
