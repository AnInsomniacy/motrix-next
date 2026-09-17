# AGENTS.md — Rayburst

> This file provides context and instructions for AI coding agents.
> For human contributors, see [README.md](README.md) and [CONTRIBUTING.md](docs/CONTRIBUTING.md).

> [!IMPORTANT]
> **All changes must meet industrial-grade quality.** Enforce DRY (extract composables/utilities over duplication), strict TypeScript (no `any`, justify every `as` cast), structured error handling, and full verification (`vue-tsc` + tests pass) before completion.

---

## A. Project Architecture

| Layer               | Stack                                                              |
| ------------------- | ------------------------------------------------------------------ |
| **Frontend**        | Vue 3 Composition API + Pinia + Naive UI + TypeScript              |
| **Backend**         | Rust (Tauri 2) + aria2 sidecar                                     |
| **Build**           | Vite (frontend) + Cargo (backend)                                  |
| **Package Manager** | pnpm (version pinned via `packageManager` field in `package.json`) |
| **Testing**         | Vitest (frontend), cargo test (backend)                            |

### Key File Paths

```
src/
├── api/                        # Aria2 JSON-RPC client (frontend wrapper)
├── components/preference/      # Settings UI (Basic.vue, Advanced.vue, UpdateDialog.vue)
├── composables/                # Vue composables — business logic extracted from components
├── layouts/                    # Page-level layouts (MainLayout.vue)
├── shared/
│   ├── types.ts                # All TypeScript interfaces (AppConfig, TauriUpdate, etc.)
│   ├── constants.ts            # DEFAULT_APP_CONFIG, proxy scopes, tracker URLs, timing constants
│   ├── configKeys.ts           # needRestartKeys + re-exports of aria2Options.json lists
│   ├── aria2Options.json       # SINGLE SOURCE for engine option lists (TS + Rust both consume)
│   ├── logger.ts               # Structured logging (console + webview bridge)
│   ├── timing.ts               # Timing constants (polling intervals, debounce delays)
│   ├── guards.ts               # Type guard utilities
│   ├── locales/                # 27 locale directories (see Section D)
│   └── utils/
│       ├── configHydration.ts  # Current config defaults, nested merge, and validation
│       ├── config.ts           # Config key-value transform utilities
│       ├── tracker.ts          # BT tracker fetching with proxy support
│       ├── geoip.ts            # GeoIP peer lookup (country code → flag)
│       ├── fileCategory.ts     # File type classification by extension
│       ├── autoArchive.ts      # Auto-archive completed tasks
│       ├── format.ts           # Number/date/speed formatting (bytesToSize, localeDateTimeFormat)
│       ├── task.ts             # Task status helpers (checkTaskIsBT, getTaskName)
│       ├── peer.ts             # Peer ID parsing and client identification
│       └── proxy.ts            # Proxy policy, URL building/validation, engine option assembly
├── stores/                     # Pinia stores (app.ts, preference.ts, history.ts, task/)
├── views/                      # Page-level route views
└── main.ts                     # App entry, auto-update check

src-tauri/
├── src/
│   ├── lib.rs                  # Tauri builder, plugin registration, invoke_handler
│   ├── main.rs                 # Tauri entry point
│   ├── aria2/                  # Native Rust aria2 JSON-RPC client
│   │   ├── mod.rs              # Module re-exports
│   │   ├── rpc.rs              # HTTP JSON-RPC transport, authentication and structured errors
│   │   └── types.rs            # Aria2 response types (Aria2Task, Aria2File, Aria2BtInfo, etc.)
│   ├── commands/
│   │   ├── mod.rs              # Command module re-exports
│   │   ├── aria2.rs            # aria2 JSON-RPC forwarding (tell_active, global_stat, etc.)
│   │   ├── config.rs           # Config CRUD, session, factory reset commands
│   │   ├── engine.rs           # Engine start/stop/restart commands
│   │   ├── fs.rs               # File system ops, diagnostics, platform code
│   │   ├── geoip.rs            # GeoIP database loading and peer IP lookup
│   │   ├── history.rs          # History DB read/write commands
│   │   ├── http_api.rs         # Local extension HTTP API auth and status commands
│   │   ├── remote_file.rs      # Remote torrent download and metainfo inspection
│   │   ├── notification.rs     # Native notification permission and test commands
│   │   ├── power.rs            # System power action commands
│   │   ├── protocol.rs         # Default protocol handler detection and registration
│   │   ├── proxy.rs            # System proxy detection (PAC, WPAD, env)
│   │   ├── runtime_config.rs   # RuntimeConfig refresh command
│   │   ├── tracker.rs          # Tracker probing and protocol classification
│   │   ├── ui.rs               # Tray, menu, dock, progress bar commands
│   │   ├── updater.rs          # check_for_update, download_update, apply_update, cancel_update
│   │   └── upnp.rs             # UPnP port mapping commands
│   ├── engine/
│   │   ├── mod.rs              # Module re-exports
│   │   ├── lifecycle.rs        # aria2 sidecar start/stop/restart
│   │   ├── config.rs           # Managed runtime aria2.conf generation
│   │   ├── cleanup.rs          # Engine cleanup utilities
│   │   └── state.rs            # Engine state management
│   ├── services/
│   │   ├── mod.rs              # Runtime services orchestration (on_engine_ready)
│   │   ├── config.rs           # RuntimeConfig cache (refreshed per engine cycle)
│   │   ├── deep_link.rs        # Deep-link and startup URL dispatch service
│   │   ├── external_input.rs   # External extension/API input queue service
│   │   ├── frontend_action.rs  # Frontend action event bridge
│   │   ├── http_api.rs         # Local HTTP API server for browser extensions
│   │   ├── monitor.rs          # Task lifecycle monitor, history DB persistence, event emission
│   │   ├── notification.rs     # Native notification dispatch service
│   │   ├── port_guard.rs       # Runtime port conflict detection and recovery
│   │   ├── power.rs            # Sleep prevention and power guard service
│   │   ├── stat.rs             # Global stat polling, Dock badge, Dock progress bar (custom NSProgressIndicator)
│   │   └── speed.rs            # Speed limit scheduler (time-of-day limits)
│   ├── gpu_guard.rs            # GPU compatibility detection and WebView renderer fallback
│   ├── database/               # Single native SQLite owner: history, credentials, receipts
│   ├── i18n.rs                 # Native locale negotiation and rust-i18n message access
│   ├── error.rs                # AppError enum (Store, Engine, Io, NotFound, Updater, Upnp)
│   ├── menu.rs                 # Native menu builder (macOS only, cfg-gated)
│   ├── tray.rs                 # System tray setup + native event handling (lightweight mode safe)
│   └── upnp.rs                 # UPnP/IGD port mapping with renewal loop
├── locales/                    # Compile-time embedded native JSON translations
├── nsis/
│   ├── hooks.nsh              # Windows installer hooks (Native Messaging registration + icon refresh)
├── Cargo.toml                  # VERSION SOURCE OF TRUTH
└── tauri.conf.json             # Tauri config (no version field — reads from Cargo.toml)

.github/
├── ISSUE_TEMPLATE/             # Bug report (YAML form) + feature request templates
├── PULL_REQUEST_TEMPLATE.md    # PR template with TypeScript + Rust checklist
└── workflows/
    ├── ci.yml                  # Lint + type check + test (frontend & backend parallel jobs)
    └── release.yml             # Build + sign + upload for 6 platforms + updater JSON
```

