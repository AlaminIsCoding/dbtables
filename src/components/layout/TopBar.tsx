import { useState } from "react";
import {
  ChevronDownIcon,
  DatabaseIcon,
  MessageSquareIcon,
  MoonIcon,
  PanelLeftIcon,
  PowerIcon,
  SquarePenIcon,
  SunIcon,
} from "lucide-react";

import type { Theme } from "@/app/theme";
import { useWorkspace } from "@/app/store";
import logoDark from "@/assets/logo-dark.png";
import logoLight from "@/assets/logo-light.png";
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

import { ConnectionsDialog } from "./ConnectionsDialog";

export interface TopBarProps {
  theme: Theme;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  className?: string;
}

/**
 * Application top bar: sidebar toggle, brand, connection switcher, new query,
 * messages, and theme toggle.
 */
export function TopBar({
  theme,
  onToggleTheme,
  onToggleSidebar,
  className,
}: TopBarProps) {
  const {
    connections,
    connectionId,
    openQuery,
    unread,
    messagesOpen,
    setMessagesOpen,
  } = useWorkspace();
  const [managerOpen, setManagerOpen] = useState(false);

  const profiles =
    connections.profiles.status === "ready" ? connections.profiles.profiles : [];

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
          <Button variant="outline" size="sm">
            <DatabaseIcon />
            Open database
            <ChevronDownIcon className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Saved connections</DropdownMenuLabel>
          {profiles.length === 0 ? (
            <DropdownMenuItem disabled>No saved connections</DropdownMenuItem>
          ) : (
            profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => void connections.connect(profile.id)}
              >
                <DatabaseIcon />
                <span className="flex-1 truncate">{profile.name}</span>
                <span className="text-[10px] uppercase text-muted-foreground">
                  {profile.descriptor.engine}
                </span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setManagerOpen(true)}>
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

      <ConnectionsDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        controller={connections}
      />
    </header>
  );
}
