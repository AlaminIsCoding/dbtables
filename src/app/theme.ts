/** Concrete theme applied to the document. */
export type Theme = "light" | "dark";

/** User-selectable theme preference; `system` follows the OS setting. */
export type ThemePreference = Theme | "system";

/** Key used to remember the chosen preference between launches. */
export const THEME_STORAGE_KEY = "dbtables.theme";

/** Reads the operating system color-scheme preference. */
export function getSystemTheme(): Theme {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  return "light";
}

/**
 * Resolves a preference to a concrete theme.
 *
 * The `system` argument is injectable so callers and tests can avoid touching
 * `window.matchMedia`.
 */
export function resolveTheme(
  preference: ThemePreference,
  system: Theme = getSystemTheme(),
): Theme {
  return preference === "system" ? system : preference;
}

/** Applies a concrete theme to a root element (the document by default). */
export function applyTheme(
  theme: Theme,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}