---

## B. Version Management

**`src-tauri/Cargo.toml` is the single source of truth.** The `version` field in `package.json` must stay in sync.

### How to Bump

Always use the provided script:

```bash
./scripts/bump-version.sh 1.4.0
```

This atomically updates both `Cargo.toml` and `package.json`.

### Why Two Files?

- `Cargo.toml` — Tauri reads this at build time; the About panel reads it via `getVersion()` at runtime.
- `package.json` — pnpm/action-setup and npm tooling reference this; CI workflows use the `packageManager` field.
- `tauri.conf.json` — intentionally omits `version` so Tauri falls back to `Cargo.toml`.

> **Never manually edit version strings.** Always use `bump-version.sh`.

---

## C. Adding a New Config Key

Follow this exact checklist:

1. **`src/shared/types.ts`** — Add the field to the `AppConfig` interface with proper typing
2. **`src/shared/aria2Options.json`** — ONLY if the key maps to an aria2 engine option: add it to `engineOptions` (and to `nonHotReloadable` if aria2 cannot change it at runtime). Both the frontend and the Rust backend read this file. App-only preference keys need no list entry — the whole config object is persisted as-is
3. **`src/shared/constants.ts`** — Add the default value to `DEFAULT_APP_CONFIG`
4. **`src/shared/utils/configHydration.ts`** — Check whether the key needs validation, repair, or selective nested merge. Top-level keys usually need no code here; nested object keys and enum-like values usually do.
5. **UI binding** — Add the field to the relevant preference composable and component save flow
6. **All 27 locale files** — Add i18n label keys. **Must use batch Python script** (see Section D)
7. **Compatibility** — This product has a fresh storage identity. Do not add import aliases or migrations for another product.

