import type { EngineId } from "@/domain";

/** Supported engines, in picker/menu order. */
export const ENGINE_IDS: readonly EngineId[] = ["sqlite", "mysql", "postgres"];

/** Human-readable engine names. */
export const ENGINE_LABELS: Record<EngineId, string> = {
  sqlite: "SQLite",
  mysql: "MySQL",
  postgres: "PostgreSQL",
};
