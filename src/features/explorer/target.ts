import type { QueryError } from "../../domain";
import type { ActiveConnection } from "../connections";

/**
 * Connection input the explorer is scoped to.
 *
 * This is intentionally narrow: the explorer only needs to know whether it is
 * connected and which connection token to inspect. Consumers adapt the shared
 * connection state with {@link toExplorerTarget}.
 */
export type ExplorerTarget =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; connectionId: string }
  | { status: "error"; error: QueryError };

/** Maps the connection manager's active state onto an explorer target. */
export function toExplorerTarget(active: ActiveConnection): ExplorerTarget {
  switch (active.status) {
    case "disconnected":
      return { status: "disconnected" };
    case "connecting":
      return { status: "connecting" };
    case "connected":
      return { status: "connected", connectionId: active.connectionId };
    case "error":
      return { status: "error", error: active.error };
  }
}
