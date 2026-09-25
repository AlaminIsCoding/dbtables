# dbtables

A lightweight desktop database client. The app is a Tauri desktop shell with a
React/TypeScript frontend and a Rust backend. Database access stays in Rust;
this scaffold does not connect to any database yet.

## Prerequisites

- Node.js with npm
- Rust toolchain with Cargo
- The Tauri system prerequisites for your OS
  (https://tauri.app/start/prerequisites/)

## Local commands

Run these from the repository root.

| Command | Purpose |
| --- | --- |
| `npm install` | Install frontend dependencies. |
| `npm run tauri dev` | Run the desktop app with hot reload. |
| `npm run check` | Type-check the frontend (`tsc --noEmit`). |
| `npm test` | Run frontend unit tests (Vitest). |
| `npm run rust:test` | Run Rust tests. |
| `npm run rust:build` | Build the Rust backend. |
| `npm run tauri build` | Produce a production desktop build. |

## Typed IPC sample

`src/services/appStatus.ts` exposes `getAppStatus()`, a typed frontend service
request. It invokes the `app_status` Tauri command. The thin handler in
`src-tauri/src/commands/status.rs` delegates to the Rust function in
`src-tauri/src/application/status.rs`, which returns the app name and a
harmless ready message. This establishes the frontend-service-to-Rust-command
pattern used by later features.

## Project layout

```text
src/            React/TypeScript frontend (services/, feature folders as they arrive)
src-tauri/      Tauri Rust backend (commands/, application/, and later database/)
```
