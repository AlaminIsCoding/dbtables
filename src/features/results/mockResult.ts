import type { CellValue, ColumnInfo, Row } from "../../domain";
import type { ResultSet } from "./resultSet";

/** Default number of generated mock rows. */
export const MOCK_ROW_COUNT = 120;

/** Representative multi-line value exercised by the long-value overlay. */
export const MOCK_LONG_TEXT = [
  "Enterprise migration notes: the customer reported slow exports during month-end close.",
  "Investigate index coverage on (tenant_id, created_at) and consider a partial index for active rows.",
  "Follow up with the platform team about the archived attachment table before the next maintenance window.",
].join("\n");

/** Value chosen to exceed JavaScript's safe-integer range. */
export const MOCK_BIG_DECIMAL = "12345678901234567890.12";

/** Dynamic mock columns spanning common database scalar and structured types. */
export const MOCK_COLUMNS: readonly ColumnInfo[] = [
  { name: "id", typeName: "INTEGER", nullable: false },
  { name: "name", typeName: "TEXT", nullable: false },
  { name: "email", typeName: "TEXT", nullable: true },
  { name: "status", typeName: "TEXT", nullable: false },
  { name: "balance", typeName: "DECIMAL(12, 2)", nullable: true },
  { name: "rating", typeName: "REAL", nullable: true },
  { name: "active", typeName: "BOOLEAN", nullable: false },
  { name: "metadata", typeName: "JSON", nullable: true },
  { name: "notes", typeName: "TEXT", nullable: true },
  { name: "created_at", typeName: "TIMESTAMP", nullable: false },
  { name: "avatar", typeName: "BLOB", nullable: true },
];

const STATUSES = ["active", "pending", "suspended", "invited"] as const;

function nameFor(index: number): string {
  return `Customer ${String(index + 1).padStart(4, "0")}`;
}

function createdAtFor(index: number): string {
  const day = String((index % 28) + 1).padStart(2, "0");
  const hour = String(index % 24).padStart(2, "0");
  const minute = String((index * 7) % 60).padStart(2, "0");

  return `2026-01-${day}T${hour}:${minute}:00Z`;
}

function metadataFor(index: number): string {
  return JSON.stringify({
    plan: index % 2 === 0 ? "pro" : "free",
    seats: (index % 9) + 1,
    tags: ["beta", `cohort-${index % 4}`],
  });
}

function buildRow(index: number): Row {
  const id = index + 1;
  const name = nameFor(index);
  // Row 1 is a deliberate null showcase; other nulls spread through the set.
  const nullShowcase = index === 1;

  const idCell: CellValue = { type: "integer", value: id };
  const nameCell: CellValue = { type: "text", value: name };
  const email: CellValue =
    nullShowcase || index % 7 === 3
      ? { type: "null" }
      : { type: "text", value: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.com` };
  const status: CellValue = {
    type: "text",
    value: STATUSES[index % STATUSES.length],
  };
  const balance: CellValue =
    nullShowcase || index % 11 === 5
      ? { type: "null" }
      : {
          type: "decimal",
          value: index === 0 ? MOCK_BIG_DECIMAL : (id * 123.45).toFixed(2),
        };
  const rating: CellValue =
    nullShowcase || index % 5 === 0
      ? { type: "null" }
      : { type: "float", value: Math.round((id * 37) % 500) / 100 };
  const active: CellValue = { type: "boolean", value: index % 2 === 0 };
  const metadata: CellValue =
    nullShowcase || index % 6 === 3
      ? { type: "null" }
      : { type: "text", value: metadataFor(index) };
  const notes: CellValue =
    index === 0
      ? { type: "text", value: MOCK_LONG_TEXT }
      : nullShowcase || index % 9 === 0
        ? { type: "null" }
        : { type: "text", value: `Follow-up scheduled for account ${id}.` };
  const createdAt: CellValue = { type: "text", value: createdAtFor(index) };
  const avatar: CellValue =
    index % 13 === 0
      ? {
          type: "bytes",
          value: [0x89, 0x50, 0x4e, 0x47, index % 256, 0x0d, 0x0a, 0x1a, 0x0a],
        }
      : { type: "null" };

  return [
    idCell,
    nameCell,
    email,
    status,
    balance,
    rating,
    active,
    metadata,
    notes,
    createdAt,
    avatar,
  ];
}

/**
 * Builds a deterministic mock result set with representative values.
 *
 * The output is stable across calls so tests and screenshots do not change
 * between runs. It intentionally includes nulls, long text, structured JSON,
 * a large decimal, and binary values to exercise the grid and its overlay.
 */
export function createMockResultSet(rowCount: number = MOCK_ROW_COUNT): ResultSet {
  const rows: Row[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    rows.push(buildRow(index));
  }

  return {
    columns: MOCK_COLUMNS.map((column) => ({ ...column })),
    rows,
    truncated: false,
  };
}
