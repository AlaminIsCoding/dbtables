import type { ErrorCategory, QueryError } from "../domain";

const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  "connection",
  "authentication",
  "configuration",
  "syntax",
  "validation",
  "permission",
  "constraint",
  "locking",
  "timeout",
  "cancelled",
  "transport",
  "unsupported",
  "internal",
];

function isErrorCategory(value: unknown): value is ErrorCategory {
  return (
    typeof value === "string" &&
    (ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Whether an unknown rejection is already a normalized {@link QueryError}.
 *
 * Tauri rejects a command that returns `Err(QueryError)` with the serialized
 * error value rather than a JavaScript `Error`, so features need this guard.
 */
export function isQueryError(value: unknown): value is QueryError {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { category?: unknown; message?: unknown };
  return isErrorCategory(candidate.category) && typeof candidate.message === "string";
}

/**
 * Coerces a rejected command into a normalized {@link QueryError}.
 *
 * A structured backend error passes through unchanged; transport-level or
 * unexpected failures become an `internal` error with a safe message.
 */
export function toQueryError(error: unknown): QueryError {
  if (isQueryError(error)) {
    return error;
  }

  if (error instanceof Error && error.message.length > 0) {
    return { category: "internal", message: error.message };
  }

  if (typeof error === "string" && error.length > 0) {
    return { category: "internal", message: error };
  }

  return { category: "internal", message: "The backend request failed." };
}
