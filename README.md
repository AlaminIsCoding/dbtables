# dbtables

A lightweight desktop database client. The app is a Tauri desktop shell with a
React/TypeScript frontend and a Rust backend. Database access stays in Rust; the
frontend never connects to a database directly.

## Prerequisites

- Node.js with npm
- Rust toolchain with Cargo
- The Tauri system prerequisites for the OS you build on
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
| `npm run tauri build` | Produce a production desktop build for the current OS. |

## Performance and bounded results

Large results are fetched in bounded batches rather than loaded in full. The
bound lives in the backend and is mirrored, not invented, by the frontend:

- `DEFAULT_MAX_ROWS` (`500`), `HARD_MAX_ROWS` (`10_000`), and `FETCH_MORE_STEP`
  (`500`) are defined in `src-tauri/src/application/queries.rs`. Every execution
  is clamped to `HARD_MAX_ROWS`, and "fetch more" re-runs the statement with a
  larger cap until the hard ceiling is reached.
- The SQLite adapter also enforces its own hard ceiling (`MAX_RESULT_ROWS`) so a
  caller that bypasses the application still cannot load an unbounded result.
- The frontend paging policy in `src/features/results/resultPaging.ts` mirrors
  the step and stops offering "fetch more" once the backend returns fewer rows
  than requested (its hard ceiling).
- Glide virtualizes rendering, but virtualization alone does not bound backend
  or process memory; the fetch bound above is what does.
- The grid seam (`src/features/results/resultSet.ts`) passes the bounded row
  array through by reference. It performs no per-row transformation, so work on
  the render path does not scale with result size.

Automated coverage:

- `src-tauri/tests/performance.rs` runs the real SQLite adapter against a
  fixture larger than the hard ceiling and pins the default cap, the bounded
  step growth, and termination at the hard ceiling.
- `src/features/results/resultPaging.test.ts` and
  `src/features/results/resultSet.test.ts` pin the frontend paging and
  pass-through behavior.

To print the profile line for the large-result tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test performance -- --nocapture
```

## Production packages

Build the app on the operating system you intend to ship to. Tauri bundles use
native tooling and are not cross-compiled, so a Windows bundle is built on
Windows, a macOS bundle on macOS, and a Linux bundle on Linux.

### Reproducible build steps

1. Install the OS prerequisites from
   https://tauri.app/start/prerequisites/ and the matching Node.js and Rust
   toolchains.
2. Install frontend dependencies from the lockfile:
   ```sh
   npm ci
   ```
3. Build the production bundle. `beforeBuildCommand` runs `npm run build`, which
   type-checks the frontend and produces `dist/` before Rust is packaged:
   ```sh
   npm run tauri build
   ```
4. Install or launch the artifact for the OS (paths are relative to the
   repository root):

| OS | Configured bundle targets | Artifact location |
| --- | --- | --- |
| Windows | `nsis` | `src-tauri/target/release/bundle/nsis/*.exe` |
| macOS | `app`, `dmg` | `src-tauri/target/release/bundle/macos/*.app`, `src-tauri/target/release/bundle/dmg/*.dmg` |
| Linux | `deb`, `appimage` | `src-tauri/target/release/bundle/deb/*.deb`, `src-tauri/target/release/bundle/appimage/*.AppImage` |

The per-OS targets come from `src-tauri/tauri.conf.json` (Windows `nsis`) plus
`src-tauri/tauri.macos.conf.json` and `src-tauri/tauri.linux.conf.json`. Tauri
merges the platform file for the current OS; arrays replace the base value, so
each file lists every format it builds. Generated bundles live under
`src-tauri/target/` and are not committed.

### Manual packaged-app checklist

The automated build only proves the bundle is produced. A person must verify the
packaged app itself. Build and install the bundle for each agreed target OS,
then:

1. Launch the installed app (not `npm run tauri dev`) and confirm it opens.
2. Connect to disposable SQLite, MySQL, and PostgreSQL databases.
3. Run a query and export the results to CSV; compare the exported values.
4. Confirm passwords are stored through the OS credential store and do not
   appear in plain-text settings or logs.
5. Exercise a large result (more rows than the default cap) and one failed
   write; confirm bounded paging and a visible failure/uncertain outcome.

Report any OS-specific issue and confirm release readiness before treating the
hardening gate as passed.

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
