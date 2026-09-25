import { useState } from "react";

import {
  getAppStatus,
  type AppStatusResponse,
} from "./services/appStatus";

type RequestState =
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

export default function App() {
  const [request, setRequest] = useState<RequestState>({ status: "idle" });

  async function handleRequestStatus() {
    setRequest({ status: "pending" });

    try {
      const response = await getAppStatus({ requestedBy: "frontend" });
      setRequest({ status: "success", response });
    } catch (error) {
      // Surface the failure in the UI instead of leaving it unhandled.
      setRequest({ status: "error", message: describeError(error) });
    }
  }

  const isPending = request.status === "pending";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
      <h1 className="text-2xl font-semibold">dbtables</h1>
      <p className="text-sm text-slate-400">
        Desktop database client scaffold. Feature work follows.
      </p>

      <section className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={handleRequestStatus}
          disabled={isPending}
          className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Requesting…" : "Request backend status"}
        </button>

        <div role="status" aria-live="polite" className="text-sm">
          {request.status === "idle" && (
            <span className="text-slate-500">No backend response yet.</span>
          )}
          {request.status === "pending" && (
            <span className="text-slate-400">Waiting for the backend…</span>
          )}
          {request.status === "success" && (
            <span className="text-emerald-400">
              {request.response.app}: {request.response.message}
            </span>
          )}
        </div>

        {request.status === "error" && (
          <p role="alert" className="text-sm text-red-400">
            Backend request failed: {request.message}
          </p>
        )}
      </section>
    </main>
  );
}
