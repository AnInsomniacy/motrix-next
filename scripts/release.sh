#!/usr/bin/env bash
# ==============================================================================
# release.sh — Commit, tag, and push a release
#
# Usage:
#   ./scripts/release.sh
#
# Reads the version from Cargo.toml, formats code, stages all changes,
# commits, creates an annotated tag, and pushes everything to origin.
#
# Run this ONLY when all code changes are final and you are ready to publish.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_TOML="$PROJECT_ROOT/src-tauri/Cargo.toml"

# Read version from Cargo.toml
VERSION=$(grep '^version' "$CARGO_TOML" | head -1 | sed 's/version = "\(.*\)"/\1/')
TAG="v$VERSION"

if [ -z "$VERSION" ]; then
  echo "Error: Could not read version from $CARGO_TOML"
  exit 1
fi

# Check if tag already exists
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "Error: Tag $TAG already exists. Delete it first if re-releasing:"
  echo "  git tag -d $TAG && git push origin --delete $TAG"
  exit 1
fi

echo "Releasing $TAG..."

# Format code (best-effort auto-fix, then verify below)
cd "$PROJECT_ROOT"
pnpm format --log-level warn 2>/dev/null || true
(cd src-tauri && cargo fmt)

# ── Pre-release verification gate ────────────────────────────────
# Every check must pass before we commit, tag, or push.
# This mirrors the CI pipeline defined in .github/workflows/ci.yml.
echo "Running pre-release checks..."

pnpm lint || { echo "❌ ESLint check failed."; exit 1; }
pnpm format:check || { echo "❌ Format check failed. Run 'pnpm format' first."; exit 1; }
npx vue-tsc --noEmit || { echo "❌ TypeScript type check failed."; exit 1; }
pnpm test || { echo "❌ Frontend tests failed."; exit 1; }

(cd src-tauri && cargo fmt -- --check) || { echo "❌ Rust format check failed. Run 'cargo fmt'."; exit 1; }
(cd src-tauri && cargo clippy --all-targets -- -D warnings) || { echo "❌ Clippy lint failed."; exit 1; }
(cd src-tauri && cargo test --all-targets) || { echo "❌ Rust tests failed."; exit 1; }

echo "✓ All pre-release checks passed"

# Stage everything, commit, tag
git add -A

if git diff --cached --quiet; then
  echo "No changes to commit. Creating tag on current HEAD."
else
  git commit -m "release: $TAG"
fi

git tag -a "$TAG" -m "$TAG"

# Push commit and tag
git push && git push --tags

# Determine release channel
if [[ "$TAG" == *"-beta"* ]] || [[ "$TAG" == *"-rc"* ]] || [[ "$TAG" == *"-alpha"* ]]; then
  CHANNEL="\033[33mPRE-RELEASE\033[0m"  # Yellow
else
  CHANNEL="\033[32mSTABLE\033[0m"  # Green
fi

echo ""
echo -e "✓ Released $TAG  $CHANNEL"
echo "  → Commit and tag pushed to origin"
echo ""
echo "Next: Go to GitHub → Releases → Create new release"
echo "  Select tag: $TAG"
