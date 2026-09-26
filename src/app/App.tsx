import { useState } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Workspace } from "@/components/layout/Workspace";
import { ConnectionsPage } from "@/features/connections";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { WorkspaceProvider, useWorkspace } from "./store";
import { useTheme } from "./useTheme";

function Shell() {
  const { theme, toggleTheme } = useTheme();
  const { connectionId } = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connectionsOpen, setConnectionsOpen] = useState(false);

  const connected = connectionId !== null;
  const showConnections = !connected || connectionsOpen;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TopBar
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onOpenConnections={() => setConnectionsOpen(true)}
          connectionsOpen={connectionsOpen}
        />
        <div className="flex min-h-0 flex-1">
          {showConnections ? (
            <ConnectionsPage
              onClose={
                connected ? () => setConnectionsOpen(false) : undefined
              }
            />
          ) : (
            <>
              <Sidebar collapsed={!sidebarOpen} />
              <Workspace />
            </>
          )}
        </div>
      </div>
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
