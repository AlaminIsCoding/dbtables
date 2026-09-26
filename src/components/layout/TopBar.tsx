import { useState } from "react";
import {
  ChevronDownIcon,
  DatabaseIcon,
  MessageSquareIcon,
  MoonIcon,
  PanelLeftIcon,
  SquarePenIcon,
  SunIcon,
  XIcon,
} from "lucide-react";

import type { Theme } from "@/app/theme";
import { useWorkspace } from "@/app/store";
import logoDark from "@/assets/logo-dark.png";
import logoLight from "@/assets/logo-light.png";
import { ConnectionManager } from "@/features/connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
  const activeProfileId =
    connections.active.status === "connected" ||
    connections.active.status === "connecting"
      ? connections.active.profileId
      : null;
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const activeEngine =
    activeProfile?.descriptor.engine ??
    (connectionId !== null ? "sqlite" : null);

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
        </DropdownMenuContent>
      </DropdownMenu>

      {activeEngine && connectionId ? (
        <div className="ml-1 flex max-w-64 items-center gap-2 rounded-full border border-border bg-muted py-0.5 pr-1 pl-2.5 text-xs">
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate font-mono text-[11px]">
            {activeProfile?.name ?? "connected"}
          </span>
          <span className="text-[10px] uppercase text-muted-foreground">
            {activeEngine}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void connections.disconnect()}
            aria-label="Disconnect"
          >
            <XIcon />
          </Button>
        </div>
      ) : null}

      <div className="flex-1" />

      <Button variant="outline" size="sm" onClick={() => openQuery()}>
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

      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <DialogContent className="max-w-2xl p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Connections</DialogTitle>
            <DialogDescription>
              Create and connect SQLite databases. Passwords for server engines
              are stored in the operating system credential store.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto px-4 pb-4">
            <ConnectionManager controller={connections} />
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
