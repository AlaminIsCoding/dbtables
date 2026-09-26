import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { ObjectRef } from "../../domain";
import type { TableDataTarget } from "./useTableData";

interface TableDataSession {
  /** Table currently open for browsing, or `null` when the workspace shows SQL. */
  target: TableDataTarget | null;
  /** Opens a table data view for a connection. */
  open: (connectionId: string, object: ObjectRef) => void;
  /** Closes the table data view. */
  close: () => void;
}

const TableDataContext = createContext<TableDataSession | null>(null);

/**
 * Shares the table currently open for browsing between the explorer (which
 * starts a browse) and the workspace (which hosts the read-only view).
 *
 * Only the connection token and object travel here; no rows are cached, so the
 * view always fetches its own bounded pages.
 */
export function TableDataProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<TableDataTarget | null>(null);

  const open = useCallback((connectionId: string, object: ObjectRef) => {
    setTarget({ connectionId, object });
  }, []);

  const close = useCallback(() => {
    setTarget(null);
  }, []);

  const value = useMemo(() => ({ target, open, close }), [target, open, close]);

  return (
    <TableDataContext.Provider value={value}>
      {children}
    </TableDataContext.Provider>
  );
}

/** Accesses the table data session. Throws when used outside the provider. */
export function useTableDataSession(): TableDataSession {
  const session = useContext(TableDataContext);
  if (session === null) {
    throw new Error("useTableDataSession must be used within TableDataProvider");
  }
  return session;
}
