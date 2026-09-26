/**
 * Writes text to the system clipboard.
 *
 * Kept in its own module so feature tests can substitute it without a real
 * clipboard (jsdom does not implement the async Clipboard API). Rejections are
 * surfaced to the caller so the UI can show a non-blocking notice instead of
 * claiming the copy succeeded.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    throw new Error("Clipboard access is not available in this environment.");
  }

  await navigator.clipboard.writeText(text);
}
