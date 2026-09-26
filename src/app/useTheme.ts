import { useCallback, useEffect, useState } from "react";

import {
  applyTheme,
  getSystemTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemePreference,
} from "./theme";

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Storage can be unavailable (private mode, restricted webview); fall back.
  }

  return "system";
}

export interface UseThemeResult {
  /** Concrete theme currently applied. */
  theme: Theme;
  /** Stored preference, which may be `system`. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

/**
 * Tracks the light/dark preference and keeps the root `.dark` class in sync.
 *
 * The preference defaults to `system` and is remembered in local storage;
 * storage failures degrade to an in-memory preference instead of throwing.
 */
export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readStoredPreference,
  );
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const theme = resolveTheme(preference, systemTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () =>
      setSystemTheme(query.matches ? "dark" : "light");

    query.addEventListener?.("change", handleChange);

    return () => {
      query.removeEventListener?.("change", handleChange);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort; the in-memory preference still applies.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark");
  }, [theme, setPreference]);

  return { theme, preference, setPreference, toggleTheme };
}
