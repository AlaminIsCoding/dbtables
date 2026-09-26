/**
 * Frontend-safe normalized domain types.
 *
 * These mirror the serializable Rust types in `src-tauri/src/domain/**` and are
 * the only database-domain shapes that may cross the Tauri IPC boundary. They
 * contain plain data only: no driver-native connection/pool objects and no
 * secret values. Passwords and other credentials stay in the Rust backend.
 */

/** Stable identifier for a supported database engine. */
export type EngineId = "sqlite" | "mysql" | "postgres";

/**
 * Explicit description of what an engine supports.
 *
 * A `false` value means "not supported (or not confirmed by the driver)".
 */
export interface EngineCapabilities {
  /** Supports explicit begin/commit/rollback transactions. */
  transactions: boolean;
  /** DDL statements participate in transactions. */
  ddlTransactions: boolean;
  /** Supports savepoints within an explicit transaction. */
  savepoints: boolean;
  /** A running operation can be cancelled through the driver. */
  cancellation: boolean;
  /** Exposes named schemas separately from databases/catalogs. */
  schemas: boolean;
  /** A single connection can address more than one database/catalog. */
  multipleDatabases: boolean;
  /** TLS/SSL connections are supported by the driver configuration. */
  tls: boolean;
}

/** Requested TLS/SSL behavior; mirrors common driver terminology. */
export type TlsMode =
  | "disabled"
  | "preferred"
  | "required"
  | "verify_ca"
  | "verify_full";

/** Local SQLite database file settings. */
export interface SqliteConnection {
  /** Path to the SQLite database file on the local machine. */
  filePath: string;
}

/** Non-secret MySQL/PostgreSQL server settings (never includes a password). */
export interface ServerConnection {
  /** Server host name or IP address. */
  host: string;
  /** Server port. */
  port: number;
  /** Optional default database to select after connecting. */
  database?: string;
  /** Login role/user name. The password is resolved separately in the backend. */
  username: string;
  /** Requested TLS behavior. */
  tls: TlsMode;
}

/** Secret-free description of how to reach a database. */
export type ConnectionDescriptor =
  | ({ engine: "sqlite" } & SqliteConnection)
  | ({ engine: "mysql" } & ServerConnection)
  | ({ engine: "postgres" } & ServerConnection);

/**
 * Saved, secret-free connection profile mirrored from the Rust
 * `ConnectionProfile`.
 *
 * `id` is an opaque reference used to resolve the password from the backend's
 * OS-protected credential store. A profile never carries a password, and the
 * backend never returns a stored password to the frontend after a save.
 */
export interface ConnectionProfile {
  /** Stable identifier, also the protected-storage secret reference. */
  id: string;
  /** User-facing display name. */
  name: string;
  /** Secret-free routing settings for the target database. */
  descriptor: ConnectionDescriptor;
}

/** Reported state of a connection known to the backend adapter. */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

/** Normalized, secret-free result of a connection test. */
export interface ConnectionTest {
  /** Engine that accepted the connection. */
  engine: EngineId;
  /** Server/driver version string when the engine reports one. */
  serverVersion?: string;
}

/** Kind of database object exposed by metadata listing. */
export type ObjectKind = "table" | "view";

/**
 * Stable, engine-neutral reference to a database object.
 *
 * `database` and `schema` are absent for engines that do not expose them, such
 * as SQLite.
 */
export interface ObjectRef {
  /** Database/catalog that contains the object, when the engine exposes one. */
  database?: string;
  /** Schema that contains the object, when the engine exposes one. */
  schema?: string;
  /** Object name. */
  name: string;
  /** Whether the object is a table or a view. */
  kind: ObjectKind;
}

/** State of a long-running operation. */
export type OperationState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

/**
 * Normalized scalar value used for result cells and bound query parameters.
 *
 * Temporal/UUID/structured values are mapped to `text`, exact numerics to
 * `decimal`, and binary values to `bytes` (an array of byte values). Integers
 * beyond JavaScript's safe integer range should arrive as `decimal` text.
 */
export type CellValue =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "integer"; value: number }
  | { type: "float"; value: number }
  | { type: "decimal"; value: string }
  | { type: "text"; value: string }
  | { type: "bytes"; value: number[] };

/** A single result row, one cell per column. */
export type Row = CellValue[];

/** Normalized column metadata for a query result. */
export interface ColumnInfo {
  /** Column label as returned by the engine. */
  name: string;
  /** Engine-reported type name, when available. */
  typeName?: string;
  /** Whether the column is nullable; absent when the engine does not report it. */
  nullable?: boolean;
}

/**
 * Database/catalog and schema scope to list objects in.
 *
 * Both fields are optional; an absent field means "the connection's default
 * scope" or "all scopes", depending on the engine's capability. SQLite exposes
 * neither, MySQL exposes databases/catalogs, and PostgreSQL exposes schemas.
 */
export interface ObjectScope {
  /** Database/catalog to list, when applicable. */
  database?: string;
  /** Schema to list, when applicable. */
  schema?: string;
}

