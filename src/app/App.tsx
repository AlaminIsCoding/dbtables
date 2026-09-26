import { Sidebar } from "../components/layout/Sidebar";
import { StatusBar } from "../components/layout/StatusBar";
import { TopBar } from "../components/layout/TopBar";
import { Workspace } from "../components/layout/Workspace";
import { TableDataProvider } from "../features/table-data";
import { useTheme } from "./useTheme";

/**
 * Desktop workspace shell.
 *
 * Composes the compact top bar, explorer sidebar, query workspace, and status
 * bar. A table-data session lets the explorer open the read-only browser in the
 * workspace without caching any rows in the shell itself.
 */
export default function App() {
  const { theme, toggleTheme } = useTheme();

  return (
    <TableDataProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <TopBar theme={theme} onToggleTheme={toggleTheme} />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <Workspace />
        </div>
        <StatusBar />
      </div>
    </TableDataProvider>
  );
}