---

## C′. Current configuration

`configHydration.ts` materializes defaults, accepts current keys only, validates values
and reports repairs. Unknown fields are discarded. It does not run a historical
migration chain. Arrays remain user-owned; nested fixed-shape objects are hydrated
selectively. Missing secrets are generated; an empty secret remains explicitly cleared.

The native database owns its schema. The frontend does not persist schema-version
mirrors or display historical migration toasts. Unsupported databases fail without deletion.

---

## C″. Native Database Ownership

`src-tauri/src/database/` owns the single `history.db` connection and current schema.
History, credentials and ordinary submission receipts use named Rust operations.
Vue stores never execute SQL or own a connection. Startup initializes storage in
Rust; it does not depend on the main WebView. See [DOWNLOADS.md](docs/DOWNLOADS.md).

- Define tables in `database/schema.sql` and keep `SCHEMA_VERSION` in Rust.
- Use native transactions when several queries form one operation.
- Opening supported existing data must preserve it; unsupported schemas fail explicitly.
- Initialization failure never deletes data. Only explicit reset closes the owner and removes files.
- Test real SQLite behavior for schema, paging, persistence and receipts. Do not mock SQL strings.
- There is no frontend SQL plugin, migration directory or dual-connection reset path.
- `services/tasks/` owns task policy; `aria2/rpc.rs` remains a transport.

---

## D. i18n / Locale Operations

### Rules

1. **NEVER edit locale files manually one by one.** Always use a Python batch script.
2. Every locale owns one `messages.json`; preserve its nested namespaces and placeholders.
3. English (`en-US`) is the schema and fallback — always verify it first.
4. Register locale metadata in `src/shared/locales/catalog.json` and native strings in `src-tauri/locales/<locale>.json`.

### 27 Locale Directories

```
ar bg ca de el en-US es fa fr hi hu id it ja ko nb nl pl pt-BR ro ru th tr uk vi zh-CN zh-TW
```

### Script Template

```python
#!/usr/bin/env python3
"""Batch-update locale files with native translations."""
import json
from pathlib import Path

LOCALES_DIR = Path("src/shared/locales")

TRANSLATIONS = {
    "ar":    ("Arabic text",),
    "bg":    ("Bulgarian text",),
    # ... all 27 locales with native translations ...
    "en-US": ("English text",),
    "zh-CN": ("Chinese Simplified text",),
    "zh-TW": ("Chinese Traditional text",),
}

def update_locale(locale_dir, values):
    filepath = LOCALES_DIR / locale_dir / "messages.json"
    messages = json.loads(filepath.read_text(encoding="utf-8"))
    messages["preferences"]["new-key"] = values[0]
    filepath.write_text(json.dumps(messages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

for locale, vals in sorted(TRANSLATIONS.items()):
    update_locale(locale, vals)
```

> **Critical:** After running, verify with `pnpm lint`, `pnpm check:repo`, `npx vue-tsc --noEmit`, and `npx vite build`.

---

## E. Release & Update Channels

### Trigger

The release workflow (`.github/workflows/release.yml`) is triggered by `on: release: types: [published]`.

### Tag Naming

| Channel | Tag Pattern     | JSON Generated | Example         |
| ------- | --------------- | -------------- | --------------- |
| Stable  | `v1.4.0`        | `latest.json`  | `v1.3.1`        |
| Beta    | `v1.4.0-beta.N` | `beta.json`    | `v1.4.0-beta.1` |
| RC      | `v1.4.0-rc.N`   | `beta.json`    | `v1.4.0-rc.1`   |

### Updater JSON Hosting

Both `latest.json` and `beta.json` are uploaded to the **`rayburst-updater` Release tag**:

```
https://github.com/AnInsomniacy/rayburst/releases/download/rayburst-updater/latest.json
https://github.com/AnInsomniacy/rayburst/releases/download/rayburst-updater/beta.json
```

The CI creates this Release automatically if it doesn't exist, and uses `--clobber` to overwrite on each release.

### Runtime Channel Switching

The Tauri JS `check()` API does **not** support runtime endpoint override. Channel switching is implemented via Rust commands:

- `check_for_update(channel, proxy)` → dynamically builds updater with correct endpoint
- `download_update(channel, proxy)` → downloads update binary, emits progress events
- `apply_update(channel)` → stops engine, installs downloaded update
- `cancel_update()` → cancels in-progress download

The user's channel preference is stored as `updateChannel` in the preference store.

### How to Publish a Release

All code changes must be finalized before starting. Execute these three steps in strict order:

