<!--
Before submitting, read docs/CONTRIBUTING.md — especially the Pull Request section.

Keep this template complete. PRs with deleted sections, vague answers, or unchecked required items may be closed without review.

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

<!-- Check what passed. Leave unchecked items explained below. -->

- [ ] Frontend checks passed: `pnpm format:check`, `npx vue-tsc --noEmit`, `pnpm test`
- [ ] Rust checks passed: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo check --workspace --all-targets`, `cargo test --workspace --all-targets`
- [ ] Manual testing completed, or not needed for this change

Unchecked checks:

<!-- Required for every unchecked item. Use "N/A: no frontend changes", "N/A: no Rust changes", or explain the failure. -->

## AI usage disclosure

<!-- Check the one that applies. Honest disclosure is expected — misleading answers will result in PR closure. -->

- [ ] No AI tools were used
- [ ] AI tools assisted with drafting, refactoring, or boilerplate (I reviewed and understand every line)
- [ ] Substantial portions were AI-generated (I reviewed, tested, and can explain every change)

AI model:

<!-- Required if AI was used. Use the exact model name, e.g. OpenAI GPT-5.5 or Claude Opus 4.8. Generic names like ChatGPT or Claude are not enough. -->

## Checklist

- [ ] I kept this PR template complete and understand incomplete PRs may be closed without review
- [ ] I have read [CONTRIBUTING.md](https://github.com/AnInsomniacy/motrix-next/blob/main/docs/CONTRIBUTING.md)
- [ ] This PR is focused, under the documented size limits, and uses Conventional Commits
- [ ] Tests were added or updated for risky logic changes, or this PR explains why tests are not needed

## Release notes

<!-- One-line description for end users, or "none" if not user-facing. -->

Notes:
