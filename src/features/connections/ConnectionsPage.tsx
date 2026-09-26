import { useState } from "react";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";

import { useWorkspace } from "@/app/store";
import { Button } from "@/components/ui/button";
import type { ConnectionProfile, QueryError } from "@/domain";
import { toQueryError } from "@/services/errors";
import { listProfileDatabases } from "@/services/connections";
import { pickExistingSqliteFile, pickNewSqliteFile } from "@/services/dialogs";

import { ConnectionGrid } from "./ConnectionGrid";
import { ProfileForm } from "./ProfileForm";
import {
  draftFromProfile,
  emptyDraft,
  toProfileInput,
  validateDraft,
  type ProfileDraft,
} from "./profileDraft";

export interface ConnectionsPageProps {
  /** Returns to the workspace; omitted while disconnected (nothing to return to). */
  onClose?: () => void;
}

/**
 * Full-screen connections page.
 *
 * Shows the saved connections (engine brand mark plus connection name); choosing
 * one connects and the shared database picker opens. "New connection" reveals the
 * create/edit form. The same controller is shared with the top bar, so connecting
 * here updates the app's single active connection.
 */
export function ConnectionsPage({ onClose }: ConnectionsPageProps) {
  const { connections: controller } = useWorkspace();
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [formError, setFormError] = useState<QueryError | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [databasesError, setDatabasesError] = useState<QueryError | null>(null);

  const profiles =
    controller.profiles.status === "ready" ? controller.profiles.profiles : [];
  const mutationError =
    controller.mutation.status === "error" ? controller.mutation.error : null;

  function resetDatabaseState() {
    setDatabases([]);
    setDatabasesError(null);
    setLoadingDatabases(false);
  }

  function startNew() {
    controller.clearTest();
    controller.clearMutation();
    setFormError(null);
    resetDatabaseState();
    setEditing(emptyDraft());
  }

  function startEdit(profile: ConnectionProfile) {
    controller.clearTest();
    controller.clearMutation();
    setFormError(null);
    resetDatabaseState();
    setEditing(draftFromProfile(profile));
  }

  function cancelEdit() {
    controller.clearTest();
    controller.clearMutation();
    setFormError(null);
    resetDatabaseState();
    setEditing(null);
  }

  function updateEditing(next: ProfileDraft) {
    setFormError(null);
    controller.clearMutation();
    resetDatabaseState();
    setEditing(next);
  }

  async function submitDraft() {
    if (!editing) {
      return;
    }
    const validation = validateDraft(editing);
    if (validation) {
      setFormError(validation);
      return;
    }
    setFormError(null);
    const saved = await controller.save(toProfileInput(editing));
    if (saved) {
      setEditing(null);
      resetDatabaseState();
      controller.clearTest();
    }
  }

  async function testDraft() {
    if (!editing) {
      return;
    }
    const validation = validateDraft(editing);
    if (validation) {
      setFormError(validation);
      return;
    }
    setFormError(null);
    await controller.testConnection(toProfileInput(editing), null);
  }

  async function loadDatabases() {
    if (!editing || loadingDatabases) {
      return;
    }
    const validation = validateDraft(editing);
    if (validation) {
      setFormError(validation);
      return;
    }
    setFormError(null);
    setLoadingDatabases(true);
    setDatabasesError(null);
    try {
      setDatabases(await listProfileDatabases(toProfileInput(editing)));
    } catch (error) {
      setDatabases([]);
      setDatabasesError(toQueryError(error));
    } finally {
      setLoadingDatabases(false);
    }
  }

  async function browseFile() {
    if (!editing) {
      return;
    }
    const path = await pickExistingSqliteFile();
    if (path) {
      updateEditing({ ...editing, filePath: path });
    }
  }

  async function newDatabaseFile() {
    if (!editing) {
      return;
    }
    const path = await pickNewSqliteFile();
    if (path) {
      updateEditing({ ...editing, filePath: path });
    }
  }

  async function removeEditing() {
    if (!editing?.id) {
      return;
    }
    const removed = await controller.remove(editing.id);
    if (removed) {
      setEditing(null);
      resetDatabaseState();
    }
  }

  return (
    <section
      aria-label="Connections"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Back to workspace"
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <h1 className="text-sm font-semibold tracking-tight">Connections</h1>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={startNew}>
          <PlusIcon />
          New connection
        </Button>
      </header>

      <div className="app-scroll min-h-0 flex-1 overflow-auto">
        {editing ? (
          <ProfileForm
            className="mx-auto w-full max-w-2xl p-6"
            draft={editing}
            onChange={updateEditing}
            onSubmit={() => void submitDraft()}
            onTest={() => void testDraft()}
            onCancel={cancelEdit}
            onRemove={() => void removeEditing()}
            removing={controller.mutation.status === "removing"}
            saving={controller.mutation.status === "saving"}
            testing={
              controller.test.status === "testing" &&
              controller.test.targetId === null
            }
            test={controller.test}
            error={formError ?? mutationError}
            databases={databases}
            loadingDatabases={loadingDatabases}
            databasesError={databasesError}
            onLoadDatabases={() => void loadDatabases()}
            onBrowseFile={() => void browseFile()}
            onNewDatabaseFile={() => void newDatabaseFile()}
          />
        ) : controller.profiles.status === "loading" ? (
          <p role="status" className="px-6 py-6 text-xs text-muted-foreground">
            Loading connections…
          </p>
        ) : controller.profiles.status === "error" ? (
          <div className="flex flex-col gap-2 px-6 py-6">
            <p role="alert" className="text-xs text-destructive">
              {controller.profiles.error.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void controller.reload()}
            >
              Retry
            </Button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="mx-auto max-w-3xl px-6 py-6">
            <p className="text-sm font-medium">No saved connections yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a connection for SQLite, MySQL, or PostgreSQL to get started.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl p-4">
            <ConnectionGrid
              profiles={profiles}
              active={controller.active}
              onConnect={(profileId) => {
                controller.clearMutation();
                void controller.connect(profileId);
              }}
              onDisconnect={() => {
                void controller.disconnect();
              }}
              onMore={startEdit}
            />
            {mutationError ? (
              <p role="alert" className="px-2 pt-2 text-[11px] text-destructive">
                {mutationError.message}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
