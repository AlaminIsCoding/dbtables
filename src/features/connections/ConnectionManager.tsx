import { useState } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { ConnectionProfile, QueryError } from "../../domain";
import { ProfileForm } from "./ProfileForm";
import { ProfileList } from "./ProfileList";
import {
  ENGINE_LABELS,
  describeDescriptor,
  draftFromProfile,
  emptyDraft,
  toProfileInput,
  validateDraft,
  type ProfileDraft,
} from "./profileDraft";
import {
  useConnectionManager,
  type ActiveConnection,
  type ConnectionManagerController,
} from "./useConnectionManager";

export interface ConnectionManagerProps {
  /**
   * Shared controller. Supplying one lets a parent (for example the sidebar)
   * drive the connection lifecycle for more than one child; when omitted the
   * manager creates and owns its own controller.
   */
  controller?: ConnectionManagerController;
  className?: string;
}

function ActiveTarget({
  active,
  profiles,
}: {
  active: ActiveConnection;
  profiles: ConnectionProfile[];
}) {
  if (active.status === "disconnected") {
    return null;
  }

  if (active.status === "error") {
    return (
      <p
        role="alert"
        className="border-b border-border bg-destructive/10 px-3 py-1 text-[11px] text-destructive"
      >
        {active.error.message}
        {active.error.code ? ` (${active.error.code})` : ""}
      </p>
    );
  }

  const profile = profiles.find((candidate) => candidate.id === active.profileId);
  const label = profile?.name ?? active.profileId;

  if (active.status === "connecting") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground"
      >
        Connecting to {label}…
      </p>
    );
  }

  return (
    <p
      role="status"
      aria-live="polite"
      className="border-b border-border bg-accent px-3 py-1 text-[11px]"
    >
      <span className="font-semibold">Active: {label}</span>
      {profile ? (
        <span className="block truncate text-muted-foreground">
          {ENGINE_LABELS[profile.descriptor.engine]} ·{" "}
          {describeDescriptor(profile.descriptor)}
        </span>
      ) : null}
    </p>
  );
}

function ConnectionManagerView({
  controller,
  className,
}: {
  controller: ConnectionManagerController;
  className?: string;
}) {
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [formError, setFormError] = useState<QueryError | null>(null);

  const profiles =
    controller.profiles.status === "ready" ? controller.profiles.profiles : [];
  const mutationError =
    controller.mutation.status === "error" ? controller.mutation.error : null;

  function startNew() {
    controller.clearTest();
    controller.clearMutation();
    setFormError(null);
    setEditing(emptyDraft());
  }

  function startEdit(profile: ConnectionProfile) {
    controller.clearTest();
    controller.clearMutation();
    setFormError(null);
    setEditing(draftFromProfile(profile));
  }

  function cancelEdit() {
    controller.clearTest();
    controller.clearMutation();
    setFormError(null);
    setEditing(null);
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
      className={cn("flex min-h-0 flex-col", className)}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Connections
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          onClick={startNew}
          aria-label="New profile"
        >
          New
        </Button>
      </div>

      <ActiveTarget active={controller.active} profiles={profiles} />

      <div className="max-h-80 overflow-auto">
        {editing ? (
          <ProfileForm
            draft={editing}
            onChange={(next) => {
              setFormError(null);
              controller.clearMutation();
              setEditing(next);
            }}
            onSubmit={() => {
              void submitDraft();
            }}
            onTest={() => {
              void testDraft();
            }}
            onCancel={cancelEdit}
            saving={controller.mutation.status === "saving"}
            testing={
              controller.test.status === "testing" &&
              controller.test.targetId === null
            }
            test={controller.test}
            error={formError ?? mutationError}
          />
        ) : controller.profiles.status === "loading" ? (
          <p
            role="status"
            aria-live="polite"
            className="px-3 py-2 text-xs text-muted-foreground"
          >
            Loading connections…
          </p>
        ) : controller.profiles.status === "error" ? (
          <div className="flex flex-col gap-1 px-3 py-2">
            <p role="alert" className="text-xs text-destructive">
              {controller.profiles.error.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                void controller.reload();
              }}
            >
              Retry
            </Button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="px-3 pb-3">
            <p className="text-xs text-muted-foreground">No connections yet.</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Create a profile for SQLite, MySQL, or PostgreSQL.
            </p>
          </div>
        ) : (
          <>
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
            {mutationError ? (
              <p role="alert" className="px-3 pb-2 text-[11px] text-destructive">
                {mutationError.message}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** Connection manager that owns its own controller lifecycle. */
function OwnedConnectionManager({ className }: { className?: string }) {
  const controller = useConnectionManager();
  return <ConnectionManagerView controller={controller} className={className} />;
}

/**
 * Connection manager: saved-profile list, create/edit form, and connection
 * lifecycle controls with an active-target indicator.
 *
 * The single active connection is replaced when another profile is connected or
 * removed, and every backend call goes through the shared controller. When no
 * controller is supplied, this component creates and owns one.
 */
export function ConnectionManager({
  controller,
  className,
}: ConnectionManagerProps) {
  if (controller) {
    return (
      <ConnectionManagerView controller={controller} className={className} />
    );
  }

  return <OwnedConnectionManager className={className} />;
}
