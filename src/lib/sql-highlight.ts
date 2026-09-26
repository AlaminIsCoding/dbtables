/** A highlighted SQL fragment: text plus an optional CSS class. */
export interface SqlToken {
  text: string;
  className?: string;
}

const KEYWORDS = new Set([
  "add",
  "all",
  "alter",
  "and",
  "as",
  "asc",
  "begin",
  "by",
  "cascade",
  "case",
  "check",
  "column",
  "commit",
  "constraint",
  "create",
  "default",
  "delete",
  "desc",
  "distinct",
  "drop",
  "else",
  "end",
  "exists",
  "foreign",
  "from",
  "group",
  "if",
  "in",
  "index",
  "inner",
  "insert",
  "into",
  "join",
  "key",
  "left",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "primary",
  "references",
  "rename",
  "returning",
  "right",
  "rollback",
  "select",
  "set",
  "table",
  "then",
  "to",
  "transaction",
  "type",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "view",
  "when",
  "where",
  "with",
]);

const TYPES = new Set([
  "bigint",
  "blob",
  "bool",
  "boolean",
  "char",
  "clob",
  "date",
  "datetime",
  "decimal",
  "double",
  "float",
  "int",
  "integer",
  "json",
  "jsonb",
  "numeric",
  "real",
  "serial",
  "smallint",
  "text",
  "time",
  "timestamp",
  "uuid",
  "varchar",
  "varying",
]);

const TOKEN_PATTERN = new RegExp(
  [
    "--[^\\n]*", // line comment
    "/\\*[\\s\\S]*?\\*/", // block comment
    "'(?:[^']|'')*'", // single-quoted string
    '"(?:[^"]|"")*"', // double-quoted identifier
    "`(?:[^`]|``)*`", // backtick identifier
    "\\b\\d+\\.?\\d*\\b", // number
    "[A-Za-z_][A-Za-z0-9_]*", // identifier / keyword
    "[(),;.\\[\\]=<>+\\-*/%]+", // punctuation
    "\\s+", // whitespace
    "[\\s\\S]", // any other single character
  ].join("|"),
  "g",
);

function classify(token: string): string | undefined {
  if (token.startsWith("--") || token.startsWith("/*")) {
    return "sql-cm";
  }
  const first = token[0];
  if (first === "'" || first === '"' || first === "`") {
    return "sql-str";
  }
  if (first >= "0" && first <= "9") {
    return "sql-num";
  }
  const lowered = token.toLowerCase();
  if (KEYWORDS.has(lowered)) {
    return "sql-kw";
  }
  if (TYPES.has(lowered)) {
    return "sql-ty";
  }
  return undefined;
}

/** Splits SQL text into classified tokens for a read-only highlighted preview. */
export function highlightSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const match of sql.matchAll(TOKEN_PATTERN)) {
    const text = match[0];
    tokens.push({ text, className: classify(text) });
  }
  return tokens;
}
