import { describe, expect, it } from "vitest";

import { applyTheme, resolveTheme } from "./theme";

describe("theme utilities", () => {
  it("keeps an explicit preference regardless of the system theme", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("resolves the system preference to the provided system theme", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
  });

  it("applies and removes the dark class on the given root", () => {
    const root = document.createElement("div");

    applyTheme("dark", root);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");

    applyTheme("light", root);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.dataset.theme).toBe("light");
  });
});