1. **Bump the version:**

   ```bash
   # Stable
   ./scripts/bump-version.sh 1.4.0
   # Beta
   ./scripts/bump-version.sh 1.4.0-beta.1
   ```

   **Do not modify code after this step.** This updates `Cargo.toml` + `package.json`.

2. **Release:**

   ```bash
   ./scripts/release.sh
   ```

   This formats code, commits all changes, creates an annotated tag `v{VERSION}`, and pushes to origin.
   The script outputs a color-coded channel indicator (yellow = pre-release, green = stable).

3. **Publish the GitHub Release:**

   Generate an English release title and release notes from the commits included in this release, following the Release Notes Conventions below.

   Use the user-specified version and channel; otherwise increment the current channel's version without confirmation. Enforce the Tag Naming rules above. Before creating the GitHub Release, show the version, pre-release status, English title, and release notes, then publish with `gh release create` when authenticated. Mark beta, alpha, and RC releases as pre-releases. Publishing the GitHub Release starts the release workflow.

   If `gh` is unavailable, unauthenticated, or the user explicitly wants to publish manually, output the title and body in **two separate markdown code blocks** so the user can paste them into the GitHub Release page.

### Updater Principles

- **Channel detection** — CI checks the tag name: tags containing `-beta`, `-alpha`, or `-rc` → `beta.json`; everything else → `latest.json`
- **Single fixed host** — Both JSON files live in a permanent `rayburst-updater` Release tag (auto-created by CI on first publish). Each publish overwrites the previous JSON via `--clobber`
- **Tag = immutable pointer** — A git tag points to a fixed commit. If a build fails, you must delete both the tag and the Release, then re-publish to pick up the fixed code
- **CI trigger** — Only `on: release: [published]` triggers builds. Pushing a tag alone does **not** trigger the workflow

### Recovering from a Failed Release

```bash
# 1. Fix the code, commit and push
git add -A && git commit -m "fix: resolve build issue" && git push

# 2. Delete the remote tag
git push origin --delete v2.1.1

# 3. Delete the local tag
git tag -d v2.1.1

# 4. Delete the failed Release on GitHub (Releases → click → Delete this release)
# 5. Re-run bump-version.sh with the same version to re-create the tag
./scripts/bump-version.sh 2.1.1
git push && git push --tags
# 6. Re-create the Release in the GitHub UI selecting the tag
```

### Release Notes Conventions

**Title format:** `v{VERSION} — {Short Description}`

Examples: `v2.0.0 — Stability & Quality Release`, `v2.0.1 — Bug Fixes`, `v2.1.0 — Proxy Support`

**Body template:**

```markdown
> [!CAUTION]
> **Breaking change notice** (only if applicable)

## What's Changed

One-paragraph summary of the release scope and significance.

### ✨ New Features

- **Feature name** — short description
- **Feature name** — short description

### 🛠 Improvements

- Description of improvement
- Description of improvement

### 🐛 Bug Fixes

- Fixed specific issue

### 📦 Downloads

| Platform | Architecture          | File                      |
| -------- | --------------------- | ------------------------- |
| macOS    | Apple Silicon · Intel | `.dmg`                    |
| Windows  | x64 · ARM64           | `-setup.exe`              |
| Linux    | x64 · ARM64           | `.AppImage` `.deb` `.rpm` |
```

**Guidelines:**

- Use `> [!CAUTION]` GitHub Alert only for breaking changes or manual action required
- Omit empty sections — e.g. no Bug Fixes section if there are none
- Patch releases: keep concise, only list what changed
- Major releases: include a summary paragraph explaining the scope

---

## F. CI/CD Structure

### `ci.yml` (Pull Requests + Push to Main)

Two parallel jobs:

