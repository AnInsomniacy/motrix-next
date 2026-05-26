import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Tauri Plugin Version Sync Tests
 *
 * Validates that every Tauri plugin's Rust crate version (from Cargo.lock)
 * and its corresponding NPM package version (from pnpm-lock.yaml) share the
 * same major.minor release.
 *
 * Tauri's CLI enforces this at `tauri build` time, but that command only runs
 * during release CI — not in the regular CI pipeline. This test catches
 * version drift early, before code reaches the release workflow.
 *
 * Root cause of drift: `cargo generate-lockfile` (or `cargo update`) can pull
 * Rust crates to newer minor versions while NPM packages stay pinned. The fix
 * in bump-version.sh prevents this, but this test acts as a safety net.
 */

const PROJECT_ROOT = process.cwd()
const CARGO_LOCK = resolve(PROJECT_ROOT, 'src-tauri', 'Cargo.lock')
const PNPM_LOCK = resolve(PROJECT_ROOT, 'pnpm-lock.yaml')

/**
 * Parse all `tauri-plugin-*` crate versions from Cargo.lock.
 *
 * Cargo.lock uses TOML with repeated `[[package]]` blocks:
 * ```
 * [[package]]
 * name = "tauri-plugin-dialog"
 * version = "2.7.0"
 * ```
 */
function parseCargoLockPlugins(content: string): Map<string, string> {
  const plugins = new Map<string, string>()
  const pattern = /name = "tauri-plugin-([^"]+)"\r?\nversion = "([^"]+)"/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    plugins.set(match[1], match[2])
  }

  return plugins
}

/**
 * Parse all `@tauri-apps/plugin-*` resolved versions from pnpm-lock.yaml.
 *
 * pnpm-lock.yaml lists resolved packages as:
 * ```
 * '@tauri-apps/plugin-dialog@2.7.0':
 * ```
 */
function parsePnpmLockPlugins(content: string): Map<string, string> {
  const plugins = new Map<string, string>()
  const pattern = /'@tauri-apps\/plugin-([^@]+)@(\d+\.\d+\.\d+)':/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    // Deduplicate — pnpm-lock may list the same package twice
    plugins.set(match[1], match[2])
  }

  return plugins
}

/** Extract major.minor from a semver string. */
function majorMinor(version: string): string {
  const parts = version.split('.')
  return `${parts[0]}.${parts[1]}`
}

describe('tauri plugin version sync', () => {
  const cargoLock = readFileSync(CARGO_LOCK, 'utf-8')
  const pnpmLock = readFileSync(PNPM_LOCK, 'utf-8')

  const rustPlugins = parseCargoLockPlugins(cargoLock)
  const npmPlugins = parsePnpmLockPlugins(pnpmLock)

  // Build the set of plugins that exist on BOTH sides
  const pairedPlugins = [...rustPlugins.keys()].filter((name) => npmPlugins.has(name)).sort()

  it('has at least one paired plugin to validate', () => {
    // Guard: if no plugins are found, the parsing logic is broken
    expect(pairedPlugins.length).toBeGreaterThan(0)
  })

  for (const name of pairedPlugins) {
    const rustVersion = rustPlugins.get(name)!
    const npmVersion = npmPlugins.get(name)!

    it(`tauri-plugin-${name} (${rustVersion}) matches @tauri-apps/plugin-${name} (${npmVersion})`, () => {
      expect(majorMinor(rustVersion)).toBe(majorMinor(npmVersion))
    })
  }

  it('reports Rust-only plugins for awareness (not a failure)', () => {
    const rustOnly = [...rustPlugins.keys()].filter((name) => !npmPlugins.has(name)).sort()

    // These are expected — some Tauri plugins have no frontend JS package.
    // This assertion simply documents them; it does not fail on their presence.
    // If a new plugin appears here unexpectedly, investigate whether it needs
    // an NPM counterpart in package.json.
    for (const name of rustOnly) {
      expect(rustPlugins.has(name)).toBe(true)
    }
  })
})
