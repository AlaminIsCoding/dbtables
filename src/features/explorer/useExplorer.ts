import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ObjectRef,
  ObjectScope,
  QueryError,
  ScopeListing,
  TableDescription,
} from "../../domain";
import { toQueryError } from "../../services/errors";
import {
  describeTable,
  listObjects,
  listScopes,
} from "../../services/metadata";
import type { ExplorerTarget } from "./target";
import { buildExplorerGroups, filterObjects, type ExplorerGroup } from "./tree";

/** Loading/ready/error/unsupported state for the scope (database/schema) list. */
export type ExplorerScopesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; listing: ScopeListing }
  | { status: "unsupported" }
  | { status: "error"; error: QueryError };

/** State of the object (table/view) list for the active scope. */
export type ExplorerObjectsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; objects: ObjectRef[] }
  | { status: "error"; error: QueryError };

/** State of the detail panel for the selected object. */
export type ExplorerDetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; description: TableDescription }
  | { status: "error"; error: QueryError };

export interface ExplorerController {
  /** Connection the explorer is currently scoped to. */
  target: ExplorerTarget;
  /** Exposed database/schema scopes, or unsupported for engines with none. */
  scopes: ExplorerScopesState;
  /** Selected database/schema scope; absent fields use the connection default. */
  scope: ObjectScope;
  /** Selects a database/schema scope. */
  setScope: (scope: ObjectScope) => void;
  /** Tables and views in the active scope. */
  objects: ExplorerObjectsState;
  /** Object filter text. */
  filter: string;
  /** Replaces the object filter text. */
  setFilter: (filter: string) => void;
  /** Objects matching the current filter, in listing order. */
  filteredObjects: ObjectRef[];
  /** Filtered objects grouped by exposed scope. */
  groups: ExplorerGroup[];
  /** Object selected for the detail panel, if any. */
  selected: ObjectRef | null;
  /** Selects (or clears) the detail object. */
  select: (object: ObjectRef | null) => void;
  /** Metadata for the selected object. */
  detail: ExplorerDetailState;
  /** Reloads scopes, objects, and the selected object's detail. */
  refresh: () => void;
}

/** Returns the connection token the explorer should inspect, if connected. */
function connectionIdOf(target: ExplorerTarget): string | null {
  return target.status === "connected" ? target.connectionId : null;
}

/**
 * Owns explorer tree and detail state for one active connection.
 *
 * State is scoped to the connection token: when the target changes, the scope,
 * filter, selection, and detail are reset and every in-flight result for the old
 * connection is discarded, so stale metadata can never appear under a newly
 * selected connection. Objects load when a connection/scope becomes active and
 * detail loads only once an object is selected, keeping the tree lazy.
 */
export function useExplorer(target: ExplorerTarget): ExplorerController {
  const connectionId = connectionIdOf(target);

  const [scopes, setScopes] = useState<ExplorerScopesState>({
    status: "idle",
  });
  const [scope, setScope] = useState<ObjectScope>({});
  const [objects, setObjects] = useState<ExplorerObjectsState>({
    status: "idle",
  });
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ObjectRef | null>(null);
  const [detail, setDetail] = useState<ExplorerDetailState>({ status: "idle" });
  const [reloadToken, setReloadToken] = useState(0);

  const previousConnectionRef = useRef<string | null>(null);

  // Reset connection-scoped state and reload the exposed scopes whenever the
  // connection changes or the user refreshes.
  useEffect(() => {
    const connectionChanged =
      previousConnectionRef.current !== connectionId;
    previousConnectionRef.current = connectionId;

    if (connectionChanged) {
      setScope({});
      setFilter("");
      setSelected(null);
      setDetail({ status: "idle" });
    }

    if (connectionId === null) {
      setScopes({ status: "idle" });
      setObjects({ status: "idle" });
      return;
    }

    let active = true;
    setScopes({ status: "loading" });

    void (async () => {
      try {
        const listing = await listScopes(connectionId);
        if (!active) {
          return;
        }
        setScopes({ status: "ready", listing });
      } catch (error) {
        if (!active) {
          return;
        }
        const queryError = toQueryError(error);
        setScopes(
          queryError.category === "unsupported"
            ? { status: "unsupported" }
            : { status: "error", error: queryError },
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [connectionId, reloadToken]);

  // Load objects for the active connection and scope. An empty scope means the
  // connection's default, which is the only option for engines like SQLite.
  const scopeDatabase = scope.database;
  const scopeSchema = scope.schema;

  useEffect(() => {
    if (connectionId === null) {
      setObjects({ status: "idle" });
      return;
    }

    let active = true;
    setObjects({ status: "loading" });

    const nextScope: ObjectScope | undefined =
      scopeDatabase === undefined && scopeSchema === undefined
        ? undefined
        : { database: scopeDatabase, schema: scopeSchema };

    void (async () => {
      try {
        const listed = await listObjects(connectionId, nextScope);
        if (!active) {
          return;
        }
        setObjects({ status: "ready", objects: listed });
      } catch (error) {
        if (!active) {
          return;
        }
        setObjects({ status: "error", error: toQueryError(error) });
      }
    })();

    return () => {
      active = false;
    };
  }, [connectionId, scopeDatabase, scopeSchema, reloadToken]);

  // Load detail only after the user selects an object.
  useEffect(() => {
    if (connectionId === null || selected === null) {
      setDetail({ status: "idle" });
      return;
    }

    let active = true;
    setDetail({ status: "loading" });

    void (async () => {
      try {
        const description = await describeTable(connectionId, selected);
        if (!active) {
          return;
        }
        setDetail({ status: "ready", description });
      } catch (error) {
        if (!active) {
          return;
        }
        setDetail({ status: "error", error: toQueryError(error) });
      }
    })();

    return () => {
      active = false;
    };
  }, [connectionId, selected, reloadToken]);

  const filteredObjects = useMemo(() => {
    const list = objects.status === "ready" ? objects.objects : [];
    return filterObjects(list, filter);
  }, [objects, filter]);

  const groups = useMemo(() => {
    if (objects.status !== "ready") {
      return [];
    }
    const listing = scopes.status === "ready" ? scopes.listing : null;
    return buildExplorerGroups(listing, objects.objects, filter);
  }, [objects, scopes, filter]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const select = useCallback((object: ObjectRef | null) => {
    setSelected(object);
  }, []);

  return {
    target,
    scopes,
    scope,
    setScope,
    objects,
    filter,
    setFilter,
    filteredObjects,
    groups,
    selected,
    select,
    detail,
    refresh,
  };
}