| Job        | Steps                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend` | `pnpm install` → `pnpm lint` → `pnpm format:check` → `vue-tsc --noEmit` → `vitest run` → `vite build`                                                                                                    |
| `backend`  | `cargo fmt --all -- --check` → `pnpm build:native-launcher` → `cargo clippy --workspace --all-targets -- -D warnings` → `cargo check --workspace --all-targets` → `cargo test --workspace --all-targets` |

### `release.yml` (Release Published)

1. **Build job** — Matrix: `macos-latest` (aarch64), `macos-15-intel` (x86_64), `windows-latest` (×2: x64 + aarch64 cross-compile), `ubuntu-22.04` (GLIBC 2.35 compat), `ubuntu-24.04-arm`
2. **merge-updater-json job** — Detects channel from tag name → generates `latest.json` or `beta.json` with 6 platform keys → uploads to `rayburst-updater` tag

---

## G. Code Conventions

### TypeScript / Vue

- **Strict mode** enabled in `tsconfig.json`
- **`<script setup lang="ts">`** for all components
- **Path aliases**: `@/` → `src/`, `@shared/` → `src/shared/`
- **Imports**: named imports from `naive-ui`, destructured Tauri APIs
- **State management**: Pinia stores with Composition API style (`setup` function)
- **Formatting**: Prettier with project config (`.prettierrc`)

### Rust

- **Error handling**: All commands return `Result<T, AppError>`, never raw `String` errors
- **`AppError` enum** in `error.rs` with variants: `Store`, `Engine`, `Io`, `NotFound`, `Updater`, `Upnp`
- **Async commands**: Use `#[tauri::command]` with `async` for I/O operations
- **Plugin usage**: Tauri plugin traits (e.g., `UpdaterExt`, `StoreExt`) imported in command modules

### CSS

- **Custom properties** for all design tokens (colors, timing, easing)
- **No utility frameworks** — vanilla CSS with component-scoped styles
- **Motion**: Material Design 3 asymmetric timing and emphasized easing curves

### Color System

Rayburst uses a dynamic Material Design 3 color system generated by `@material/material-color-utilities`. `src/shared/utils/colorScheme.ts` is the single source of truth: a preset or custom seed produces the complete light and dark palettes. Primary and tertiary provide theme accents; info, success, warning, and error are harmonized semantic colors. Each role includes color, matching foreground, container, container foreground, hover, and pressed values. Neutral surfaces use the ordered `surface` and `surface-container-*` roles, while text and borders use `on-surface*` and `outline*`.

`src/composables/useColorScheme.ts` is the only bridge to consumers. It maps the generated tokens to CSS variables, Naive UI overrides, and reactive Canvas consumers. Task status colors are aliases of the same roles: active uses primary, waiting uses info, paused uses outline, error uses error, and complete or sharing uses success. `src/styles/tokens.css` contains first-paint fallbacks only; runtime values replace them after startup. Components must consume semantic tokens instead of fixed colors. Fixed colors are limited to platform-defined controls, brand artwork, and color-picker swatches.

---

## H. Verification Commands

Run these before committing changes:

```bash
# Frontend
pnpm format                # Auto-format all source files with Prettier
pnpm lint                  # ESLint check
pnpm format:check          # Verify formatting (CI runs this)
pnpm test                  # Vitest unit tests
pnpm check:repo            # Locale parity + i18n literal-key usage (CI runs this)
npx vue-tsc --noEmit       # TypeScript type checking

# Backend
pnpm build:native-launcher       # Build the target-specific Native Messaging sidecar
cargo check --workspace --all-targets  # Fast compilation check
cargo test --workspace --all-targets   # Rust unit tests

# Version (when bumping)
./scripts/bump-version.sh <version>
```

> **Every commit MUST pass `pnpm format:check`.** If you edit any `.ts`, `.vue`, `.css`, or `.json` file, run `pnpm format` before committing. The husky pre-commit hook runs lint-staged automatically, but it only formats staged files — so always verify with `pnpm format:check` if unsure.

> **Note:** `npx vite build` is slow and should only be run when validating production output or debugging locale/bundling issues — not on every change.

All fast checks must pass with zero errors before any PR or release.

---

## I. Testing Constraints

> **DO NOT use browser tools (Playwright, browser subagent, etc.) to test this app.** Tauri renders in a native webview — `localhost:1420` in a browser lacks IPC, tray, and sidecar access. Use CLI checks (`vue-tsc`, `pnpm test`, `cargo test --workspace --all-targets`) or ask the user to verify UI via `pnpm tauri dev`.

## Brand and delivery

Use the supplied SVG master and interface seed `#946ECE` in the standard source
palette mode. Preserve the master logo colors. Keep all implementation
comments and documentation in English. Product names remain untranslated. Localize
interface copy and slogans in every supported locale, preserving the approved English
and Chinese slogans. Keep the approved promotional banners in English. Review prose with Sepia.

Follow `docs/BRAND.md` and `docs/RELEASING.md`. Store identities and update signing must
be configured explicitly for Rayburst. Local verification never submits to a store,
publishes a website, changes remotes or starts release automation. Native end-to-end
acceptance belongs to the user. Work on the current branch; do not spawn agents.

## Documentation editing

Preserve the existing README and documentation structure, wording and tone. Make
minimal edits for branding, outdated behavior, commands, links and directory layouts.
Do not rewrite unaffected prose or restore acknowledgements sections.
