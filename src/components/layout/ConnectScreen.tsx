import { useState } from "react";
import { DatabaseIcon, PlusIcon } from "lucide-react";

import { useWorkspace } from "@/app/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ConnectionDescriptor, ConnectionProfile } from "@/domain";

import { ConnectionsDialog } from "./ConnectionsDialog";

/** Short, secret-free subtitle describing where a saved connection points. */
function describeDescriptor(descriptor: ConnectionDescriptor): string {
  if (descriptor.engine === "sqlite") {
    return descriptor.filePath;
  }
  const database = descriptor.database ? `/${descriptor.database}` : "";
  return `${descriptor.host}:${descriptor.port}${database}`;
}

/**
 * Landing screen shown while no database is open.
 *
 * Lists the saved connections so one can be opened without the schema sidebar
 * or workspace actions, which are meaningless until a database is connected.
 */
export function ConnectScreen() {
  const { connections } = useWorkspace();
  const [managerOpen, setManagerOpen] = useState(false);

  const profiles =
    connections.profiles.status === "ready" ? connections.profiles.profiles : [];
  const connectingId =
    connections.active.status === "connecting"
      ? connections.active.profileId
      : null;
  const activeError =
    connections.active.status === "error" ? connections.active.error : null;
  const profilesError =
    connections.profiles.status === "error" ? connections.profiles.error : null;

  return (
    <div className="app-scroll flex min-h-0 flex-1 items-start justify-center overflow-auto bg-background p-6">
      <div className="mt-10 flex w-full max-w-lg flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">
            Connect to a database
          </h1>
          <p className="text-xs text-muted-foreground">
            Choose a saved connection to browse tables and run queries.
          </p>
        </div>

        {activeError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive"
          >
            {activeError.message}
          </div>
        ) : null}

        {connections.profiles.status === "loading" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading connections…
          </div>
        ) : profilesError ? (
          <p role="alert" className="text-[11px] text-destructive">
            {profilesError.message}
          </p>
        ) : profiles.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No saved connections yet. Create one to get started.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {profiles.map((profile: ConnectionProfile) => {
              const connecting = connectingId === profile.id;
              return (
                <div
                  key={profile.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                >
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <DatabaseIcon className="size-4" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">
                      {profile.name}
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {describeDescriptor(profile.descriptor)}
                    </span>
                  </div>
                  <Badge variant="secondary" className="shrink-0 text-[9px] uppercase">
                    {profile.descriptor.engine}
                  </Badge>
                  <Button
                    size="sm"
                    onClick={() => void connections.connect(profile.id)}
                    disabled={connecting}
                  >
                    {connecting ? "Connecting…" : "Connect"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setManagerOpen(true)}
          >
            <PlusIcon />
            New connection
          </Button>
        </div>

        <ConnectionsDialog
          open={managerOpen}
          onOpenChange={setManagerOpen}
          controller={connections}
        />
      </div>
    </div>
  );
}
