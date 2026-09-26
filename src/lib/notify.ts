import type { QueryError } from "@/domain";

/** Message severity accepted by the workspace message log. */
export type MessageLevel = "info" | "success" | "warning" | "error" | "notice";

/** Appends a message to the workspace message log. */
export type MessageLogger = (
  level: MessageLevel,
  text: string,
  detail?: string,
) => void;

/**
 * Detailed, single-line description of a normalized error for the message log:
 * the human message, the engine detail when it adds information, and the
 * category. Kept on one line so the drawer's detail row stays tidy.
 */
export function errorDetail(error: QueryError): string {
  const parts = [error.message];
  if (error.engineDetail && error.engineDetail !== error.message) {
    parts.push(error.engineDetail);
  }
  if (error.category) {
    parts.push(`(${error.category})`);
  }
  return parts.join(" · ");
}

/** Logs a normalized error under a short summary line. */
export function reportError(
  log: MessageLogger,
  summary: string,
  error: QueryError,
): void {
  log("error", summary, errorDetail(error));
}
