import { Sidebar } from "../components/layout/Sidebar";
import { StatusBar } from "../components/layout/StatusBar";
import { TopBar } from "../components/layout/TopBar";
import { Workspace } from "../components/layout/Workspace";
import { useTheme } from "./useTheme";

/**
 * Desktop workspace shell.
 *
 * Composes the compact top bar, explorer sidebar, query workspace, and status
 * bar. The Glide grid prototype and database behavior belong to later tasks;
 * this shell is deliberately presentation-only.
 */
export default function App() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar theme={theme} onToggleTheme={toggleTheme} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <Workspace />
      </div>
      <StatusBar />
    </div>
  );
}
