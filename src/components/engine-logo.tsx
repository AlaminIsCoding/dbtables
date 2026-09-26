import mysqlOriginal from "devicon/icons/mysql/mysql-original.svg";
import postgresqlOriginal from "devicon/icons/postgresql/postgresql-original.svg";
import sqliteOriginal from "devicon/icons/sqlite/sqlite-original.svg";

import type { EngineId } from "@/domain";
import { cn } from "@/lib/utils";

/**
 * Full-color engine brand marks from the Devicon icon set
 * (https://devicon.dev, MIT licensed). Displayed to identify an engine; the
 * marks remain the trademarks of their respective owners.
 */
const ENGINE_LOGOS: Record<EngineId, string> = {
  sqlite: sqliteOriginal,
  mysql: mysqlOriginal,
  postgres: postgresqlOriginal,
};

export interface EngineLogoProps {
  engine: EngineId;
  className?: string;
}

/** Brand mark for a database engine. Decorative: the label carries the name. */
export function EngineLogo({ engine, className }: EngineLogoProps) {
  return (
    <img
      src={ENGINE_LOGOS[engine]}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("size-5 shrink-0 object-contain", className)}
    />
  );
}
