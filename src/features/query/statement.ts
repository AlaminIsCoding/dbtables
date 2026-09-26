/**
 * Current-statement and selection detection for the Run command.
 *
 * The editor must never silently execute text the user did not intend. This
 * module is a small, side-effect-free SQL scanner that:
 *
 * - splits a document into statement ranges without being fooled by a
 *   semicolon inside a string, quoted identifier, comment, or dollar-quoted
 *   body;
 * - drops statement ranges that contain only comments/whitespace, so a
 *   trailing `-- note` is never sent to the database as a statement; and
 * - resolves what Run should execute: the selection when one exists, otherwise
 *   the statement the cursor is inside.
 *
 * It intentionally does not attempt to parse SQL. It only tracks the lexical
 * regions that can hide a statement separator, which is all "which statement
 * is under the cursor?" needs.
 */

/** A contiguous SQL statement located in a document. */
export interface StatementRange {
  /** Offset of the statement's first content character (may be a leading comment). */
  start: number;
  /** Offset just past the last content character; excludes a trailing semicolon. */
  end: number;
  /** Statement text with surrounding whitespace removed. */
  text: string;
}

/** Where the SQL to execute came from. */
export type RunSource = "selection" | "statement" | "none";

/** The resolved Run intent for a document. */
export interface ResolvedRun {
  /** SQL text to execute; empty when there is nothing safe to run. */
  sql: string;
  /** Whether the text came from a selection, a statement, or nothing. */
  source: RunSource;
  /** The statement range when `source` is `"statement"`. */
  statement?: StatementRange;
}

/** A lexical region that can contain a semicolon without ending a statement. */
interface ProtectedSpan {
  /** Offset just past the region. */
  end: number;
  /** Whether the region is a comment (not executable code). */
  isComment: boolean;
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function lineCommentEnd(sql: string, from: number): number {
  const newline = sql.indexOf("\n", from);
  return newline === -1 ? sql.length : newline;
}

function quotedEnd(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      // A doubled quote is an escaped quote, not the end of the literal.
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function bracketedEnd(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "]") {
      if (sql[index + 1] === "]") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/** Returns the end of a PostgreSQL dollar-quoted body, or `null` if none starts here. */
function dollarQuotedEnd(sql: string, start: number): number | null {
  const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start));
  if (!open) {
    return null;
  }
  const delimiter = open[0];
  const close = sql.indexOf(delimiter, start + delimiter.length);
  return close === -1 ? sql.length : close + delimiter.length;
}

/**
 * If a protected region (comment, quoted literal, or quoted identifier) begins
 * at `index`, returns the offset just past it; otherwise returns `null`.
 */
function skipProtected(sql: string, index: number): ProtectedSpan | null {
  const character = sql[index];
  const next = sql[index + 1];

  if (character === "-" && next === "-") {
    return { end: lineCommentEnd(sql, index + 2), isComment: true };
  }
  if (character === "#") {
    return { end: lineCommentEnd(sql, index + 1), isComment: true };
  }
  if (character === "/" && next === "*") {
    const close = sql.indexOf("*/", index + 2);
    return { end: close === -1 ? sql.length : close + 2, isComment: true };
  }
  if (character === "'" || character === '"' || character === "`") {
    return { end: quotedEnd(sql, index, character), isComment: false };
  }
  if (character === "[") {
    return { end: bracketedEnd(sql, index), isComment: false };
  }
  if (character === "$") {
    const end = dollarQuotedEnd(sql, index);
    if (end !== null) {
      return { end, isComment: false };
    }
  }
  return null;
}

/**
 * Splits a document into executable statements.
 *
 * Semicolons inside comments, string literals, quoted identifiers, and
 * dollar-quoted bodies are ignored. A range is emitted only when the statement
 * contains at least one non-comment character, so a segment that is only a
 * comment or whitespace is never treated as runnable SQL.
 */
export function scanStatements(sql: string): StatementRange[] {
  const ranges: StatementRange[] = [];
  let start = -1;
  let lastContentEnd = -1;
  let hasCode = false;
  let index = 0;

  while (index < sql.length) {
    const span = skipProtected(sql, index);
    if (span) {
      if (start === -1) {
        start = index;
      }
      if (!span.isComment) {
        hasCode = true;
      }
      lastContentEnd = span.end;
      index = span.end;
      continue;
    }

    if (sql[index] === ";") {
      if (hasCode && start !== -1) {
        ranges.push({
          start,
          end: lastContentEnd,
          text: sql.slice(start, lastContentEnd).trim(),
        });
      }
      start = -1;
      lastContentEnd = -1;
      hasCode = false;
      index += 1;
      continue;
    }

    if (!isWhitespace(sql[index])) {
      if (start === -1) {
        start = index;
      }
      hasCode = true;
      lastContentEnd = index + 1;
    }
    index += 1;
  }

  if (hasCode && start !== -1) {
    ranges.push({
      start,
      end: lastContentEnd,
      text: sql.slice(start, lastContentEnd).trim(),
    });
  }

  return ranges;
}

/** Whether a document contains at least one executable statement. */
export function hasExecutableStatement(sql: string): boolean {
  return scanStatements(sql).length > 0;
}

/**
 * Finds the statement containing `cursor`.
 *
 * A cursor inside a statement returns that statement. A cursor in the
 * whitespace between statements returns the nearest preceding statement, or
 * the first statement when the cursor precedes all of them. `null` means the
 * document has no executable statement.
 */
export function statementAtCursor(
  sql: string,
  cursor: number,
): StatementRange | null {
  const ranges = scanStatements(sql);
  if (ranges.length === 0) {
    return null;
  }

  const position = Math.max(0, Math.min(cursor, sql.length));

  for (const range of ranges) {
    if (position >= range.start && position <= range.end) {
      return range;
    }
  }

  let preceding: StatementRange | null = null;
  for (const range of ranges) {
    if (range.end < position) {
      preceding = range;
    }
  }
  return preceding ?? ranges[0];
}

/**
 * Resolves what the Run command should execute.
 *
 * A non-blank selection always wins and is executed exactly as selected. With
 * no selection, the statement under the cursor is used. When neither exists the
 * result carries empty SQL and callers must not execute anything.
 */
export function resolveRunSql(
  sql: string,
  selection: string,
  cursor: number,
): ResolvedRun {
  const selected = selection.trim();
  if (selected.length > 0) {
    return { sql: selected, source: "selection" };
  }

  const statement = statementAtCursor(sql, cursor);
  if (!statement) {
    return { sql: "", source: "none" };
  }

  return { sql: statement.text, source: "statement", statement };
}
