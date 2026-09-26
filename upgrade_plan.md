# dbtables — UX & Architecture Upgrade Plan

Status: **phases 0-6 shipped; design pass 2 applied**
Owner: implementation working document
Reference mockup: `.ai/ref.html` ("Datum / studio")

### Current verification (all green)
- `npm run check` — clean
- `npm test` — 361 passed / 50 files
- `npm run build` — success
- `cargo test --manifest-path src-tauri/Cargo.toml` — 231 + 5 + 3 passed

### Design pass 2 (matches the reference exactly)
- Applied the reference's exact shadcn token set and fonts (Space Grotesk / Source
  Code Pro / Source Serif 4) in `src/index.css`.
- **Replaced glide-data-grid with a themed, dependency-free `DataTable`**
  (`src/components/data-table/`): sticky header, sticky row numbers, hover and
  selection highlight, inline cell editing, header sort cycling, drag-resize columns.
  Used by both the table browser (editable) and query results (read-only).
- Table browser: bottom **icon toolbar** (refresh, insert, apply, delete, discard,
  copy, pager, options) and a right-hand **filters/options Sheet** instead of the
  inline filter/sort bars and the stacked pending-changes panel.
- Sidebar `+` is now a dropdown; Tables/Views sections collapse; the whole sidebar
  width animates via `.sidebar-anim`.
- Create-table, Definition, and Index pages use vertical **resizable** SQL preview
  panes with normal-sized action buttons.
- Generated SQL is **syntax-highlighted** (`SqlCode` / `src/lib/sql-highlight.ts`).

---

## 1. Goal

Rebuild the dbtables desktop UI to match the reference mockup's **layout, style, and
feature set**, and fix the interaction defects that currently make table browsing
feel broken. The reference is a design target, not a spec to copy verbatim — where
the mockup is a stub (triggers, index editor, fake data) we implement the real thing
or deliberately defer it.

### Reported defects to fix

1. Clicking a table row does nothing useful — cells cannot be edited by clicking.
2. Rows cannot be selected, so multiple rows cannot be deleted together.
3. The app cannot open more than one table at a time (no tabs).

### Root causes (verified)

| # | Cause | Location |
|---|-------|----------|
| 1 | Editing only fires on double-click/Enter/Space via `onCellActivated`, and only when `canEdit` is true | `src/features/table-data/TableDataView.tsx:328-341` |
| 2 | `canEdit` requires a trustworthy primary key; key-less tables are read-only with no fallback | `TableDataView.tsx:215`, `paging.ts:115` |
| 3 | Selection tracks a single cell (`selection.current?.cell`), never a row set — multi-delete is impossible | `TableDataView.tsx:839-841`, `:354-365` |
| 4 | Editing opens a modal dialog instead of inline grid editing | `ValueEditor.tsx` |
| 5 | The grid is a `<canvas>` with no HTML row-click semantics | `src/features/results/ResultGrid.tsx` |
| 6 | `Workspace` swaps between one table view and the SQL tabs; no tab bar | `src/components/layout/Workspace.tsx:24-35` |

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Component library | **Real shadcn/ui** (CLI-installed, `radix-nova`, `radix-ui` base) | User requirement: no phony/hardcoded UI. |
| Icons | **lucide-react**, never inline `<svg>` | User requirement. `components.json` `iconLibrary: lucide`. |
| Grid engine | **Keep `@glideapps/glide-data-grid`** for both table data and query results | Virtualization for the 10k row cap; selection + editing built in. Build the missing interaction layer on top. |
| Schema DDL | **New typed Rust commands** (`create_table`, `alter_table`, `drop_table`, `create_index`, `drop_index`) | Safer, engine-aware, testable. |
| Engines | **SQLite only** for this pass, but route commands through an adapter registry so MySQL/Postgres are additive later | User has future MySQL/Postgres plans. |
| Column modify (type/null/default) | **Deferred** to a guarded table-rebuild phase | SQLite cannot `ALTER COLUMN`; rebuild risks data loss. Ship add/rename/drop + indexes first. |
| Fonts | **Space Grotesk** (sans) + **Source Code Pro** (mono) via `@fontsource-variable/*` | Matches reference; bundled offline. |
| Theme | Warm amber accent on neutral surfaces (reference palette) | Matches reference. |

---

## 3. Foundation status

- [x] Path alias `@/* → src/*` in `tsconfig.json` + `vite.config.ts`
- [x] `npx shadcn@latest init --base radix --preset nova`
- [x] `components.json`, `src/lib/utils.ts` (`cn`)
- [x] Fonts: `@fontsource-variable/space-grotesk`, `@fontsource-variable/source-code-pro`
- [x] Reference palette + `--font-sans`/`--font-mono` in `src/index.css`
- [x] shadcn components added (see §5.1)
- [x] lucide-react icon library (`components.json` `iconLibrary: lucide`)
- [x] `@types/node` for the Vite config
- [x] DDL service (`src/services/schema.ts`), DDL domain types, tab model (`src/lib/workspace/tabs.ts`), app store (`src/app/store.tsx`)
- [ ] Retire the hand-rolled `src/components/ui/cn.ts` leftover (new code uses `@/lib/utils`; `ConnectionManager` still imports the legacy helper)

