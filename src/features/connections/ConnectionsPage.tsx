import { useState } from "react";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";

import { useWorkspace } from "@/app/store";
import { Button } from "@/components/ui/button";
import type { ConnectionProfile, QueryError } from "@/domain";
import { toQueryError } from "@/services/errors";
import { listProfileDatabases } from "@/services/connections";
import { pickExistingSqliteFile, pickNewSqliteFile } from "@/services/dialogs";

import { ProfileForm } from "./ProfileForm";
import { ProfileList } from "./ProfileList";
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
 * Full-screen connection manager.
 *
 * Owns the connection controller and shows the saved-connection list beside a
 * create/edit form. It is the landing view while disconnected and can be opened
 * from the top bar while connected. Server databases can be discovered for the
 * draft; SQLite paths are chosen with a native file dialog.
 */
export function ConnectionsPage({ onClose }: ConnectionsPageProps) {
  // Uses the workspace store's shared controller so connecting here updates the
  // app's single active connection (and therefore the sidebar/workspace).
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

  function testProfile(profile: ConnectionProfile) {
    controller.clearMutation();
    void controller.testConnection(
      { id: profile.id, name: profile.name, descriptor: profile.descriptor },
      profile.id,
    );
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

      <div className="flex min-h-0 flex-1">
        <div className="app-scroll flex w-80 min-h-0 shrink-0 flex-col overflow-auto border-r border-border p-2">
          {controller.profiles.status === "loading" ? (
            <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
              Loading connections…
            </p>
          ) : controller.profiles.status === "error" ? (
            <div className="flex flex-col gap-1 px-2 py-3">
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
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No saved connections yet. Create one to get started.
            </p>
          ) : (
            <ProfileList
              profiles={profiles}
              active={controller.active}
              test={controller.test}
              mutation={controller.mutation}
              onConnect={(profileId) => {
                controller.clearMutation();
                void controller.connect(profileId);
              }}
              onDisconnect={() => {
                void controller.disconnect();
              }}
              onEdit={startEdit}
              onRemove={(profileId) => {
                void controller.remove(profileId);
              }}
              onTest={testProfile}
            />
          )}

          {mutationError ? (
            <p role="alert" className="px-2 pt-2 text-[11px] text-destructive">
              {mutationError.message}
            </p>
          ) : null}
        </div>

        <div className="app-scroll min-h-0 flex-1 overflow-auto">
          {editing ? (
            <ProfileForm
              className="max-w-2xl p-4"
              draft={editing}
              onChange={updateEditing}
              onSubmit={() => void submitDraft()}
              onTest={() => void testDraft()}
              onCancel={cancelEdit}
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
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
              <p className="text-sm font-medium">Manage your connections</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Select a saved connection to connect, edit, test, or remove it, or
                create a new one.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
