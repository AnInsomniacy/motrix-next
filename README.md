<div align="center">
  <h1>Motrix Next</h1>
  <p>A full-featured download manager — rebuilt from the ground up.</p>

  ![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)
  ![License](https://img.shields.io/badge/license-MIT-blue.svg)
</div>

---

## Background

Motrix Next is a **complete architectural rewrite** of [Motrix](https://github.com/agalwood/Motrix), the popular open-source download manager. While the original project and its community forks (including [MotrixMax](https://github.com/AnInsomniacy/MotrixMax)) provided a solid foundation and many valuable ideas, they were built on an aging Electron + Vue 2 stack that had become increasingly difficult to maintain and extend.

Rather than continuing to patch the legacy codebase, Motrix Next starts fresh with a modern technology stack while preserving the core download experience that made Motrix great. The entire frontend, backend integration layer, and build pipeline have been rewritten. **Version numbering has been reset** to reflect this clean break.

### What Changed

| Aspect | Legacy (Motrix / MotrixMax) | Motrix Next |
|--------|----------------------------|-------------|
| Runtime | Electron | **Tauri 2** |
| Frontend | Vue 2 + Vuex + Element UI | **Vue 3 + Pinia + Naive UI** |
| Language | JavaScript | **TypeScript** |
| Styling | SCSS + Element theme | **Vanilla CSS + CSS Variables** |
| Build | electron-builder | **Cargo + Vite** |
| Bundle Size | ~180 MB | **~15 MB** |
| Memory | ~200 MB idle | **~40 MB idle** |
| Engine | Aria2 (via Node child_process) | **Aria2 (via Tauri sidecar)** |

### What Was Preserved

- Full aria2 RPC integration and protocol support (HTTP, FTP, BitTorrent, Magnet)
- Comprehensive i18n system with 25+ languages
- User-Agent spoofing, tracker management, and advanced download configuration
- The overall UX flow and design philosophy

## Features

- **Multi-protocol downloads** — HTTP, FTP, BitTorrent, Magnet links
- **BitTorrent** — Selective file download, DHT, peer exchange, encryption
- **Tracker management** — Auto-sync from community tracker lists
- **Concurrent downloads** — Up to 10 tasks with configurable thread count
- **Speed control** — Global and per-task upload/download limits
- **System tray** — Real-time speed display in the menu bar (macOS)
- **Dark mode** — Native dark theme as default
- **Task management** — Pause, resume, delete with file cleanup, batch operations
- **Download protocols** — Register as default handler for magnet and thunder links
- **Notifications** — System notifications on task completion
- **Lightweight** — Tauri-based, minimal resource footprint

## Installation

> [!NOTE]
> Motrix Next currently targets **macOS** (Apple Silicon & Intel). Windows and Linux support is planned.

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

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Tauri 2](https://v2.tauri.app/) |
| Frontend | [Vue 3](https://vuejs.org/) (Composition API) |
| State | [Pinia](https://pinia.vuejs.org/) |
| UI | [Naive UI](https://www.naiveui.com/) |
| Language | TypeScript + Rust |
| Build | Vite + Cargo |
| Engine | [Aria2](https://aria2.github.io/) |

## Acknowledgements

Motrix Next would not exist without the work of the original Motrix community:

- [Motrix](https://github.com/agalwood/Motrix) by agalwood — the original project that inspired it all. Grateful to the creators for building such a solid foundation.
- [Aria2](https://aria2.github.io/) — the powerful download engine at the core

Significant portions of the i18n translations, aria2 RPC integration patterns, and download management logic were referenced from the legacy codebase and adapted for the new architecture.

## License

[MIT](https://opensource.org/licenses/MIT) — Copyright (c) 2025-present AnInsomniacy
