import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import { EngineLogo } from "../../components/engine-logo";
import type { ConnectionProfile } from "../../domain";
import { ENGINE_LABELS, describeProfile } from "./profileDraft";
import type { ActiveConnection } from "./useConnectionManager";

export interface ConnectionGridProps {
  /** Saved profiles to render as cards. */
  profiles: ConnectionProfile[];
  /** The single active profile connection. */
  active: ActiveConnection;
  /** Connect a profile. */
  onConnect: (profileId: string) => void;
  /** Disconnect the active profile. */
  onDisconnect: () => void;
  /** Opens the profile's details/edit page. */
  onMore: (profile: ConnectionProfile) => void;
  className?: string;
}

/**
 * Saved connections as a three-column card grid.
 *
 * Each card shows the engine brand mark above the connection name, with a
 * primary Connect/Disconnect action and a "More" action that opens the full
 * details and test page.
 */
export function ConnectionGrid({
  profiles,
  active,
  onConnect,
  onDisconnect,
  onMore,
  className,
}: ConnectionGridProps) {
  return (
    <ul
      aria-label="Connection profiles"
      className={cn("grid grid-cols-3 gap-3", className)}
    >
      {profiles.map((profile) => {
        const isConnected =
          active.status === "connected" && active.profileId === profile.id;
        const isConnecting =
          active.status === "connecting" && active.profileId === profile.id;

        return (
          <li
            key={profile.id}
            aria-label={profile.name}
            aria-current={isConnected ? "true" : undefined}
            className={cn(
              "flex flex-col items-center gap-2 rounded-xl border border-border p-4 text-center",
              isConnected && "border-primary bg-primary/5",
            )}
          >
            <EngineLogo engine={profile.descriptor.engine} className="size-12" />

            <div className="flex min-w-0 flex-col items-center">
              <span className="max-w-full truncate text-sm font-medium">
                {profile.name}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {ENGINE_LABELS[profile.descriptor.engine]}
              </span>
            </div>

            <p className="line-clamp-2 min-w-0 text-[10px] text-muted-foreground">
              {describeProfile(profile)}
            </p>

            {isConnecting ? (
              <p
                role="status"
                aria-live="polite"
                className="text-[10px] text-muted-foreground"
              >
                Connecting…
              </p>
            ) : null}
            {isConnected ? (
              <p
                role="status"
                aria-live="polite"
                className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
              >
                Connected
              </p>
            ) : null}

            <div className="mt-auto flex w-full items-center gap-1.5 pt-1">
              {isConnected ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={onDisconnect}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => onConnect(profile.id)}
                  disabled={isConnecting}
                  aria-label={`Connect ${profile.name}`}
                >
                  {isConnecting ? "Connecting…" : "Connect"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onMore(profile)}
                aria-label={`More about ${profile.name}`}
              >
                More
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
