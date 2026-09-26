import { useEffect, useState } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Workspace } from "@/components/layout/Workspace";
import { ConnectionsPage, DatabasePickerDialog } from "@/features/connections";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { WorkspaceProvider, useWorkspace } from "./store";
import { useTheme } from "./useTheme";

function Shell() {
  const { theme, toggleTheme } = useTheme();
  const { connectionId, scopes, scope, connections } = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [databaseOpen, setDatabaseOpen] = useState(false);
  // Connection id whose automatic database prompt the user dismissed.
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const connected = connectionId !== null;
  const showConnections = !connected || connectionsOpen;

  const databases = scopes?.databases ?? [];
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
  const hasDefaultDatabase =
    activeProfile !== undefined &&
    activeProfile.descriptor.engine !== "sqlite" &&
    Boolean(activeProfile.descriptor.database);

  // Prompt for a database once a multi-database connection has no selection yet.
  useEffect(() => {
    if (!connectionId || databases.length === 0) {
      return;
    }
    if (scope.database || hasDefaultDatabase || dismissedId === connectionId) {
      return;
    }
    setDatabaseOpen(true);
  }, [
    connectionId,
    databases.length,
    scope.database,
    hasDefaultDatabase,
    dismissedId,
  ]);

  function closeDatabasePicker() {
    setDatabaseOpen(false);
    setDismissedId(connectionId);
  }

  function openConnections() {
    setConnectionsOpen(true);
    setDatabaseOpen(false);
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TopBar
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onOpenConnections={openConnections}
          onOpenDatabase={() => setDatabaseOpen(true)}
        />
        <div className="flex min-h-0 flex-1">
          {showConnections ? (
            <ConnectionsPage
              onClose={connected ? () => setConnectionsOpen(false) : undefined}
            />
          ) : (
            <>
              <Sidebar collapsed={!sidebarOpen} />
              <Workspace />
            </>
          )}
        </div>
      </div>
      <DatabasePickerDialog
        open={databaseOpen}
        onOpenChange={(open) => {
          if (open) {
            setDatabaseOpen(true);
          } else {
            closeDatabasePicker();
          }
        }}
        onDatabaseChosen={() => setConnectionsOpen(false)}
      />
      <Toaster theme={theme} position="bottom-right" />
    </TooltipProvider>
  );
}

/** Desktop application root: theme, workspace store, and the shell layout. */
export default function App() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}
