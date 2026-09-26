import { open, save } from "@tauri-apps/plugin-dialog";

/** File extensions offered for SQLite databases. */
const SQLITE_EXTENSIONS = ["sqlite", "sqlite3", "db", "db3"];

/** Normalizes the plugin's string-or-array return into a single path or null. */
function firstPath(selection: string | string[] | null): string | null {
  if (typeof selection === "string") {
    return selection;
  }
  if (Array.isArray(selection) && selection.length > 0) {
    return selection[0];
  }
  return null;
}

/**
 * Opens a native picker for an existing SQLite database file.
 *
 * Returns the chosen path, or `null` when the user cancels. The dialog runs in
 * the Rust process; no path is guessed and nothing is opened here.
 */
export async function pickExistingSqliteFile(): Promise<string | null> {
  const selection = await open({
    multiple: false,
    directory: false,
    title: "Open SQLite database",
    filters: [{ name: "SQLite database", extensions: SQLITE_EXTENSIONS }],
  });
  return firstPath(selection);
}

/**
 * Opens a native save dialog to choose the path for a new SQLite database.
 *
 * Returns the chosen path, or `null` when the user cancels. The file is not
 * created here; the backend SQLite driver creates it when the profile connects.
 */
export async function pickNewSqliteFile(): Promise<string | null> {
  const selection = await save({
    title: "Create SQLite database",
    defaultPath: "database.sqlite",
    filters: [{ name: "SQLite database", extensions: SQLITE_EXTENSIONS }],
  });
  return firstPath(selection);
}
