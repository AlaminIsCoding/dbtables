import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  ObjectRef,
  ObjectScope,
  QueryError,
  ScopeListing,
  TableFilter,
} from "@/domain";
import {
  useConnectionManager,
  type ConnectionManagerController,
} from "@/features/connections";
import {
  closeTab as closeTabState,
  makeCreateTableTab,
  makeQueryTab,
  makeTableTab,
  openTab,
  qualifiedObjectName,
  selectTab as selectTabState,
  updateTab as updateTabState,
  type TableSubTab,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from "@/lib/workspace/tabs";
import { listProfileDatabases } from "@/services/connections";
import { toQueryError } from "@/services/errors";
import { listObjects, listScopes } from "@/services/metadata";
import { countTableRows } from "@/services/schema";

/** Severity of a database message shown in the messages drawer. */
export type MessageLevel = "info" | "success" | "warning" | "error" | "notice";

/** One entry in the database messages log. */
export interface MessageEntry {
  id: number;
  level: MessageLevel;
  text: string;
  detail?: string;
  time: Date;
}

/** Loading/ready/error state for the connected schema. */
export type SchemaState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; tables: ObjectRef[]; views: ObjectRef[] }
  | { status: "error"; error: QueryError };

export interface WorkspaceValue {
  /** Saved-profile and connection lifecycle (shared controller). */
  connections: ConnectionManagerController;
  /** Opaque token for the active connection, or `null`. */
  connectionId: string | null;
  /** Connected schema listing. */
  schema: SchemaState;
  /** Database/schema scopes the connection exposes, or `null` when unsupported. */
  scopes: ScopeListing | null;
  /** Currently selected database/schema scope. */
  scope: ObjectScope;
  /** Selects a database/schema scope and reloads the object list. */
  setScope: (scope: ObjectScope) => void;
  /** Databases selectable on the active connection, for the database picker. */
  databases: string[];
  /** Currently open database, when the engine exposes a database selection. */
  currentDatabase: string | null;
  /**
   * Opens a database by name.
   *
   * Engines that address several databases on one connection switch scope;
   * engines that bind one database per connection (PostgreSQL) reconnect.
   */
  openDatabase: (database: string) => Promise<void>;
  /** Row counts keyed by table name; absent while unknown. */
  rowCounts: Record<string, number>;
  /** Reloads the schema listing and row counts. */
  refreshSchema: () => Promise<void>;
  /** Open tabs and the visible tab. */
  tabs: WorkspaceTab[];
  activeTab: WorkspaceTab | null;
  activeTabId: string | null;
  /** Opens (or focuses) a table tab. */
  openTable: (object: ObjectRef, sub?: TableSubTab) => void;
  /** Opens (or focuses) a table tab with a one-shot filter (FK navigation). */
  openTableFiltered: (object: ObjectRef, filter: TableFilter) => void;
  /** Opens a new SQL tab, optionally pre-filled. */
  openQuery: (sql?: string) => void;
  /** Opens the new-table editor. */
  openCreateTable: () => void;
  /** Activates a tab. */
  selectTab: (id: string) => void;
  /** Closes a tab. */
  closeTab: (id: string) => void;
  /** Replaces fields of a tab. */
  updateTab: (id: string, patch: Partial<WorkspaceTab>) => void;
  /** Closes every open table tab for an object (after a drop). */
  closeTabsForObject: (object: ObjectRef) => void;
  /** Log of database messages. */
  messages: MessageEntry[];
  /** Count of messages added since the drawer was last opened. */
  unread: number;
  /** Whether the messages drawer is open. */
  messagesOpen: boolean;
  /** Opens or closes the messages drawer. */
  setMessagesOpen: (open: boolean) => void;
  /** Appends a message. */
  log: (level: MessageLevel, text: string, detail?: string) => void;
  /** Clears the message log. */
  clearMessages: () => void;
  /** Marks the message drawer as read. */
  markMessagesRead: () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

const MAX_MESSAGES = 250;

/**
 * Application-wide workspace store.
 *
 * Owns the single active connection (via `useConnectionManager`), the connected
 * schema, the workspace tabs, and the message log. Every feature reads from this
 * one store so the explorer, tabs, grid, and SQL editor always agree on which
 * connection and object they are addressing.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const connections = useConnectionManager();
  const [tabsState, setTabsState] = useState<WorkspaceTabsState>({
    tabs: [],
    activeId: null,
  });
  const [schema, setSchema] = useState<SchemaState>({ status: "idle" });
  const [scopes, setScopes] = useState<ScopeListing | null>(null);
  const [scope, setScopeState] = useState<ObjectScope>({});
  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const messageIdRef = useRef(0);
  const countTokenRef = useRef(0);
  // Read inside `refreshSchema` without making it change identity per selection.
  const scopeRef = useRef<ObjectScope>(scope);
  scopeRef.current = scope;

  const connectionId =
    connections.active.status === "connected"
      ? connections.active.connectionId
      : null;

  const activeProfileId =
    connections.active.status === "connected" ||
    connections.active.status === "connecting"
      ? connections.active.profileId
      : null;
  const activeProfile = useMemo(
    () =>
      connections.profiles.status === "ready"
        ? connections.profiles.profiles.find(
            (profile) => profile.id === activeProfileId,
          )
        : undefined,
    [connections.profiles, activeProfileId],
  );
  const activeEngine = activeProfile?.descriptor.engine;

  // PostgreSQL binds one connection to one database, so its database list is
  // fetched from the server rather than read from connection scopes.
  const [serverDatabases, setServerDatabases] = useState<string[]>([]);
  const databaseTokenRef = useRef(0);
  const serverDatabaseProfileId =
    activeEngine === "postgres" ? activeProfile?.id : undefined;

  useEffect(() => {
    if (!serverDatabaseProfileId || !activeProfile) {
      setServerDatabases([]);
      return;
    }
    const token = databaseTokenRef.current + 1;
    databaseTokenRef.current = token;
    void (async () => {
      try {
        const names = await listProfileDatabases({
          id: activeProfile.id,
          name: activeProfile.name,
          descriptor: activeProfile.descriptor,
        });
        if (databaseTokenRef.current === token) {
          setServerDatabases(names);
        }
      } catch {
        if (databaseTokenRef.current === token) {
          setServerDatabases([]);
        }
      }
    })();
    // Refetch only when the active server profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDatabaseProfileId]);

  const databases = useMemo(() => {
    if (activeEngine === "mysql") {
      return scopes?.databases ?? [];
    }
    if (activeEngine === "postgres") {
      return serverDatabases;
    }
    return [];
  }, [activeEngine, scopes, serverDatabases]);

  const currentDatabase = useMemo(() => {
    if (activeEngine === "mysql") {
      return scope.database ?? null;
    }
    if (activeEngine === "postgres") {
      const activeDatabase =
        connections.active.status === "connected" ||
        connections.active.status === "connecting"
          ? connections.active.database
          : undefined;
      return activeDatabase ?? activeProfile?.descriptor.database ?? null;
    }
    return null;
  }, [activeEngine, scope.database, connections.active, activeProfile]);



  const log = useCallback(
    (level: MessageLevel, text: string, detail?: string) => {
      messageIdRef.current += 1;
      const entry: MessageEntry = {
        id: messageIdRef.current,
        level,
        text,
        detail,
        time: new Date(),
      };
      setMessages((current) => [entry, ...current].slice(0, MAX_MESSAGES));
      setUnread((current) => current + 1);
    },
    [],
  );

  const clearMessages = useCallback(() => setMessages([]), []);
  const markMessagesRead = useCallback(() => setUnread(0), []);

  const loadCounts = useCallback(async (id: string, tables: ObjectRef[]) => {
    const token = countTokenRef.current + 1;
    countTokenRef.current = token;
    const results = await Promise.allSettled(
      tables.map(async (table) => ({
        name: table.name,
        count: await countTableRows(id, table),
      })),
    );
    if (countTokenRef.current !== token) {
      return;
    }
    const next: Record<string, number> = {};
    for (const result of results) {
      if (result.status === "fulfilled") {
        next[result.value.name] = result.value.count;
      }
    }
    setRowCounts(next);
  }, []);

  const refreshSchema = useCallback(async () => {
    if (!connectionId) {
      setSchema({ status: "idle" });
      setScopes(null);
      setRowCounts({});
      return;
    }
    setSchema({ status: "loading" });
    try {
      // Scope discovery is best-effort: an engine without scopes reports
      // `unsupported`, which must not fail the object listing.
      const [scopesResult, objects] = await Promise.allSettled([
        listScopes(connectionId),
        listObjects(connectionId, scopeRef.current),
      ]);
      setScopes(scopesResult.status === "fulfilled" ? scopesResult.value : null);
      if (objects.status !== "fulfilled") {
        throw objects.reason;
      }
      const tables = objects.value.filter((object) => object.kind === "table");
      const views = objects.value.filter((object) => object.kind === "view");
      setSchema({ status: "ready", tables, views });
      void loadCounts(connectionId, tables);
    } catch (error) {
      setSchema({ status: "error", error: toQueryError(error) });
    }
  }, [connectionId, loadCounts]);

  const setScope = useCallback(
    (next: ObjectScope) => {
      scopeRef.current = next;
      setScopeState(next);
      void refreshSchema();
    },
    [refreshSchema],
  );

  const openDatabase = useCallback(
    async (database: string) => {
      if (!activeProfile) {
        return;
      }
      if (activeProfile.descriptor.engine === "mysql") {
        setScope({ ...scopeRef.current, database });
        return;
      }
      await connections.connect(activeProfile.id, { database });
    },
    [activeProfile, connections, setScope],
  );

  // Reset schema and tabs whenever the active connection changes.
  const previousConnectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousConnectionRef.current === connectionId) {
      return;
    }
    previousConnectionRef.current = connectionId;
    setTabsState({ tabs: [], activeId: null });
    setRowCounts({});
    if (connectionId) {
      const profileId =
        connections.active.status === "connected"
          ? connections.active.profileId
          : null;
      const label =
        profileId !== null
          ? (connections.profiles.status === "ready"
              ? connections.profiles.profiles.find((p) => p.id === profileId)?.name
              : undefined)
          : undefined;
      scopeRef.current = {};
      setScopeState({});
      void refreshSchema();
      log("success", `Connected to ${label ?? "database"}`);
    } else {
      setSchema({ status: "idle" });
      setScopes(null);
      setScopeState({});
      scopeRef.current = {};
    }
  }, [connectionId, connections.active, connections.profiles, refreshSchema, log]);

  const openTable = useCallback((object: ObjectRef, sub: TableSubTab = "data") => {
    setTabsState((current) => openTab(current, makeTableTab(object, sub)));
  }, []);

  const openTableFiltered = useCallback(
    (object: ObjectRef, filter: TableFilter) => {
      setTabsState((current) =>
        openTab(current, makeTableTab(object, "data", filter)),
      );
    },
    [],
  );

  const openQuery = useCallback((sql = "") => {
    setTabsState((current) => openTab(current, makeQueryTab(current.tabs, sql)));
  }, []);

  const openCreateTable = useCallback(() => {
    setTabsState((current) => openTab(current, makeCreateTableTab()));
  }, []);

  const selectTab = useCallback((id: string) => {
    setTabsState((current) => selectTabState(current, id));
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabsState((current) => closeTabState(current, id));
  }, []);

  const updateTab = useCallback((id: string, patch: Partial<WorkspaceTab>) => {
    setTabsState((current) => updateTabState(current, id, patch));
  }, []);

  const closeTabsForObject = useCallback((object: ObjectRef) => {
    const id = `table:${object.database ?? ""}.${object.schema ?? ""}.${object.kind}:${object.name}`;
    setTabsState((current) => closeTabState(current, id));
  }, []);

  const activeTab =
    tabsState.tabs.find((tab) => tab.id === tabsState.activeId) ?? null;

  const value = useMemo<WorkspaceValue>(
    () => ({
      connections,
      connectionId,
      schema,
      scopes,
      scope,
      setScope,
      databases,
      currentDatabase,
      openDatabase,
      rowCounts,
      refreshSchema,
      tabs: tabsState.tabs,
      activeTab,
      activeTabId: tabsState.activeId,
      openTable,
      openTableFiltered,
      openQuery,
      openCreateTable,
      selectTab,
      closeTab,
      updateTab,
      closeTabsForObject,
      messages,
      unread,
      messagesOpen,
      setMessagesOpen,
      log,
      clearMessages,
      markMessagesRead,
    }),
    [
      connections,
      connectionId,
      schema,
      scopes,
      scope,
      setScope,
      databases,
      currentDatabase,
      openDatabase,
      rowCounts,
      refreshSchema,
      tabsState.tabs,
      activeTab,
      tabsState.activeId,
      openTable,
      openTableFiltered,
      openQuery,
      openCreateTable,
      selectTab,
      closeTab,
      updateTab,
      closeTabsForObject,
      messages,
      unread,
      messagesOpen,
      log,
      clearMessages,
      markMessagesRead,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}

/** Accesses the workspace store. Throws when used outside the provider. */
export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (value === null) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return value;
}

/** Convenience: qualified name for an object (re-exported for components). */
export { qualifiedObjectName };
