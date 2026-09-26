import { useEffect, useMemo, useState } from "react";
import { getDefaultTheme, type Theme as GlideTheme } from "@glideapps/glide-data-grid";

/** Concrete theme applied to the document root. */
export type DocumentTheme = "light" | "dark";

interface ThemeFallbacks {
  background: string;
  card: string;
  muted: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  ring: string;
}

const LIGHT_FALLBACKS: ThemeFallbacks = {
  background: "#ffffff",
  card: "#fdfdfd",
  muted: "#f5f5f5",
  foreground: "#1a1a1a",
  mutedForeground: "#6b7280",
  border: "#e5e5e5",
  primary: "#333333",
  primaryForeground: "#fafafa",
  accent: "#f5f5f5",
  ring: "#a3a3a3",
};

const DARK_FALLBACKS: ThemeFallbacks = {
  background: "#252525",
  card: "#343434",
  muted: "#454545",
  foreground: "#fafafa",
  mutedForeground: "#a3a3a3",
  border: "rgba(255, 255, 255, 0.12)",
  primary: "#e5e5e5",
  primaryForeground: "#343434",
  accent: "#454545",
  ring: "#8a8a8a",
};

/** Reads the concrete theme currently applied to the document root. */
export function readDocumentTheme(): DocumentTheme {
  if (typeof document === "undefined") {
    return "light";
  }

  const root = document.documentElement;
  const markedDark =
    root.classList.contains("dark") || root.dataset.theme === "dark";

  return markedDark ? "dark" : "light";
}

/**
 * Resolves the document's light/dark theme and follows later changes.
 *
 * The grid cannot use Tailwind classes directly (it paints to a canvas), so it
 * observes the root `.dark`/`data-theme` markers rather than receiving React
 * theme state through props. This keeps the results feature decoupled from the
 * app shell's theme hook.
 */
export function useDocumentTheme(): DocumentTheme {
  const [theme, setTheme] = useState<DocumentTheme>(readDocumentTheme);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(() => {
      setTheme(readDocumentTheme());
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}

function readCssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Builds a Glide theme from the shadcn-style CSS custom properties so the grid
 * matches the surrounding shell in both light and dark mode.
 */
export function buildGlideTheme(theme: DocumentTheme): Partial<GlideTheme> {
  const fallbacks = theme === "dark" ? DARK_FALLBACKS : LIGHT_FALLBACKS;
  const cssVar = (name: string, fallback: string) => readCssVariable(name, fallback);

  return {
    ...getDefaultTheme(),
    accentColor: cssVar("--ring", fallbacks.ring),
    accentFg: cssVar("--primary-foreground", fallbacks.primaryForeground),
    accentLight: cssVar("--accent", fallbacks.accent),
    textDark: cssVar("--foreground", fallbacks.foreground),
    textMedium: cssVar("--muted-foreground", fallbacks.mutedForeground),
    textLight: cssVar("--muted-foreground", fallbacks.mutedForeground),
    textBubble: cssVar("--muted-foreground", fallbacks.mutedForeground),
    bgIconHeader: cssVar("--muted", fallbacks.muted),
    fgIconHeader: cssVar("--muted-foreground", fallbacks.mutedForeground),
    textHeader: cssVar("--muted-foreground", fallbacks.mutedForeground),
    textHeaderSelected: cssVar("--primary-foreground", fallbacks.primaryForeground),
    bgCell: cssVar("--background", fallbacks.background),
    bgCellMedium: cssVar("--card", fallbacks.card),
    bgHeader: cssVar("--card", fallbacks.card),
    bgHeaderHasFocus: cssVar("--accent", fallbacks.accent),
    bgHeaderHovered: cssVar("--accent", fallbacks.accent),
    bgBubble: cssVar("--muted", fallbacks.muted),
    bgBubbleSelected: cssVar("--accent", fallbacks.accent),
    bgSearchResult: cssVar("--accent", fallbacks.accent),
    borderColor: cssVar("--border", fallbacks.border),
    drilldownBorder: cssVar("--border", fallbacks.border),
    linkColor: cssVar("--primary", fallbacks.primary),
    headerBottomBorderColor: cssVar("--border", fallbacks.border),
    horizontalBorderColor: cssVar("--border", fallbacks.border),
    resizeIndicatorColor: cssVar("--primary", fallbacks.primary),
    baseFontStyle: "12px",
    headerFontStyle: "600 12px",
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
  };
}

/**
 * Theme for the results grid, rebuilt when the resolved document theme changes.
 * Falls back to a token-approximate palette when CSS variables are unavailable
 * (for example, in jsdom tests).
 */
export function useGlideTheme(): Partial<GlideTheme> {
  const theme = useDocumentTheme();

  return useMemo(() => buildGlideTheme(theme), [theme]);
}
