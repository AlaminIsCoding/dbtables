import { useMemo } from "react";

import { highlightSql } from "@/lib/sql-highlight";
import { cn } from "@/lib/utils";

export interface SqlCodeProps {
  /** SQL text to render with lightweight syntax highlighting. */
  sql: string;
  /** Extra classes for the `<pre>` block. */
  className?: string;
}

/**
 * Read-only SQL text with lightweight syntax highlighting.
 *
 * Intended for generated-statement previews (create table, pending ALTERs,
 * index DDL). The tokenizer is intentionally small: it colors keywords, types,
 * strings, numbers, and comments without pulling an editor into the tree.
 */
export function SqlCode({ sql, className }: SqlCodeProps) {
  const tokens = useMemo(() => highlightSql(sql), [sql]);
  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre",
        className,
      )}
    >
      <code>
        {tokens.map((token, index) => (
          <span key={index} className={token.className}>
            {token.text}
          </span>
        ))}
      </code>
    </pre>
  );
}