/**
 * Database/catalog and schema names a connection can address.
 *
 * An engine that exposes neither reports this as an `unsupported` error rather
 * than an empty listing, so the UI can hide a scope picker instead of guessing.
 * When present, empty vectors mean "this engine has no such namespace", not
 * "none exist".
 */
export interface ScopeListing {
  /** Database/catalog names, when the engine exposes separate catalogs. */
  databases?: string[];
  /** Schema names, when the engine exposes named schemas. */
  schemas?: string[];
}

/** Kind of table constraint reported by metadata inspection. */
export type ConstraintKind =
  | "primary_key"
  | "foreign_key"
  | "unique"
  | "check";

/**
 * Normalized description of a table index.
 *
 * `columns` is in index order. Expression indexes keep their ordinal position
 * with adapter placeholder text, so the list length reflects the width.
 */
export interface IndexInfo {
  /** Index name as reported by the engine. */
  name: string;
  /** Indexed columns in order. */
  columns?: string[];
  /** Whether the index enforces uniqueness. */
  unique: boolean;
  /** Whether the index backs the primary key. */
  primary: boolean;
}

/**
 * Normalized description of a table constraint.
 *
 * A foreign key carries its referenced target so the UI can show a relationship
 * without a second engine call. `definition` carries engine text for check
 * constraints when the engine reports it.
 */
export interface ConstraintInfo {
  /** Constraint name, or a deterministic adapter-generated label. */
  name: string;
  /** Kind of constraint. */
  kind: ConstraintKind;
  /** Constrained columns in order. */
  columns?: string[];
  /** For a foreign key: referenced schema, when the engine reports one. */
  referencedSchema?: string;
  /** For a foreign key: referenced table. */
  referencedTable?: string;
  /** For a foreign key: referenced columns, in the same order as `columns`. */
  referencedColumns?: string[];
  /** Engine text for a check constraint, when available. */
  definition?: string;
}

/**
 * Normalized description of a table or view.
 *
 * `indexes` and `constraints` distinguish "not supported" from "none exist":
 * `undefined` means the adapter does not expose that metadata for the object,
 * while `[]` means it was inspected and the engine reported none. A UI must
 * never render an unsupported category as an empty success.
 */
export interface TableDescription {
  /** Column metadata in ordinal order. */
  columns: ColumnInfo[];
  /** Column names that make up the primary key; empty when unknown or absent. */
  primaryKeyColumns?: string[];
  /** Indexes when the adapter can report them; absent when unsupported. */
  indexes?: IndexInfo[];
  /** Constraints when the adapter can report them; absent when unsupported. */
  constraints?: ConstraintInfo[];
}

/** Normalized category for a database or application error. */
export type ErrorCategory =
  | "connection"
  | "authentication"
  | "configuration"
  | "syntax"
  | "validation"
  | "permission"
  | "constraint"
  | "locking"
  | "timeout"
  | "cancelled"
  | "transport"
  | "unsupported"
  | "internal";

/** Normalized error returned for a failed database operation. */
export interface QueryError {
  /** Normalized category for UI behavior and messaging. */
  category: ErrorCategory;
  /** Safe user-facing summary; never contains secrets. */
  message: string;
  /** Optional engine/provider error code (for example, a SQLSTATE value). */
  code?: string;
  /** Optional redacted engine message for diagnostics. */
  engineDetail?: string;
}

/** A request to execute SQL through an adapter. */
export interface QueryRequest {
  /** Caller-supplied stable identifier echoed in the result. */
  operationId: string;
  /** SQL text to execute. */
  sql: string;
  /** Bound parameter values, in placeholder order. */
  parameters?: CellValue[];
  /** Optional maximum number of rows to return. */
  maxRows?: number;
}

/** Normalized outcome of a query or operation. */
export interface QueryResult {
  /** Stable identifier matching the originating request. */
  operationId: string;
  /** Terminal (or, for streamed updates, current) operation state. */
  state: OperationState;
  /** Result column metadata. */
  columns?: ColumnInfo[];
  /** Returned rows. */
  rows?: Row[];
  /** Number of rows affected by a DML statement, when reported. */
  affectedRows?: number;
  /** Execution duration in milliseconds, when reported. */
  durationMs?: number;
  /** Whether the result was cut off by a row cap or adapter limit. */
  truncated: boolean;
  /** Normalized error when `state` is `failed` or `outcome_unknown`. */
  error?: QueryError;
}

/** Operation states after which no further state updates are expected. */
export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
];

/** Whether an operation state is terminal. */
export function isTerminalOperationState(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(state);
}

/**
 * Whether an operation is definitively confirmed as successful.
 *
 * `outcome_unknown` is intentionally not success.
 */
export function isSuccessfulOperationState(state: OperationState): boolean {
  return state === "succeeded";
}

/**
 * Outcome of a cancellation request; mirrors the Rust `CancelOutcome`.
 *
 * Cancellation is a request, not proof that a server-side write was rolled
 * back. `requested` only means the driver accepted the request for a running
 * operation; the operation's own result reports the actual outcome.
 */
export type CancelOutcome = "requested" | "not_running";

/** Mints a stable, unique operation identifier for a frontend-initiated request. */
export function createOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
