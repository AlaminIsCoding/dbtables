import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { EngineLogo } from "../../components/engine-logo";
import type { ConnectionProfile } from "../../domain";
import { ENGINE_LABELS, describeProfile } from "./profileDraft";
import type {
  ActiveConnection,
  MutationState,
  TestStatus,
} from "./useConnectionManager";

export interface ProfileListProps {
  /** Saved profiles to render. */
  profiles: ConnectionProfile[];
  /** The single active profile connection. */
  active: ActiveConnection;
  /** Latest test outcome, keyed by profile id. */
  test: TestStatus;
  /** Latest save/remove state. */
  mutation: MutationState;
  /** Connect a profile. */
  onConnect: (profileId: string) => void;
  /** Disconnect the active profile. */
  onDisconnect: () => void;
  /** Open a profile in the form. */
  onEdit: (profile: ConnectionProfile) => void;
  /** Remove a profile and its secret. */
  onRemove: (profileId: string) => void;
  /** Test a profile using its saved secret. */
  onTest: (profile: ConnectionProfile) => void;
  className?: string;
}

function statusDot(active: boolean, connecting: boolean): string {
  if (active) {
    return "bg-emerald-500";
  }
  if (connecting) {
    return "bg-amber-500";
  }
  return "bg-muted-foreground/40";
}

/** Saved-profile list with per-profile connection, test, edit, and remove actions. */
export function ProfileList({
  profiles,
  active,
  test,
  mutation,
  onConnect,
  onDisconnect,
  onEdit,
  onRemove,
  onTest,
  className,
}: ProfileListProps) {
  const removingId = mutation.status === "removing" ? mutation.profileId : null;

  return (
    <ul aria-label="Connection profiles" className={cn("flex flex-col gap-1 p-1", className)}>
      {profiles.map((profile) => {
        const isConnected =
          active.status === "connected" && active.profileId === profile.id;
        const isConnecting =
          active.status === "connecting" && active.profileId === profile.id;
        const rowTest =
          test.status !== "idle" && test.targetId === profile.id ? test : null;

        return (
          <li
            key={profile.id}
            aria-label={profile.name}
            aria-current={isConnected ? "true" : undefined}
            className={cn(
              "rounded-md border border-border px-2 py-1.5",
              isConnected && "border-primary/50 bg-accent",
            )}
          >
            <div className="flex items-center gap-1.5">
              <EngineLogo engine={profile.descriptor.engine} className="size-4" />
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  statusDot(isConnected, isConnecting),
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {profile.name}
              </span>
              {isConnected ? (
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  Active
                </span>
              ) : null}
            </div>

            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {ENGINE_LABELS[profile.descriptor.engine]} ·{" "}
              {describeProfile(profile)}
            </p>

            {isConnected ? (
              <p role="status" aria-live="polite" className="mt-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                Connected
              </p>
            ) : null}
            {isConnecting ? (
              <p role="status" aria-live="polite" className="mt-0.5 text-[10px] text-muted-foreground">
                Connecting…
              </p>
            ) : null}

            {rowTest?.status === "testing" ? (
              <p role="status" aria-live="polite" className="mt-0.5 text-[10px] text-muted-foreground">
                Testing…
              </p>
            ) : null}
            {rowTest?.status === "success" ? (
              <p role="status" aria-live="polite" className="mt-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                Test succeeded
                {rowTest.serverVersion ? ` · ${rowTest.serverVersion}` : ""}
              </p>
            ) : null}
            {rowTest?.status === "error" ? (
              <p role="alert" className="mt-0.5 text-[10px] text-destructive">
                {rowTest.error.message}
                {rowTest.error.code ? ` (${rowTest.error.code})` : ""}
              </p>
            ) : null}

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {isConnected ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={onDisconnect}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() => onConnect(profile.id)}
                  disabled={isConnecting}
                  aria-label={`Connect ${profile.name}`}
                >
                  {isConnecting ? "Connecting…" : "Connect"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => onTest(profile)}
                disabled={rowTest?.status === "testing"}
                aria-label={`Test ${profile.name}`}
              >
                Test
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => onEdit(profile)}
                aria-label={`Edit ${profile.name}`}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-destructive"
                onClick={() => onRemove(profile.id)}
                disabled={removingId === profile.id}
                aria-label={`Remove ${profile.name}`}
              >
                {removingId === profile.id ? "Removing…" : "Remove"}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