> Note: the old hand-rolled `button.tsx`/`tabs.tsx` were overwritten by the shadcn
> CLI. `src/components/ui/cn.ts` still exists as a legacy helper and should be
> replaced by `@/lib/utils` `cn` during migration.

---

## 4. Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│ TopBar: sidebar toggle · brand · provider · Open DB · chip · │
│         New Query · theme                                    │
├───────────┬─────────────────────────────────────────────────┤
│ Sidebar   │ TabBar: [users ▸ data] [Query 1] [+]            │
│ ─ Schema  ├─────────────────────────────────────────────────┤
│ ─ search  │ Content (active tab)                            │
│ ─ Tables  │   · table  → subtabs: Data | Definition | Index │
│ ─ Views   │   · query  → CodeMirror + glide result grid     │
│ ─ footer  │   · create-table → definition editor            │
│           ├─────────────────────────────────────────────────┤
│           │ MessagesDrawer (collapsible)                    │
│           ├─────────────────────────────────────────────────┤
│           │ Toolbar (contextual to the active tab)         │
└───────────┴─────────────────────────────────────────────────┘
```

### App state (single store, no dual connection models)

Today the sidebar (`useConnectionManager`) and each SQL tab
(`useQuerySession`) maintain **separate** connections. The reference has one. Replace
with one app store:

```ts
interface AppState {
  connection: ActiveConnection;        // disconnected | connecting | connected | error
  schema: { tables: ObjectRef[]; views: ObjectRef[] };   // + counts
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  messages: MessageEntry[];
}
type WorkspaceTab =
  | { id; kind: "table"; object: ObjectRef; sub: "data"|"definition"|"index"; dirty: boolean }
  | { id; kind: "query"; title; sql; lastRunSql }
  | { id; kind: "create-table"; draft: TableDraft };
```

Query tabs issue `execute_query` against `state.connection`, not their own file.

### Backend architecture

```
        command layer (Tauri)
                │  State<'_, DatabaseState>
                ▼
        DatabaseState { adapters: HashMap<EngineId, Arc<dyn DatabaseAdapter>>,
                        connections: HashMap<ConnectionId, EngineId> }
                │  route by connection's engine
                ▼
        Box<dyn DatabaseAdapter>  ── sqlite | mysql | postgres
```

- `DatabaseAdapter` is already object-safe (used as `&dyn` in
  `src-tauri/src/application/metadata.rs:36`).
- New commands take `State<'_, DatabaseState>` so MySQL/Postgres drop in later without
  changing signatures.

#### New backend surface

| Command | Purpose |
|---------|---------|
| `create_table(connection_id, definition)` | Typed, validated `CREATE TABLE` incl. PK + FKs |
| `alter_table(connection_id, object, changes)` | `add_column` / `rename_column` / `drop_column` / `add_foreign_key` / `drop_foreign_key` |
| `drop_table(connection_id, object, cascade)` | Confirmed `DROP TABLE` |
| `create_index(connection_id, object, spec)` | `CREATE INDEX` |
| `drop_index(connection_id, object, name)` | `DROP INDEX` |
| `count_table_rows(connection_id, object, filters?)` | Sidebar counts + toolbar `X–Y of N` (today `totalRows` is always `None`) |

`fetch_table_page` should also populate `totalRows` when a cheap count is available,
or the UI uses `count_table_rows` separately.

#### SQLite constraints

- Supported: `ADD COLUMN`, `RENAME COLUMN`, `DROP COLUMN` (3.35+), `CREATE/DROP INDEX`,
  `CREATE/DROP TABLE`.
- Not supported directly: change column type / nullability / default. Requires a
  table rebuild (new table → copy → drop → rename) behind an explicit confirmation.
  **Deferred**.
- All identifiers quoted; changes validated before execution; destructive actions
  show generated SQL and require confirmation.

### Services layer additions

```
src/services/schema.ts   → createTable, alterTable, dropTable, createIndex, dropIndex
src/services/metadata.ts → add countTableRows
```

### Component inventory

`src/components/ui/` — shadcn components (installed, see §5.1).

`src/features/`:
- `connections/` — profile list/form + live connection chip
- `explorer/` — schema sections (Tables/Views), search, item actions, context menu
- `workspace/` — tab bar, tab host, toolbar, messages drawer
- `table-data/` — grid controller (selection + inline edit), staged changes, filters
- `schema/` — definition editor, index view, create-table form
- `query/` — SQL editor (CodeMirror) + result grid
- `results/` — glide grid adapter, value viewer, copy/export

---

## 5. Phased execution

### Phase 0 — Foundation ✅ (mostly done)
- shadcn init, aliases, fonts, palette, component set, `@types/node`.
- Remaining: retire `src/components/ui/cn.ts` in favor of `@/lib/utils`.

