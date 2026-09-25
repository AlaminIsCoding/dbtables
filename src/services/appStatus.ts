import { invoke } from "@tauri-apps/api/core";

/**
 * Name of the Rust command registered for the typed IPC sample.
 * Keep this in sync with `src-tauri/src/commands/status.rs`.
 */
export const APP_STATUS_COMMAND = "app_status";

/** Typed request accepted by the `app_status` command. */
export interface AppStatusRequest {
  /** Optional caller label, echoed back in the response for round-trip visibility. */
  requestedBy?: string;
}

/** Typed response returned by the `app_status` command. */
export interface AppStatusResponse {
  /** Product name reported by the backend. */
  app: string;
  /** Harmless status marker. */
  status: "ok";
  /** Human-readable status message. */
  message: string;
}

/**
 * Requests a harmless status value from the Rust backend.
 *
 * Feature code should call this typed facade instead of invoking Tauri commands
 * directly, so IPC details and serialization stay out of presentation components.
 */
export async function getAppStatus(
  request: AppStatusRequest = {},
): Promise<AppStatusResponse> {
  return invoke<AppStatusResponse>(APP_STATUS_COMMAND, { request });
}
