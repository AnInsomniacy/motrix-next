#!/usr/bin/env bash
# ==============================================================================
# bump-version.sh — Atomic version bump for Cargo.toml + package.json
#
# Usage:
#   ./scripts/bump-version.sh 1.4.0
#
# This ensures the two version sources stay in sync. Cargo.toml is the single
# source of truth for the Tauri build, but package.json must match for
# consistency with npm tooling and CI/CD (pnpm/action-setup reads it).
# ==============================================================================
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 1.4.0"
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_TOML="$PROJECT_ROOT/src-tauri/Cargo.toml"
PACKAGE_JSON="$PROJECT_ROOT/package.json"

# Validate version format (SemVer with optional pre-release)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format '$VERSION'"
  echo "Expected: MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease"
  exit 1
fi

# Update Cargo.toml (only the package version, not dependency versions)
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" "$CARGO_TOML"

# Update package.json
cd "$PROJECT_ROOT"
npm pkg set "version=$VERSION"

# Regenerate Cargo.lock
cd "$PROJECT_ROOT/src-tauri"
cargo generate-lockfile --quiet 2>/dev/null || true

echo "✓ Bumped version to $VERSION"
echo "  - $CARGO_TOML"
echo "  - $PACKAGE_JSON"
