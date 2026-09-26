/**
 * Editable connection-profile form state and its conversion to the typed
 * service input.
 *
 * A {@link ProfileDraft} is deliberately separate from a {@link ConnectionProfile}:
 * the draft carries a write-only `password` that the saved profile never holds,
 * and it keeps numeric fields (`port`) as text so a partly typed value stays
 * editable. Nothing here is persisted; it only feeds the service facade.
 */

import type {
  ConnectionDescriptor,
  ConnectionProfile,
  EngineId,
  QueryError,
  TlsMode,
} from "../../domain";
import type { ConnectionProfileInput } from "../../services/connections";

/** Maximum profile display-name length, matching the backend limit. */
export const MAX_PROFILE_NAME_LENGTH = 120;

/** Supported engines, in menu order. */
export const ENGINE_IDS: readonly EngineId[] = ["sqlite", "mysql", "postgres"];

/** Human-readable engine names. */
export const ENGINE_LABELS: Record<EngineId, string> = {
  sqlite: "SQLite",
  mysql: "MySQL",
  postgres: "PostgreSQL",
};

/** Default server port per engine. SQLite has no network port. */
export const DEFAULT_PORTS: Record<EngineId, number> = {
  sqlite: 0,
  mysql: 3306,
  postgres: 5432,
};

/** TLS modes offered for network engines, in menu order. */
export const TLS_MODES: readonly TlsMode[] = [
  "disabled",
  "preferred",
  "required",
  "verify_ca",
  "verify_full",
];

/** Human-readable TLS mode names. */
export const TLS_MODE_LABELS: Record<TlsMode, string> = {
  disabled: "Disabled",
  preferred: "Preferred",
  required: "Required",
  verify_ca: "Verify CA",
  verify_full: "Verify full",
};

/** Whether an engine uses host/port server settings. */
export function isServerEngine(engine: EngineId): boolean {
  return engine === "mysql" || engine === "postgres";
}

/** Default port shown when creating a profile for `engine`. */
export function defaultPortFor(engine: EngineId): string {
  return isServerEngine(engine) ? String(DEFAULT_PORTS[engine]) : "";
}

/**
 * Mutable form state for creating or editing a profile.
 *
 * `password` is never prefilled from a saved profile and is cleared after a
 * successful save, so the UI has no reason to retain it.
 */
export interface ProfileDraft {
  /** Existing profile identifier; absent when creating. */
  id?: string;
  /** Display name. */
  name: string;
  /** Selected engine, which decides the visible fields. */
  engine: EngineId;
  /** SQLite database file path. */
  filePath: string;
  /** Server host. */
  host: string;
  /** Server port, kept as text while editing. */
  port: string;
  /** Optional default database. */
  database: string;
  /** Login user name. */
  username: string;
  /** Requested TLS behavior. */
  tls: TlsMode;
  /** Write-only password. Empty means "keep the saved secret". */
  password: string;
}

/** Creates an empty draft for a new profile. */
export function emptyDraft(engine: EngineId = "sqlite"): ProfileDraft {
  return {
    name: "",
    engine,
    filePath: "",
    host: isServerEngine(engine) ? "localhost" : "",
    port: defaultPortFor(engine),
    database: "",
    username: "",
    tls: "preferred",
    password: "",
  };
}

/**
 * Switches the draft's engine while preserving shared fields.
 *
 * When the port was blank or still the previous engine's default, it is
 * replaced with the new engine's default so the field is never left invalid.
 */
export function withEngine(draft: ProfileDraft, engine: EngineId): ProfileDraft {
  const portWasDefault =
    draft.port.trim() === "" ||
    (isServerEngine(draft.engine) &&
      draft.port.trim() === String(DEFAULT_PORTS[draft.engine]));

  return {
    ...draft,
    engine,
    host: draft.host === "" && isServerEngine(engine) ? "localhost" : draft.host,
    port: portWasDefault ? defaultPortFor(engine) : draft.port,
  };
}

/** Builds an editable draft from a saved profile, never copying a secret. */
export function draftFromProfile(profile: ConnectionProfile): ProfileDraft {
  const base: ProfileDraft = {
    ...emptyDraft(profile.descriptor.engine),
    id: profile.id,
    name: profile.name,
  };

  if (profile.descriptor.engine === "sqlite") {
    return { ...base, filePath: profile.descriptor.filePath };
  }

  return {
    ...base,
    host: profile.descriptor.host,
    port: String(profile.descriptor.port),
    database: profile.descriptor.database ?? "",
    username: profile.descriptor.username,
    tls: profile.descriptor.tls,
  };
}

function validationError(message: string): QueryError {
  return { category: "validation", message };
}

/**
 * Validates the non-secret draft fields the way the backend will.
 *
 * Returns the first problem as a `validation` error, or `null` when the draft
 * can be submitted. The password is intentionally not required: an edit may
 * leave it blank to keep the saved secret.
 */
export function validateDraft(draft: ProfileDraft): QueryError | null {
  const name = draft.name.trim();
  if (name.length === 0) {
    return validationError("Enter a profile name.");
  }
  if ([...name].length > MAX_PROFILE_NAME_LENGTH) {
    return validationError(
      `Profile names must be at most ${MAX_PROFILE_NAME_LENGTH} characters.`,
    );
  }

  if (draft.engine === "sqlite") {
    if (draft.filePath.trim().length === 0) {
      return validationError("Enter a SQLite database file path.");
    }
    return null;
  }

  if (draft.host.trim().length === 0) {
    return validationError("Enter a host.");
  }

  const port = Number.parseInt(draft.port, 10);
  if (!Number.isInteger(port) || String(port) !== draft.port.trim() || port < 1 || port > 65535) {
    return validationError("Enter a port between 1 and 65535.");
  }

  if (draft.username.trim().length === 0) {
    return validationError("Enter a username.");
  }

  if (draft.database.length > 0 && draft.database.trim().length === 0) {
    return validationError("A database name must not be blank when provided.");
  }

  return null;
}

/** Builds the secret-free descriptor for a validated draft. */
export function descriptorFromDraft(draft: ProfileDraft): ConnectionDescriptor {
  if (draft.engine === "sqlite") {
    return { engine: "sqlite", filePath: draft.filePath.trim() };
  }

  const database = draft.database.trim();
  return {
    engine: draft.engine,
    host: draft.host.trim(),
    port: Number.parseInt(draft.port, 10),
    database: database.length > 0 ? database : undefined,
    username: draft.username.trim(),
    tls: draft.tls,
  };
}

/**
 * Converts a draft to the service input.
 *
 * The password is included only when the field is non-empty, so a blank edit
 * asks the backend to preserve the saved secret rather than clearing it.
 */
export function toProfileInput(draft: ProfileDraft): ConnectionProfileInput {
  const input: ConnectionProfileInput = {
    name: draft.name.trim(),
    descriptor: descriptorFromDraft(draft),
  };

  if (draft.id) {
    input.id = draft.id;
  }
  if (draft.password.length > 0) {
    input.password = draft.password;
  }

  return input;
}

/** Short, non-secret summary of a descriptor for list rows and status text. */
export function describeDescriptor(descriptor: ConnectionDescriptor): string {
  if (descriptor.engine === "sqlite") {
    return descriptor.filePath;
  }

  const target = `${descriptor.host}:${descriptor.port}`;
  return descriptor.database ? `${target} / ${descriptor.database}` : target;
}

/** Short, non-secret summary of a saved profile. */
export function describeProfile(profile: ConnectionProfile): string {
  return describeDescriptor(profile.descriptor);
}
