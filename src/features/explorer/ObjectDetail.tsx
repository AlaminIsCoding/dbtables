import { cn } from "../../components/ui/cn";
import type {
  ColumnInfo,
  ConstraintInfo,
  ConstraintKind,
  IndexInfo,
  ObjectRef,
  TableDescription,
} from "../../domain";
import { qualifiedObjectName } from "./tree";
import type { ExplorerDetailState } from "./useExplorer";

export interface ObjectDetailProps {
  /** Object the detail panel describes, or `null` when nothing is selected. */
  object: ObjectRef | null;
  /** Detail loading/ready/error state for the selected object. */
  state: ExplorerDetailState;
  /** Opens the read-only table data browser for the selected object. */
  onBrowseTable?: (object: ObjectRef) => void;
  className?: string;
}

const CONSTRAINT_LABELS: Record<ConstraintKind, string> = {
  primary_key: "Primary key",
  foreign_key: "Foreign key",
  unique: "Unique",
  check: "Check",
};

function scopeText(object: ObjectRef): string | null {
  const parts = [object.database, object.schema].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(".") : null;
}

function ColumnRow({
  column,
  isPrimaryKey,
}: {
  column: ColumnInfo;
  isPrimaryKey: boolean;
}) {
  const nullability =
    column.nullable === false
      ? "NOT NULL"
      : column.nullable === true
        ? "NULL"
        : null;

  return (
    <li className="flex items-center gap-2 border-b border-border/50 py-0.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {column.name}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {column.typeName ?? "-"}
      </span>
      {isPrimaryKey ? (
        <span className="shrink-0 rounded-sm bg-accent px-1 text-[9px] font-semibold uppercase">
          PK
        </span>
      ) : null}
      {nullability ? (
        <span className="shrink-0 text-[9px] text-muted-foreground">
          {nullability}
        </span>
      ) : null}
    </li>
  );
}

function IndexRow({ index }: { index: IndexInfo }) {
  const columns = index.columns ?? [];
  return (
    <li className="border-b border-border/50 py-0.5 last:border-b-0">
      <span className="font-mono text-[11px]">{index.name}</span>
      <span className="ml-1 text-[10px] text-muted-foreground">
        ({columns.length > 0 ? columns.join(", ") : "expression"})
      </span>
      {index.unique ? (
        <span className="ml-1 text-[9px] uppercase text-muted-foreground">
          unique
        </span>
      ) : null}
      {index.primary ? (
        <span className="ml-1 text-[9px] uppercase text-muted-foreground">
          primary
        </span>
      ) : null}
    </li>
  );
}

function ConstraintRow({ constraint }: { constraint: ConstraintInfo }) {
  const columns = constraint.columns ?? [];
  const reference =
    constraint.kind === "foreign_key" && constraint.referencedTable
      ? `→ ${
          constraint.referencedSchema
            ? `${constraint.referencedSchema}.`
            : ""
        }${constraint.referencedTable}${
          constraint.referencedColumns && constraint.referencedColumns.length > 0
            ? `(${constraint.referencedColumns.join(", ")})`
            : ""
        }`
      : null;

  return (
    <li className="border-b border-border/50 py-0.5 last:border-b-0">
      <span className="font-mono text-[11px]">{constraint.name}</span>
      <span className="ml-1 text-[10px] text-muted-foreground">
        {CONSTRAINT_LABELS[constraint.kind]}
        {columns.length > 0 ? ` (${columns.join(", ")})` : ""}
      </span>
      {reference ? (
        <span className="ml-1 text-[10px] text-muted-foreground">
          {reference}
        </span>
      ) : null}
      {constraint.definition ? (
        <span className="ml-1 font-mono text-[10px] text-muted-foreground">
          {constraint.definition}
        </span>
      ) : null}
    </li>
  );
}

function Description({
  object,
  description,
  onBrowseTable,
}: {
  object: ObjectRef;
  description: TableDescription;
  onBrowseTable?: (object: ObjectRef) => void;
}) {
  const primaryKey = description.primaryKeyColumns ?? [];
  const scope = scopeText(object);

  return (
    <div className="flex flex-col gap-2 p-2">
      <div>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-semibold">
            {qualifiedObjectName(object)}
          </p>
          {onBrowseTable ? (
            <button
              type="button"
              onClick={() => onBrowseTable(object)}
              className="shrink-0 rounded-sm border border-input px-1.5 py-0.5 text-[10px] hover:bg-accent"
            >
              Browse data
            </button>
          ) : null}
        </div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {object.kind}
          {scope ? ` · ${scope}` : ""}
        </p>
      </div>

      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Columns
        </h3>
        {description.columns.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No columns.</p>
        ) : (
          <ul aria-label="Columns" className="flex flex-col">
            {description.columns.map((column) => (
              <ColumnRow
                key={column.name}
                column={column}
                isPrimaryKey={primaryKey.includes(column.name)}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Primary key
        </h3>
        <p className="text-[11px]">
          {primaryKey.length > 0 ? primaryKey.join(", ") : "None"}
        </p>
      </section>

      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Indexes
        </h3>
        {description.indexes === undefined ? (
          <p className="text-[11px] text-muted-foreground">
            Not supported for this object.
          </p>
        ) : description.indexes.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No indexes.</p>
        ) : (
          <ul aria-label="Indexes" className="flex flex-col">
            {description.indexes.map((index) => (
              <IndexRow key={index.name} index={index} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Constraints
        </h3>
        {description.constraints === undefined ? (
          <p className="text-[11px] text-muted-foreground">
            Not supported for this object.
          </p>
        ) : description.constraints.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No constraints.</p>
        ) : (
          <ul aria-label="Constraints" className="flex flex-col">
            {description.constraints.map((constraint) => (
              <ConstraintRow key={constraint.name} constraint={constraint} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Detail panel for the selected table/view.
 *
 * Columns, primary key, indexes, and constraints are shown when available.
 * Absent index/constraint metadata is presented as "not supported" so an engine
 * limitation is never mistaken for an object that has none.
 */
export function ObjectDetail({
  object,
  state,
  onBrowseTable,
  className,
}: ObjectDetailProps) {
  return (
    <section
      aria-label="Object details"
      className={cn("border-t border-sidebar-border", className)}
    >
      <h2 className="flex h-7 items-center px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Details
      </h2>

      {object === null ? (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">
          Select a table or view to see its columns, keys, indexes, and
          constraints.
        </p>
      ) : state.status === "loading" ? (
        <p
          role="status"
          aria-live="polite"
          className="px-3 pb-2 text-[11px] text-muted-foreground"
        >
          Loading details for {object.name}…
        </p>
      ) : state.status === "error" ? (
        <div role="alert" className="px-3 pb-2">
          <p className="text-[11px] text-destructive">{state.error.message}</p>
        </div>
      ) : state.status === "ready" ? (
        <Description
          object={object}
          description={state.description}
          onBrowseTable={onBrowseTable}
        />
      ) : (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground">
          Select a table or view to see its columns, keys, indexes, and
          constraints.
        </p>
      )}
    </section>
  );
}
