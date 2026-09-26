import {
  CheckIcon,
  ChevronDownIcon,
  DatabaseIcon,
  MessageSquareIcon,
  MoonIcon,
  PanelLeftIcon,
  PowerIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
} from "lucide-react";

import type { Theme } from "@/app/theme";
import { useWorkspace } from "@/app/store";
import logoDark from "@/assets/logo-dark.png";
import logoLight from "@/assets/logo-light.png";
import { EngineLogo } from "@/components/engine-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EngineId } from "@/domain";

export interface TopBarProps {
  theme: Theme;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  /** Opens the full-screen connections page. */
  onOpenConnections: () => void;
  /** Opens the database picker for the active connection. */
  onOpenDatabase: () => void;
  className?: string;
}

/**
 * Application top bar: sidebar toggle, brand, connection picker, open-database
 * button, connections, new query, messages, and theme toggle.
 *
 * The connection picker lists saved connections (engine brand mark plus
 * connection name). Once a connection is open, "Open database" launches the
 * database picker for that connection.
 */
export function TopBar({
  theme,
  onToggleTheme,
  onToggleSidebar,
  onOpenConnections,
  onOpenDatabase,
  className,
}: TopBarProps) {
  const {
    connections,
    connectionId,
    scopes,
    scope,
    openQuery,
    unread,
    messagesOpen,
    setMessagesOpen,
  } = useWorkspace();

  const profiles =
    connections.profiles.status === "ready" ? connections.profiles.profiles : [];

  const activeProfileId =
    connections.active.status === "connected" ||
    connections.active.status === "connecting"
      ? connections.active.profileId
      : null;
  const activeProfile = profiles.find(
    (profile) => profile.id === activeProfileId,
  );
  const activeEngine: EngineId | undefined = activeProfile?.descriptor.engine;
  const connecting = connections.active.status === "connecting";

  const databases = scopes?.databases ?? [];
  const profileDatabase =
    activeProfile && activeProfile.descriptor.engine !== "sqlite"
      ? activeProfile.descriptor.database
      : undefined;
  const currentDatabase = scope.database ?? profileDatabase;
  const databaseLabel = currentDatabase ?? activeProfile?.name ?? "Open database";

  return (
    <header
      className={
        "flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-2 " +
        (className ?? "")
      }
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleSidebar}
            disabled={connectionId === null}
            aria-label="Toggle sidebar"
          >
            <PanelLeftIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Toggle sidebar</TooltipContent>
      </Tooltip>

      <div className="flex items-center px-3">
        <img
          src={theme === "dark" ? logoDark : logoLight}
          alt="dbtables"
          className="h-5 w-auto"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Connection: ${activeProfile?.name ?? "none"}`}
          >
            {activeEngine ? (
              <EngineLogo engine={activeEngine} className="size-4" />
            ) : (
              <DatabaseIcon />
            )}
            <span className="max-w-40 truncate">
              {activeProfile?.name ?? "Select connection"}
            </span>
            <ChevronDownIcon className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Connections</DropdownMenuLabel>
          {connecting ? (
            <DropdownMenuItem disabled>Connecting…</DropdownMenuItem>
          ) : profiles.length === 0 ? (
            <DropdownMenuItem disabled>No saved connections</DropdownMenuItem>
          ) : (
            profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => void connections.connect(profile.id)}
              >
                <EngineLogo engine={profile.descriptor.engine} className="size-4" />
                <span className="flex-1 truncate">{profile.name}</span>
                {activeProfileId === profile.id ? (
                  <CheckIcon className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onOpenConnections()}>
            <SettingsIcon />
            Manage connections…
          </DropdownMenuItem>
          {connectionId ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void connections.disconnect()}>
                <PowerIcon />
                Disconnect
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="outline"
        size="sm"
        onClick={onOpenDatabase}
        disabled={connectionId === null || databases.length === 0}
        aria-label={`Open database: ${databaseLabel}`}
      >
        <DatabaseIcon />
        <span className="max-w-40 truncate">{databaseLabel}</span>
      </Button>

      <div className="flex-1" />

      <Button
        variant="outline"
        size="sm"
        onClick={() => openQuery()}
        disabled={connectionId === null}
      >
        <SquarePenIcon />
        New query
      </Button>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setMessagesOpen(!messagesOpen)}
        aria-label="Database messages"
        className="relative"
      >
        <MessageSquareIcon />
        {unread > 0 ? (
          <Badge
            variant="destructive"
            className="absolute -top-1 -right-1 h-4 min-w-4 justify-center px-1 text-[9px]"
          >
            {unread > 99 ? "99+" : unread}
          </Badge>
        ) : null}
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Toggle theme</TooltipContent>
      </Tooltip>
    </header>
  );
}
