# AGENTS.md — Motrix Next

> This file provides context and instructions for AI coding agents.
> For human contributors, see [README.md](README.md) and [CONTRIBUTING.md](docs/CONTRIBUTING.md).

---

## A. Project Architecture

| Layer | Stack |
|-------|-------|
| **Frontend** | Vue 3 Composition API + Pinia + Naive UI + TypeScript |
| **Backend** | Rust (Tauri 2) + aria2 sidecar |
| **Build** | Vite (frontend) + Cargo (backend) |
| **Package Manager** | pnpm (version pinned via `packageManager` field in `package.json`) |
| **Testing** | Vitest (frontend), cargo test (backend) |

### Key File Paths

```
src/
├── api/                        # Aria2 JSON-RPC client
├── components/preference/      # Settings UI (Basic.vue, Advanced.vue, UpdateDialog.vue)
├── shared/
│   ├── types.ts                # All TypeScript interfaces (AppConfig, TauriUpdate, etc.)
│   ├── constants.ts            # Timing constants, update channels
│   ├── configKeys.ts           # Config key lists (userKeys, systemKeys, needRestartKeys)
│   ├── locales/                # 26 locale directories (see Section D)
│   └── utils/                  # Pure utility functions
├── stores/                     # Pinia stores (app.ts, preference.ts)
├── views/                      # Page-level route views
└── main.ts                     # App entry, auto-update check

src-tauri/
├── src/
│   ├── lib.rs                  # Tauri builder, plugin registration, invoke_handler
│   ├── commands/
│   │   ├── app.rs              # Config, tray, menu, engine commands
│   │   └── updater.rs          # check_for_update, install_update commands
│   ├── engine.rs               # aria2 sidecar lifecycle
│   ├── error.rs                # AppError enum (Store, Engine, Io, NotFound, Updater)
│   ├── menu.rs                 # Native menu builder
│   └── tray.rs                 # System tray setup
├── Cargo.toml                  # VERSION SOURCE OF TRUTH
└── tauri.conf.json             # Tauri config (no version field — reads from Cargo.toml)

.github/workflows/
├── ci.yml                      # Lint + type check + test (frontend & backend parallel jobs)
└── release.yml                 # Build + sign + upload for 4 platforms + updater JSON
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
2. **`src/shared/configKeys.ts`** — Add the key name (kebab-case) to `userKeys` or `systemKeys` array. Without this, the value will NOT persist across restarts
3. **`src/components/preference/Basic.vue`** or **`Advanced.vue`** — Add the UI control + add to `buildForm()` initializer + add to the `watchSyncEffect` save logic
4. **All 26 locale files** — Add i18n label keys. **Must use batch Python script** (see Section D)

---

## D. i18n / Locale Operations

### Rules

1. **NEVER edit locale files manually one by one.** Always use a Python batch script.
2. Strings containing `'` must be escaped as `\'` in JS source files.
3. English (`en-US`) keys serve as the fallback — always verify this locale first.

### 26 Locale Directories

```
ar bg ca de el en-US es fa fr hu id it ja ko nb nl pl pt-BR ro ru th tr uk vi zh-CN zh-TW
```

### Script Template

```python
#!/usr/bin/env python3
"""Batch-update locale files with native translations."""
import os, re

LOCALES_DIR = "src/shared/locales"

TRANSLATIONS = {
    "ar":    ("Arabic text",),
    "bg":    ("Bulgarian text",),
    # ... all 26 locales with native translations ...
    "en-US": ("English text",),
    "zh-CN": ("Chinese Simplified text",),
    "zh-TW": ("Chinese Traditional text",),
}

def update_locale(locale_dir, values):
    filepath = os.path.join(LOCALES_DIR, locale_dir, "preferences.js")
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    # Use regex or string replacement to insert/update keys
    # Escape single quotes in values: value.replace("'", "\\'")
    # Write back
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

for locale, vals in sorted(TRANSLATIONS.items()):
    update_locale(locale, vals)
```

> **Critical:** After running, verify with `npx vite build` — locale parse errors will surface here.

---

## E. Release & Update Channels

### Trigger

The release workflow (`.github/workflows/release.yml`) is triggered by `on: release: types: [published]`.

### Tag Naming

| Channel | Tag Pattern | JSON Generated | Example |
|---------|------------|----------------|---------|
| Stable | `v1.4.0` | `latest.json` | `v1.3.1` |
| Beta | `v1.4.0-beta.N` | `beta.json` | `v1.4.0-beta.1` |
| RC | `v1.4.0-rc.N` | `beta.json` | `v1.4.0-rc.1` |

### Updater JSON Hosting

Both `latest.json` and `beta.json` are uploaded to a **permanent `updater` Release tag**:

```
https://github.com/AnInsomniacy/motrix-next/releases/download/updater/latest.json
https://github.com/AnInsomniacy/motrix-next/releases/download/updater/beta.json
```

The CI creates this Release automatically if it doesn't exist, and uses `--clobber` to overwrite on each release.

### Runtime Channel Switching

The Tauri JS `check()` API does **not** support runtime endpoint override. Channel switching is implemented via Rust commands:

- `check_for_update(channel: String)` → dynamically builds updater with correct endpoint
- `install_update(channel: String)` → downloads, installs, emits progress events

The user's channel preference is stored as `updateChannel` in the preference store.

---

## F. CI/CD Structure

### `ci.yml` (Pull Requests + Push to Main)

Two parallel jobs:

| Job | Steps |
|-----|-------|
| `frontend` | `pnpm install` → `eslint` → `prettier --check` → `vue-tsc --noEmit` → `vitest run` |
| `backend` | `cargo check --all-targets` → `cargo test` |

### `release.yml` (Release Published)

1. **Build job** — Matrix: `macos-latest`, `windows-latest`, `ubuntu-latest`, `ubuntu-24.04-arm`
2. **merge-updater-json job** — Detects channel from tag name → generates `latest.json` or `beta.json` → uploads to `updater` tag

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
- **`AppError` enum** in `error.rs` with variants: `Store`, `Engine`, `Io`, `NotFound`, `Updater`
- **Async commands**: Use `#[tauri::command]` with `async` for I/O operations
- **Plugin usage**: Tauri plugin traits (e.g., `UpdaterExt`, `StoreExt`) imported in command modules

### CSS

- **Custom properties** for all design tokens (colors, timing, easing)
- **No utility frameworks** — vanilla CSS with component-scoped styles
- **Motion**: Material Design 3 asymmetric timing and emphasized easing curves

---

## H. Verification Commands

Run all of these before committing changes:

```bash
# Frontend
pnpm test                  # Vitest — 336+ unit tests
npx vue-tsc --noEmit       # TypeScript type checking
npx vite build             # Production build validation

# Backend
cargo check                # Fast compilation check
cargo test                 # Rust unit tests

# Version
./scripts/bump-version.sh 1.3.1  # Test version sync (idempotent)
```

All must pass with zero errors before any PR or release.
