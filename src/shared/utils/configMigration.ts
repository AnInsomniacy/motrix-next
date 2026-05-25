/**
 * @fileoverview Config schema migration engine.
 *
 * Tauri's plugin-store has no built-in migration API, so we implement
 * the industry-standard versioned-migration pattern (as used by
 * electron-store, VS Code, Obsidian, etc.):
 *
 *   1. Store a `configVersion` integer alongside user preferences.
 *   2. On each app launch, compare stored version against CONFIG_VERSION.
 *   3. Execute any pending migration functions in order.
 *   4. Stamp the new version and persist.
 *
 * Adding a new migration:
 *   1. Append a function to the `migrations` array.
 *   2. Increment CONFIG_VERSION to match the new array length.
 *   3. Add tests in configMigration.test.ts.
 */

import { PROXY_SCOPE_OPTIONS, buildDefaultCategories } from '@shared/constants'
import { logger } from '@shared/logger'
import type { AppConfig } from '@shared/types'

/** Current schema version. Must equal `migrations.length`. */
export const CONFIG_VERSION = 6

/** Result returned by runMigrations for callers to act on (e.g. toast). */
export interface MigrationResult {
  /** Whether any migration was applied. */
  migrated: boolean
  /** The CONFIG_VERSION the config was stamped to. */
  targetVersion: number
  /** Error messages from failed migrations (empty = all succeeded). */
  errors: string[]
}

type Migration = (config: Partial<AppConfig>) => void

/**
 * Ordered list of migration functions. Index 0 migrates v0 → v1, etc.
 *
 * Invariants:
 *   - Each migration mutates the config object in place.
 *   - Each migration MUST be idempotent — safe to re-run on
 *     already-migrated data (e.g. a non-empty scope is left untouched).
 *   - Migrations MUST NOT delete user data without logging.
 */
const migrations: Migration[] = [
  // ── v0 → v1 ──────────────────────────────────────────────────────
  // Backfill empty proxy.scope for users who configured proxy before
  // the scope feature was introduced (pre-#81). Without scope values,
  // buildAdvancedSystemConfig() emits all-proxy='' and aria2 receives
  // no proxy configuration, causing Bug #103.
  //
  // Empty scope is treated as "never explicitly configured" rather than
  // "user intentionally deselected all scopes", because the scope UI
  // did not exist when these users saved their proxy settings.
  function migrateV1(config: Partial<AppConfig>): void {
    const proxy = config.proxy
    if (!proxy || !Array.isArray(proxy.scope)) return
    if (proxy.scope.length === 0) {
      proxy.scope = [...PROXY_SCOPE_OPTIONS]
      logger.info('ConfigMigration', 'v1: backfilled empty proxy.scope with all scope options')
    }
  },

  // ── v1 → v2 ──────────────────────────────────────────────────────
  // Decouple split from maxConnectionPerServer.
  //
  // Before v2, transformDownloadsForStore() forced split = maxConnectionPerServer.
  // Both values are already persisted in config.json with the same number,
  // so no value migration is needed — we only remove the obsolete
  // engineMaxConnectionPerServer field that served as a sync anchor for
  // AddTask's maxSplit computation.
  //
  // After v2:
  //   - split controls aria2's --split (parallel segments per file)
  //   - maxConnectionPerServer controls aria2's --max-connection-per-server
  //   - Both are independently adjustable in Basic settings
  function migrateV2(config: Partial<AppConfig>): void {
    // Remove the obsolete sync anchor field
    delete (config as Record<string, unknown>).engineMaxConnectionPerServer
    logger.info(
      'ConfigMigration',
      'v2: removed engineMaxConnectionPerServer — split and maxConnectionPerServer are now independent',
    )
  },

  // ── v2 → v3 ──────────────────────────────────────────────────────
  // Flatten autoSubmitFromExtension from nested object to boolean.
  //
  // Before v3, autoSubmitFromExtension was an object with sub-toggles
  // per download type: { enable, http, magnet, torrent } legacy data.
  // The torrent sub-toggle was architecturally broken —
  // auto-submitting them called addUri() which downloaded the .torrent
  // file itself rather than its content.  The sub-toggles for HTTP and
  // magnet added unnecessary UX complexity without practical benefit.
  //
  // After v3, autoSubmitFromExtension is a simple boolean derived from
  // the old master switch (enable).  URI types (HTTP/FTP/magnet) are
  // auto-submitted when true; torrent always shows the dialog.
  function migrateV3(config: Partial<AppConfig>): void {
    const old = (config as Record<string, unknown>).autoSubmitFromExtension
    if (old && typeof old === 'object' && 'enable' in old) {
      config.autoSubmitFromExtension = (old as { enable: boolean }).enable
      logger.info(
        'ConfigMigration',
        `v3: flattened autoSubmitFromExtension object to boolean (${config.autoSubmitFromExtension})`,
      )
    }
  },

  // ── v3 → v4 ──────────────────────────────────────────────────────
  // Fix auto-archive regression on Windows (Issue #229 / #230).
  //
  // Two independent issues caused file classification to silently fail:
  //
  // 1. Path separator mismatch: On Windows, `config.dir` is stored with
  //    backslashes (`C:\Users\x\Downloads`) while buildDefaultCategories()
  //    joins with forward slashes, producing mixed paths like
  //    `C:\Users\x\Downloads/Archives`.  resolveArchiveAction() then
  //    compares these mixed-separator strings with strict equality and
  //    always fails.  Fix: normalize all persisted path values to `/`.
  //
  // 2. Empty categories array: Users who enabled `fileCategoryEnabled`
  //    without visiting the settings page have `fileCategories: []`,
  //    causing both pre-download classification and post-download
  //    archiving to silently skip.  Fix: populate defaults from `dir`.
  //
  // This migration is idempotent — forward-slash-only paths and
  // already-populated categories are left untouched.
  function migrateV4(config: Partial<AppConfig>): void {
    let changed = false

    // Normalize dir separator (Windows backslash → forward slash)
    if (config.dir && config.dir.includes('\\')) {
      config.dir = config.dir.replace(/\\/g, '/')
      changed = true
    }

    // Normalize category directory separators
    if (Array.isArray(config.fileCategories)) {
      for (const cat of config.fileCategories) {
        if (cat.directory && cat.directory.includes('\\')) {
          cat.directory = cat.directory.replace(/\\/g, '/')
          changed = true
        }
      }
    }

    // Auto-populate empty categories when classification is enabled
    if (
      config.fileCategoryEnabled === true &&
      (!Array.isArray(config.fileCategories) || config.fileCategories.length === 0)
    ) {
      const baseDir = config.dir || ''
      if (baseDir) {
        config.fileCategories = buildDefaultCategories(baseDir)
        changed = true
        logger.info('ConfigMigration', `v4: populated default file categories (baseDir=${baseDir})`)
      }
    }

    if (changed) {
      logger.info('ConfigMigration', 'v4: normalized path separators and/or populated file categories')
    }
  },

  // ── v4 → v5 ──────────────────────────────────────────────────────
  // Add ED2K as a first-class URI protocol surface.
  //
  // Existing users already have nested protocols/clipboard objects persisted,
  // so default merging alone cannot add the new nested keys reliably.
  function migrateV5(config: Partial<AppConfig>): void {
    if (config.protocols && config.protocols.ed2k === undefined) {
      config.protocols.ed2k = true
      logger.info('ConfigMigration', 'v5: backfilled protocols.ed2k')
    }
    if (config.clipboard && config.clipboard.ed2k === undefined) {
      config.clipboard.ed2k = true
      logger.info('ConfigMigration', 'v5: backfilled clipboard.ed2k')
    }
  },

  // ── v5 → v6 ──────────────────────────────────────────────────────
  // Add proxy.matchMode field for whitelist/blacklist support.
  //
  // Existing users with proxy configured will have matchMode undefined.
  // Default value is 'blacklist' (preserving existing behavior).
  function migrateV6(config: Partial<AppConfig>): void {
    const proxy = config.proxy
    if (proxy && proxy.matchMode === undefined) {
      proxy.matchMode = 'blacklist'
      logger.info('ConfigMigration', 'v6: backfilled proxy.matchMode to blacklist')
    }
  },
]

