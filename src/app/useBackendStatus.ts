import { useCallback, useState } from "react";

import { getAppStatus, type AppStatusResponse } from "../services/appStatus";

export type BackendStatusState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success"; response: AppStatusResponse }
  | { status: "error"; message: string };

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return "Unknown error while contacting the backend.";
}

export interface UseBackendStatusResult {
  state: BackendStatusState;
  check: () => Promise<void>;
}

/**
 * Drives the status-bar backend health check.
 *
 * Keeps the typed IPC sample from the project foundation reachable from the
 * workspace shell without leaking Tauri command details into layout components.
 */
export function useBackendStatus(): UseBackendStatusResult {
  const [state, setState] = useState<BackendStatusState>({ status: "idle" });

  const check = useCallback(async () => {
    setState({ status: "pending" });

    try {
      const response = await getAppStatus({ requestedBy: "frontend" });
      setState({ status: "success", response });
    } catch (error) {
      // Surface the failure in the UI instead of leaving it unhandled.
      setState({ status: "error", message: describeError(error) });
    }
  }, []);

  return { state, check };
}