### Phase 1 — Backend capability layer
- [x] Typed DDL trait methods + SQLite implementations
- [x] Commands: `create_table`, `drop_table`, `add_column`, `rename_column`, `drop_column`, `add_foreign_key`, `drop_foreign_key`, `create_index`, `drop_index`, `count_table_rows`
- [x] Identifier validation + SQLite limitations surfaced as `Unsupported` (add/drop FK on existing table; ADD COLUMN with PRIMARY KEY)
- [x] Rust tests (231 total passing)
- [ ] **Deferred:** `DatabaseState` adapter registry. Rationale: every command is SQLite-typed today and the
  trait now owns DDL behind default `Unsupported` impls, so the registry can be introduced additively when
  MySQL/Postgres are actually wired. Introducing it now would only churn signatures with no engine to route to.
  The DDL additions are trait methods, so routing them later is mechanical.

### Phase 2 — Frontend foundation
- [x] App store (`src/app/store.tsx`: connection + schema + tabs + messages)
- [x] Messages log + unread state + `sonner` toasts
- [x] `TooltipProvider`, theme wiring, `Toaster`
- [~] Migrate primitives to real shadcn + `@/lib/utils` `cn` (new code uses shadcn; `ConnectionManager` still imports the legacy `components/ui/cn.ts`)

### Phase 3 — Shell
- [x] `TopBar`: sidebar toggle, brand, Open-database dropdown, live connection chip, New query, messages, theme
- [x] `Sidebar`: Tables/Views sections, counts, search, refresh, create menu, per-object context menu, drop table
- [x] `TabBar` + tab host (table / query / create-table) with dirty dots and close
- [x] Contextual per-panel toolbars (each feature view owns its bottom bar)
- [x] `MessagesDrawer`

### Phase 4 — Editable data grid (fixes the defects)
- [x] Row selection from `GridSelection` (single, ctrl/cmd toggle, shift range)
- [x] Inline editing through glide `onCellEdited`/`onCellsEdited` → staged changes
- [x] Multi-row delete ("Delete selected") with confirmation
- [x] Row theming: staged edit / staged delete / staged insert preview
- [x] Toolbar: insert, delete selected, apply, discard, refresh, pager, page size, filters, sort
- [x] Safe staged apply preserved; read-only banner when the backend has no row identity

### Phase 5 — Schema management UI
- [x] Definition subtab (column add/rename/drop + SQL preview)
- [x] Index subtab (list/create/drop from `describe_table`)
- [x] Create-Table tab
- [x] Drop-Table action with confirmation
- [~] FK add/drop surfaces the SQLite `unsupported` error honestly

### Phase 6 — Query, messages, polish
- [x] Query tabs bound to the single active connection (per-tab file input removed)
- [x] Messages drawer + toasts
- [ ] Keyboard shortcuts (⌘T/⌘⇧T/⌘B/⌘R/⌘S/⌘W)
- [ ] FK navigation + row flash

### Phase 7 — Deferred
- [ ] Column type/null/default modify via guarded table rebuild
- [ ] Trigger listing/editing (no backend support today)
- [ ] Wire MySQL/Postgres adapters into a `DatabaseState` registry
- [ ] Catalog/schema scope picker for engines that expose it
- [ ] Delete now-dead legacy components (`components/layout/{StatusBar,QueryTabs,EditorResultsSplit}.tsx`, `features/table-data/{TableDataView,ValueEditor}.tsx` where unused, legacy `components/ui/cn.ts`)

---

## 6. Testing strategy

- **Rust**: `cargo test --manifest-path src-tauri/Cargo.toml`
  - New: registry routing, DDL validation, SQLite DDL execution, count.
  - Keep adapter contract + performance suites green.
- **Frontend**: `npm test` (vitest + jsdom)
  - glide is mocked in jsdom; test the controller logic (selection, staging) directly.
  - Expect churn across layout/table-data/results tests.
- **Typecheck/build**: `npm run check`, `npm run build`.
- Gate every phase on all of the above.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| SQLite cannot alter column type/null/default | Defer to guarded rebuild; never silently rebuild |
| Destructive DDL | Validate identifiers, show generated SQL, require confirmation |
| Large scope churns many tests | Phase the work; keep checks green per phase |
| Sidebar row counts expensive on big tables | `count_table_rows` on demand / lazily, not on every list |
| glide theming fidelity vs. HTML mockup | Accept approximate styling; prioritize behavior and tokens |
| Two connection models | Unify in the app store before building tabs |

---

## 8. File map (major touch points)

**Backend**
- `src-tauri/src/lib.rs` — managed state, handler registration
- `src-tauri/src/commands/{schema.rs(new),metadata.rs,table_data.rs,connections.rs}`
- `src-tauri/src/application/{schema.rs(new),metadata.rs,table_data.rs}`
- `src-tauri/src/database/{mod.rs,sqlite.rs}`
- `src-tauri/tests/*`

**Frontend**
- `src/app/{App.tsx,store.tsx(new),useTheme.ts}`
- `src/components/layout/*` (TopBar, Sidebar, TabBar, Toolbar, MessagesDrawer)
- `src/components/ui/*` (shadcn)
- `src/features/{connections,explorer,workspace(new),table-data,schema(new),query,results}`
- `src/services/{schema.ts(new),metadata.ts,...}`
- `src/index.css`, `components.json`, `tsconfig.json`, `vite.config.ts`