// ── Consistency guard ───────────────────────────────────────────────
// Fail fast at import time if a developer adds a migration but forgets
// to bump CONFIG_VERSION (or vice versa). This is caught by both
// vitest and vite dev/build — never reaches production silently.
if (CONFIG_VERSION !== migrations.length) {
  throw new Error(
    `CONFIG_VERSION (${CONFIG_VERSION}) must equal migrations.length (${migrations.length}). ` +
      'Did you forget to bump CONFIG_VERSION after adding a migration?',
  )
}

/**
 * Executes all pending migrations on the given config object.
 *
 * Each migration is wrapped in a try-catch so that a failure in one
 * migration does not prevent subsequent migrations from executing.
 * The config is always stamped to CONFIG_VERSION after the loop,
 * ensuring partially-migrated configs are not re-processed.
 *
 * @param config - Mutable reference to the loaded user preferences.
 * @returns A MigrationResult describing what happened.
 */
export function runMigrations(config: Partial<AppConfig>): MigrationResult {
  const stored = (config.configVersion as number | undefined) ?? 0
  const noOp: MigrationResult = { migrated: false, targetVersion: CONFIG_VERSION, errors: [] }

  if (stored >= CONFIG_VERSION) return noOp

  const errors: string[] = []

  for (let i = stored; i < migrations.length; i++) {
    try {
      migrations[i](config)
    } catch (e) {
      // Log and continue — don't let one broken migration block the rest.
      // The config will still be stamped to CONFIG_VERSION to prevent
      // re-running the failed migration on every subsequent launch.
      const msg = `v${i + 1}: ${(e as Error).message}`
      logger.error('ConfigMigration', `migration failed — ${msg}`)
      errors.push(msg)
    }
  }

  config.configVersion = CONFIG_VERSION
  return { migrated: true, targetVersion: CONFIG_VERSION, errors }
}
