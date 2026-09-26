import { useId } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { EngineLogo } from "../../components/engine-logo";
import type { EngineId, QueryError, TlsMode } from "../../domain";
import {
  ENGINE_IDS,
  ENGINE_LABELS,
  TLS_MODES,
  TLS_MODE_LABELS,
  withEngine,
  type ProfileDraft,
} from "./profileDraft";
import type { TestStatus } from "./useConnectionManager";

export interface ProfileFormProps {
  /** Current form state. */
  draft: ProfileDraft;
  /** Replaces the form state. */
  onChange: (draft: ProfileDraft) => void;
  /** Submits the draft to the backend. */
  onSubmit: () => void;
  /** Tests the draft without saving. */
  onTest: () => void;
  /** Discards the draft. */
  onCancel: () => void;
  /** Whether a save is in progress. */
  saving: boolean;
  /** Whether a test of this draft is in progress. */
  testing: boolean;
  /** Latest test outcome for the unsaved draft (targetId `null`). */
  test: TestStatus;
  /** Save error to show above the actions. */
  error?: QueryError | null;
  /** Databases discovered for the current server settings. */
  databases?: string[];
  /** Whether a database lookup is in progress. */
  loadingDatabases?: boolean;
  /** Error from the last database lookup. */
  databasesError?: QueryError | null;
  /** Requests the server's database list for the current draft. */
  onLoadDatabases?: () => void;
  /** Picks an existing SQLite database file. */
  onBrowseFile?: () => void;
  /** Chooses a path for a new SQLite database. */
  onNewDatabaseFile?: () => void;
  className?: string;
}

const inputClass =
  "h-7 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const labelClass = "text-[11px] font-medium";

function TestResult({ test }: { test: TestStatus }) {
  if (test.status === "testing" && test.targetId === null) {
    return (
      <p role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
        Testing connection…
      </p>
    );
  }

  if (test.status === "success" && test.targetId === null) {
    return (
      <p role="status" aria-live="polite" className="text-[11px] text-emerald-600 dark:text-emerald-400">
        {ENGINE_LABELS[test.engine]} connection succeeded
        {test.serverVersion ? ` · ${test.serverVersion}` : ""}
      </p>
    );
  }

  if (test.status === "error" && test.targetId === null) {
    return (
      <p role="alert" className="text-[11px] text-destructive">
        {test.error.message}
        {test.error.code ? ` (${test.error.code})` : ""}
      </p>
    );
  }

  return null;
}

/**
 * Create/edit form for a connection profile.
 *
 * Engine-specific fields are shown for the selected engine. The password input
 * is write-only and starts blank even when editing, so a saved secret is never
 * sent back to the browser.
 */
export function ProfileForm({
  draft,
  onChange,
  onSubmit,
  onTest,
  onCancel,
  saving,
  testing,
  test,
  error,
  databases = [],
  loadingDatabases = false,
  databasesError = null,
  onLoadDatabases,
  onBrowseFile,
  onNewDatabaseFile,
  className,
}: ProfileFormProps) {
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const engineId = `${baseId}-engine`;
  const filePathId = `${baseId}-file-path`;
  const hostId = `${baseId}-host`;
  const portId = `${baseId}-port`;
  const databaseId = `${baseId}-database`;
  const databaseListId = `${baseId}-database-options`;
  const usernameId = `${baseId}-username`;
  const tlsId = `${baseId}-tls`;
  const passwordId = `${baseId}-password`;
  const passwordHelpId = `${baseId}-password-help`;

  return (
    <form
      className={cn("flex flex-col gap-2 p-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {draft.id ? "Edit profile" : "New profile"}
      </p>

      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className={labelClass}>
          Name
        </label>
        <input
          id={nameId}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="Local app"
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={engineId} className={labelClass}>
          Engine
        </label>
        <div className="flex items-center gap-2">
          <EngineLogo engine={draft.engine} className="size-5" />
          <select
            id={engineId}
            value={draft.engine}
            onChange={(event) =>
              onChange(withEngine(draft, event.target.value as EngineId))
            }
            className={inputClass}
          >
            {ENGINE_IDS.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_LABELS[engine]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {draft.engine === "sqlite" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={filePathId} className={labelClass}>
            Database file
          </label>
          <div className="flex items-center gap-1">
            <input
              id={filePathId}
              value={draft.filePath}
              onChange={(event) =>
                onChange({ ...draft, filePath: event.target.value })
              }
              placeholder="C:/path/to/database.sqlite"
              spellCheck={false}
              className={cn(inputClass, "min-w-0 flex-1 font-mono")}
            />
            <Button
              type="button"
              variant="outline"
              onClick={onBrowseFile}
              disabled={!onBrowseFile}
            >
              Browse…
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onNewDatabaseFile}
              disabled={!onNewDatabaseFile}
            >
              New…
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-1">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={hostId} className={labelClass}>
                Host
              </label>
              <input
                id={hostId}
                value={draft.host}
                onChange={(event) =>
                  onChange({ ...draft, host: event.target.value })
                }
                placeholder="localhost"
                spellCheck={false}
                className={inputClass}
              />
            </div>
            <div className="flex w-16 flex-col gap-1">
              <label htmlFor={portId} className={labelClass}>
                Port
              </label>
              <input
                id={portId}
                value={draft.port}
                onChange={(event) =>
                  onChange({ ...draft, port: event.target.value })
                }
                inputMode="numeric"
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={databaseId} className={labelClass}>
              Database
            </label>
            <div className="flex items-center gap-1">
              <input
                id={databaseId}
                list={databases.length > 0 ? databaseListId : undefined}
                value={draft.database}
                onChange={(event) =>
                  onChange({ ...draft, database: event.target.value })
                }
                placeholder="optional"
                spellCheck={false}
                className={cn(inputClass, "min-w-0 flex-1")}
              />
              <Button
                type="button"
                variant="outline"
                onClick={onLoadDatabases}
                disabled={!onLoadDatabases || loadingDatabases}
              >
                {loadingDatabases ? "Loading…" : "Load"}
              </Button>
            </div>
            {databases.length > 0 ? (
              <datalist id={databaseListId}>
                {databases.map((database) => (
                  <option key={database} value={database} />
                ))}
              </datalist>
            ) : null}
            {databasesError ? (
              <p role="alert" className="text-[10px] text-destructive">
                {databasesError.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={usernameId} className={labelClass}>
              Username
            </label>
            <input
              id={usernameId}
              value={draft.username}
              onChange={(event) =>
                onChange({ ...draft, username: event.target.value })
              }
              spellCheck={false}
              autoComplete="username"
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={tlsId} className={labelClass}>
              TLS
            </label>
            <select
              id={tlsId}
              value={draft.tls}
              onChange={(event) =>
                onChange({ ...draft, tls: event.target.value as TlsMode })
              }
              className={inputClass}
            >
              {TLS_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {TLS_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={passwordId} className={labelClass}>
          Password
        </label>
        <input
          id={passwordId}
          type="password"
          value={draft.password}
          onChange={(event) =>
            onChange({ ...draft, password: event.target.value })
          }
          aria-describedby={passwordHelpId}
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
        <p id={passwordHelpId} className="text-[10px] text-muted-foreground">
          Stored in the OS credential store. Leave blank to keep the saved
          password.
        </p>
      </div>

      <TestResult test={test} />

      {error ? (
        <p role="alert" className="text-[11px] text-destructive">
          {error.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <Button type="submit" disabled={saving || testing}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          disabled={saving || testing}
        >
          {testing ? "Testing…" : "Test"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
