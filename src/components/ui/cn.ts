export type ClassValue = string | number | null | undefined | false | ClassValue[];

/**
 * Joins conditional class names into a single string.
 *
 * This is a dependency-free stand-in for the `clsx`/`tailwind-merge` helper
 * used by shadcn-style components. Later caller classes intentionally win on
 * specificity through ordering, and duplicate utilities are not de-duplicated.
 */
export function cn(...inputs: ClassValue[]): string {
  const classes: string[] = [];

  for (const input of inputs) {
    if (!input && input !== 0) {
      continue;
    }

    if (Array.isArray(input)) {
      const nested = cn(...input);
      if (nested) {
        classes.push(nested);
      }
      continue;
    }

    classes.push(String(input));
  }

  return classes.join(" ");
}
