<div align="center">
  <img src="src/assets/logo.png" alt="Motrix Next" width="128" height="128" style="border-radius: 24px;" />
  <h1>Motrix Next</h1>
  <p>A full-featured download manager — rebuilt from the ground up.</p>

  [![GitHub release](https://img.shields.io/github/v/release/AnInsomniacy/motrix-next?style=flat-square)](https://github.com/AnInsomniacy/motrix-next/releases)
  ![Build](https://img.shields.io/github/actions/workflow/status/AnInsomniacy/motrix-next/release.yml?style=flat-square)
  ![Platform](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-2b2b2b?style=flat-square)
  ![Bundle](https://img.shields.io/badge/bundle-~10_MB-00D4AA?style=flat-square)

  [![Website](https://img.shields.io/badge/Website-E0A422?style=for-the-badge&logo=safari&logoColor=white)](https://motrix-next.pages.dev)
  [![Download](https://img.shields.io/badge/Download-2b2b2b?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIxIDE1djRhMiAyIDAgMCAxLTIgMkg1YTIgMiAwIDAgMS0yLTJ2LTQiLz48cG9seWxpbmUgcG9pbnRzPSI3IDEwIDEyIDE1IDE3IDEwIi8+PGxpbmUgeDE9IjEyIiB5MT0iMTUiIHgyPSIxMiIgeTI9IjMiLz48L3N2Zz4=&logoColor=white)](https://github.com/AnInsomniacy/motrix-next/releases)
</div>

---

<div align="center">
  <img src="docs/media/screenshot-downloading.png" alt="Motrix Next Downloading Interface" width="720" />
</div>

## Why Motrix Next?

[Motrix](https://github.com/agalwood/Motrix) by [agalwood](https://github.com/agalwood) was one of the best open-source download managers available — clean UI, aria2-powered, cross-platform. It inspired thousands of users and developers alike.

However, the original project has been largely inactive since 2023. The Electron + Vue 2 + Vuex + Element UI stack accumulated technical debt, making it increasingly difficult to maintain, extend, or package for modern platforms.

### What we kept

We owe a great deal to the original [Motrix](https://github.com/agalwood/Motrix) and its community. The following were gratefully adopted and continue to serve as the foundation for parts of Motrix Next:

- **Aria2 error code system and RPC client** — the error handling conventions and JSON-RPC communication layer for the aria2 engine
- **Internationalization** — 25+ community-contributed locale files covering Chinese, Japanese, Korean, Arabic, French, German, and many more
- **Download utilities** — tracker list management, cURL command parsing, and other protocol-level helpers

### What we rebuilt

**Motrix Next is not a fork — it is a complete rewrite.** Every other layer of the application has been redesigned and reimplemented from scratch:

| Layer | Motrix (Legacy) | Motrix Next |
|-------|----------------|-------------|
| **Runtime** | Electron | **Tauri 2** (Rust) |
| **Frontend** | Vue 2 + Vuex | **Vue 3 Composition API + Pinia** |
| **UI Framework** | Element UI | **Naive UI** |
| **Language** | JavaScript | **TypeScript + Rust** |
| **Styling** | SCSS + Element theme | **Vanilla CSS + custom properties** |
| **Engine Mgmt** | Node.js `child_process` | **Tauri sidecar** |
| **Build System** | electron-builder | **Vite + Cargo** |
| **Bundle Size** | — | **~10 MB** |
| **Auto-Update** | electron-updater | **Tauri updater plugin** |

Version numbering starts at `1.0.0` to reflect this clean break.

### Design & Motion

The overall UI layout stays true to Motrix's original design — the sidebar navigation, task list, and preference panels all follow the familiar structure that made Motrix intuitive from day one.

What changed is everything underneath. Every transition and micro-interaction has been carefully tuned to follow [Material Design 3](https://m3.material.io/styles/motion/overview) motion guidelines:

- **Asymmetric timing** — enter animations are slightly longer than exits, giving new content time to land while dismissed content leaves quickly
- **Emphasized easing curves** — decelerate on enter (`cubic-bezier(0.2, 0, 0, 1)`), accelerate on exit (`cubic-bezier(0.3, 0, 0.8, 0.15)`), replacing generic `ease` curves throughout the codebase
- **Spring-based modals** — dialogs use physically-modeled spring animations for a natural, responsive feel
- **Consistent motion tokens** — all durations and curves are defined as CSS custom properties, ensuring a unified rhythm across 12+ components

## Features

- **Multi-protocol downloads** — HTTP, FTP, BitTorrent, Magnet links
- **BitTorrent** — Selective file download, DHT, peer exchange, encryption
- **Tracker management** — Auto-sync from community tracker lists
- **Concurrent downloads** — Up to 10 tasks with configurable thread count
- **Speed control** — Global and per-task upload/download limits
- **System tray** — Real-time speed display in the menu bar (macOS)
- **Dark mode** — Native dark theme with system preference detection
- **i18n** — Auto-detects system language on first launch
- **Task management** — Pause, resume, delete with file cleanup, batch operations
- **Download protocols** — Register as default handler for magnet and thunder links
- **Notifications** — System notifications on task completion
- **Lightweight** — Tauri-powered, minimal resource footprint

## Installation

Download the latest release from [GitHub Releases](https://github.com/AnInsomniacy/motrix-next/releases).

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)

### Setup

```bash
# Clone the repository
git clone https://github.com/AnInsomniacy/motrix-next.git
cd motrix-next

# Install frontend dependencies
pnpm install

# Start development server (launches Tauri + Vite)
pnpm tauri dev

# Build for production
pnpm tauri build
```

### Project Structure

```
motrix-next/
├── src/                    # Frontend (Vue 3 + TypeScript)
│   ├── api/                # Aria2 RPC client
│   ├── components/         # Vue components
│   ├── shared/             # Constants, utilities, i18n locales
│   ├── stores/             # Pinia state management
│   └── views/              # Page-level views
├── src-tauri/              # Backend (Rust + Tauri)
│   ├── src/                # Tauri commands, engine management, tray/menu
│   └── binaries/           # Aria2 sidecar binary
└── package.json
```

### Versioning

`Cargo.toml` is the single source of truth for the application version. `tauri.conf.json` omits the `version` field intentionally — Tauri reads it from `Cargo.toml` at build time, and the About panel reads it via `getVersion()` at runtime.

To bump the version, edit only `src-tauri/Cargo.toml`:

```toml
version = "1.1.0"
```

### Release

Pushing a version tag triggers the CI pipeline which builds for all supported platforms:

```bash
git tag v1.0.3
git push origin v1.0.3
```

| Platform | Runner | Artifacts |
|----------|--------|-----------|
| macOS ARM64 | `macos-latest` | `.dmg` |
| Windows x64 | `windows-latest` | `.exe` (NSIS) |
| Linux x64 | `ubuntu-latest` | `.AppImage` + `.deb` |
| Linux ARM64 | `ubuntu-24.04-arm` | `.AppImage` + `.deb` |

The workflow creates a draft release with all artifacts and a `latest.json` manifest for in-app auto-updates.


## Acknowledgements

- [Motrix](https://github.com/agalwood/Motrix) by [agalwood](https://github.com/agalwood) and all its contributors
- [Aria2](https://aria2.github.io/) — the powerful download engine at the core

## Contributing

PRs and issues are welcome! Please read the [Contributing Guide](docs/CONTRIBUTING.md) and [Code of Conduct](docs/CODE_OF_CONDUCT.md) before getting started.

## License

[MIT](https://opensource.org/licenses/MIT) — Copyright (c) 2025-present AnInsomniacy
