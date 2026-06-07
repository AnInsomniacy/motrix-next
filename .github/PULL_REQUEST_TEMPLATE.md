<!--
Before submitting, read docs/CONTRIBUTING.md — especially the Pull Request section.

PR title MUST follow Conventional Commits format.

  Good titles:
    fix(macos): resolve tray icon blurriness on Retina displays
    feat: add per-task speed limit control
    docs: update i18n translation guide
    refactor: extract tracker sync into composable

  Bad titles:
    fix bugs
    update code
    fix #123
    WIP
-->

## Description

<!-- What does this change do and why? Link related issues: Fixes #123 -->

## Type of change

<!-- Check the one that applies. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (**must** be discussed and approved in an issue first)
- [ ] Refactor (no functional change)
- [ ] Documentation / i18n
- [ ] CI / build configuration

## How has this been tested?

<!-- Describe how you verified your changes. "It compiles" is not sufficient. -->

## AI usage disclosure

<!-- Check the one that applies. Honest disclosure is expected — misleading answers will result in PR closure. -->

- [ ] No AI tools were used
- [ ] AI tools assisted with drafting, refactoring, or boilerplate (I reviewed and understand every line)
- [ ] Substantial portions were AI-generated (I reviewed, tested, and can explain every change)

If AI was used, specify the tool: <!-- e.g., GitHub Copilot, Claude, ChatGPT -->

## Checklist

### Required — PR will not be reviewed without these

- [ ] I have read [CONTRIBUTING.md](https://github.com/AnInsomniacy/motrix-next/blob/main/docs/CONTRIBUTING.md)
- [ ] PR changes **fewer than 300 lines** of code (excluding tests and generated files)
- [ ] PR touches **fewer than 10 files**
- [ ] PR addresses **one concern only** — no mixed features, config tweaks, or unrelated fixes
- [ ] All commands pass locally:
  ```
  pnpm format:check
  npx vue-tsc --noEmit
  pnpm test
  cd src-tauri && cargo test
  ```
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) format

### If applicable

- [ ] New feature was discussed and approved in an issue before implementation
- [ ] Tests written **before** implementation (TDD: red → green → refactor)
- [ ] i18n keys updated in **all 27 locales** via batch Python script (see AGENTS.md §D)
- [ ] New config key follows the full checklist in AGENTS.md §C
- [ ] Rust changes compile with `cargo clippy` (zero warnings)

## Release notes

<!-- One-line description for end users, or "none" if not user-facing. -->

Notes: 
