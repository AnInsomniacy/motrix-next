# Motrix Next Contributing Guide

Maintained by [@AnInsomniacy](https://github.com/AnInsomniacy). PRs and issues are welcome!

Before you start contributing, make sure you understand [GitHub flow](https://guides.github.com/introduction/flow/).

## 🛠 Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) 10.x, managed by the `packageManager` field in `package.json`

### Getting Started

```bash
git clone https://github.com/AnInsomniacy/motrix-next.git
cd motrix-next
pnpm install
pnpm tauri dev    # Start dev server (Tauri + Vite)
```

Rust backend (standalone):

```bash
pnpm build:native-launcher
cd src-tauri
cargo check --workspace --all-targets
cargo test --workspace --all-targets
```

## ✅ Code Quality

All checks must pass before PR merge:

```bash
pnpm lint                                      # ESLint
pnpm format:check                              # Prettier formatting
npx vue-tsc --noEmit                           # TypeScript strict mode
pnpm test                                      # Vitest
npx vite build                                 # Frontend production build
cd src-tauri && cargo fmt --all -- --check     # Rust formatting
cd src-tauri && cargo clippy --workspace --all-targets -- -D warnings
cd src-tauri && cargo check --workspace --all-targets
cd src-tauri && cargo test --workspace --all-targets
```

Pre-commit hooks (husky + lint-staged) auto-run `eslint --fix` and `prettier --write` on staged files.

## 📐 Component Guidelines

- **Keep `<script>` logic under 300 lines.** Extract composables when approaching this limit. Template and scoped CSS may exceed this — Naive UI components often require extensive style overrides.
- Use `<script setup lang="ts">` with composition API.
- Every file starts with a `/** @fileoverview ... */` doc comment.
- Use `logger` from `@shared/logger` for all runtime logging — **no bare `console.*`**.

## 🛡 Error Handling

- **TypeScript**: Never leave `catch` blocks empty — always call `logger.debug()` at minimum.
- **Rust**: Use the `AppError` enum (`Store`, `Engine`, `Io`, `NotFound`, `Updater`, `Upnp`, `Protocol`, `Aria2`, `Database`) for command return types.

## 🧪 Testing

- Add focused tests for new utilities, guards, business rules, and regression fixes.
- Test files live alongside source: `__tests__/filename.test.ts`.
- Runtime type guards (in `guards.ts`) validate all external API responses.

## 🌍 Translation Guide

First you need to determine the English abbreviation of a language as **locale**, such as `en-US`. This locale value should strictly refer to the [Chromium Source Code](https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc).

The internationalization of Motrix Next uses [vue-i18n](https://vue-i18n.intlify.dev/).

Desktop translations live in `src/shared/locales/<locale>/messages.json`. Each file contains the same nested namespaces, with `en-US` as the canonical schema and fallback. Locale metadata is registered once in `src/shared/locales/catalog.json`.

### Adding a New Language

1. Create `src/shared/locales/<locale>/messages.json` from the en-US resource
2. Translate every value without changing keys or placeholders
3. Register the locale in `src/shared/locales/catalog.json`
4. Add the native Rust resource at `src-tauri/locales/<locale>.json`
5. Run `pnpm lint`, `pnpm check:repo`, and `npx vue-tsc --noEmit`

## 💬 Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add torrent file selection
fix: handle empty bitfield in peer parser
refactor: extract TorrentUpload sub-component
test: add rename utility tests
docs: update CONTRIBUTING guidelines
```

## 🤝 Pull Requests

### Size and scope

Hard limits — PRs that exceed these will be closed without review:

- **< 300 lines** of changed code (excluding tests and auto-generated files like `Cargo.lock`).
- **< 10 files** touched. Docs-only or config-only PRs may exceed this.
- **One concern per PR.** A single PR should do exactly one thing.

How to split a large change:

| Instead of                                 | Split into                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| "Add error notification system" (1000 LOC) | PR 1: `errorNormalizer.ts` + tests → PR 2: `useAppNotification.ts` + tests → PR 3: integrate into components |
| "Add feature + fix lint + update config"   | PR 1: lint/config fixes → PR 2: the feature                                                                  |
| "Update i18n for 3 features"               | One PR per feature, each updating all 27 locales                                                             |

### Before you start

- **Bug fixes** — open an issue first to confirm the bug, then reference it in the PR.
- **New features** — open an issue and get maintainer approval before writing code. PRs for undiscussed features will be closed. This is standard practice across the Tauri ecosystem.
- **Refactors** — keep them purely behavioral-neutral. Don't sneak functional changes into a refactor PR.

### PR titles

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
feat(macos): add native traffic light toggle
fix: handle null errorCode in task notification
refactor: extract tracker sync into composable
docs: update i18n translation guide
```

### Before you push

Run the full check suite locally. PRs that fail any of these will not be reviewed:

```bash
pnpm lint
pnpm format:check
npx vue-tsc --noEmit
pnpm test
npx vite build
cd src-tauri && cargo fmt --all -- --check
cd src-tauri && cargo clippy --workspace --all-targets -- -D warnings
cd src-tauri && cargo check --workspace --all-targets
cd src-tauri && cargo test --workspace --all-targets
```

### i18n changes

If you add or modify i18n keys, **all 27 locales must be updated** using a batch Python script. Partial updates (e.g., only `en-US` and `zh-CN`) break the app for other languages and will not be accepted. See `AGENTS.md` Section D for the script template and the full list of locale directories.

### AI-assisted development

Using AI tools (Copilot, Claude, ChatGPT, Cursor, etc.) to assist development is welcome and encouraged. What is not acceptable is blind vibe coding — generating code with AI and submitting it without understanding or reviewing it.

**Rules:**

1. You must **review and understand every line** you submit, whether you wrote it or an AI did.
2. You must be able to **explain any change** if asked during review.
3. Tests are required for behavioral or risky logic changes. Pure copy, style, docs, and low-risk UI-only changes may skip tests, but the PR must explain why.
4. All local checks and required GitHub Actions must pass before review.

**Disclosure:**

The PR template includes an AI usage disclosure section. Fill it out honestly and include the exact model name when AI was used, such as `OpenAI GPT-5.5` or `Claude Opus 4.8`. Generic names such as `ChatGPT` or `Claude` are not enough. Following the [OpenInfra Foundation standard](https://openinfra.org), you may also add a commit trailer:

```
feat: add speed limit control

AI-Assisted-By: Claude
```

**What gets your PR closed immediately:**

- Commit history showing a "generate → push → fix → fix → fix" loop.
- Code that doesn't pass lint, type checks, or tests on first push.
- Misleading AI disclosure (claiming no AI was used when it was).

This policy follows practices adopted by [Mozilla.ai](https://mozilla.ai), [Drupal](https://drupal.org), and [Ghostty](https://github.com/ghostty-org/ghostty), among others.

## 📜 License

By contributing, you agree that your contributions will be licensed under the [MIT License](https://opensource.org/licenses/MIT).
