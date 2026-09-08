/** @fileoverview Pinia store for user preferences with persistence and directory history. */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isEmpty } from 'lodash-es'
import { load } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { getLangDirection, pushItemToFixedLengthArray, removeArrayItem } from '@shared/utils'
import { activeLocale } from '@shared/utils/i18n'
import { fetchBtTrackerFromSource } from '@shared/utils/tracker'
import { DEFAULT_APP_CONFIG, MAX_NUM_OF_DIRECTORIES } from '@shared/constants'
import { logger } from '@shared/logger'
import { type MigrationResult } from '@shared/utils/configMigration'
import { createDefaultAppConfig, hydrateAppConfig } from '@shared/utils/configHydration'
import { recordRecentUserAgentProfileId } from '@shared/utils/userAgentPolicy'
import { validateAppConfigCandidate } from '@shared/configConstraints'
import type { AppConfig } from '@shared/types'

const STORE_KEY = 'preferences'

export const usePreferenceStore = defineStore('preference', () => {
  const engineMode = ref('MAX')
  const pendingChanges = ref(false)
  /** Callback registered by the active preference page to save before navigation. */
  const saveBeforeLeave = ref<(() => Promise<void>) | null>(null)
  const config = ref<AppConfig>(createDefaultAppConfig())
  /** Result from the last migration run (null = no migration attempted yet). */
  const migrationResult = ref<MigrationResult | null>(null)
  /** Set when DB schema upgrade is detected during loadPreference.
   *  MainLayout watches this to show an info toast. Null = no upgrade detected. */
  const dbUpgradeVersion = ref<number | null>(null)

  // ── Deferred migration signals ──────────────────────────────────────
  // loadPreference() runs before setI18nLocale(), so setting these refs
  // immediately would trigger MainLayout watchers while the locale is
  // still 'en-US' — causing migration toasts to always display in English.
  // Solution: buffer the values and flush them after locale is ready.
  let pendingMigrationResult: MigrationResult | null = null
  let pendingDbUpgradeVersion: number | null = null

  const theme = computed(() => config.value.theme)
  const locale = computed(() => config.value.locale)

  /** The actual locale code in use — resolves 'auto' to the live vue-i18n locale. */
  const resolvedLocale = computed(() => {
    const l = config.value.locale
    if (!l || l === 'auto') {
      return activeLocale.value
    }
    return l
  })

  const direction = computed(() => getLangDirection(resolvedLocale.value))

  async function getStore() {
    return await load('config.json')
  }

  async function persistConfig(store: Awaited<ReturnType<typeof getStore>>, next: AppConfig): Promise<void> {
    await store.set(STORE_KEY, next)
    await store.save()
  }

  async function loadPreference() {
    try {
      const store = await getStore()
      const saved = await store.get<Partial<AppConfig>>(STORE_KEY)
      if (saved && !isEmpty(saved)) {
        // Backfill dbSchemaVersion for existing users upgrading to a version
        // that includes this field. saved being non-empty proves this is NOT
        // a fresh install — fresh installs have empty config.json and take
        // the DEFAULT_APP_CONFIG path (which already has the current DB version).
        if (saved.dbSchemaVersion === undefined) {
          saved.dbSchemaVersion = 1
        }
        // Always signal the saved version so the MainLayout watch can
        // compare it against the live DB version. Fresh installs never
        // reach here (saved is null), so no false toast.
        pendingDbUpgradeVersion = saved.dbSchemaVersion

        const hydrated = hydrateAppConfig(saved)
        config.value = hydrated.config
        if (hydrated.migration.migrated) {
          pendingMigrationResult = hydrated.migration
        }
        if (hydrated.shouldPersist) {
          await persistConfig(store, config.value)
          logger.info(
            'PreferenceStore',
            `config hydrated and persisted migration=${hydrated.migration.migrated} repairCount=${hydrated.repairs.length}`,
          )
        }
        invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      } else {
        config.value = createDefaultAppConfig()
        await persistConfig(store, config.value)
        invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      }
    } catch (e) {
      logger.error('PreferenceStore.loadPreference', e)
    }
  }

  async function reloadPreferenceFromDisk(): Promise<boolean> {
    try {
      const store = await getStore()
      const saved = await store.get<Partial<AppConfig>>(STORE_KEY)
      if (!saved || isEmpty(saved)) return false
      const hydrated = hydrateAppConfig(saved)
      config.value = hydrated.config
      if (hydrated.shouldPersist) {
        await persistConfig(store, config.value)
        logger.info(
          'PreferenceStore',
          `config reloaded and repaired repairCount=${hydrated.repairs.length} migration=${hydrated.migration.migrated}`,
        )
      }
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.reloadPreferenceFromDisk', e)
      return false
    }
  }

  async function savePreference(): Promise<boolean> {
    try {
      const issues = validateAppConfigCandidate(config.value)
      if (issues.length > 0) {
        logger.warn(
          'PreferenceStore.savePreference',
          `invalid config paths=${issues.map((issue) => issue.path).join(',')}`,
        )
        return false
      }
      const store = await getStore()
      const hydrated = hydrateAppConfig(config.value)
      config.value = hydrated.config
      await persistConfig(store, config.value)
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.savePreference', e)
      return false
    }
  }

  async function updateAndSave(cfg: Partial<AppConfig>): Promise<boolean> {
    const candidate = { ...config.value, ...cfg }
    const issues = validateAppConfigCandidate(candidate)
    if (issues.length > 0) {
      logger.warn(
        'PreferenceStore.updateAndSave',
        `invalid config paths=${issues.map((issue) => issue.path).join(',')}`,
      )
      return false
    }
    const merged = hydrateAppConfig(candidate).config
    try {
      const store = await getStore()
      await persistConfig(store, merged)
      config.value = merged
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.updateAndSave', e)
      return false
    }
  }

  async function replaceAndSave(nextConfig: Partial<AppConfig>): Promise<boolean> {
    try {
      const store = await getStore()
      const hydrated = hydrateAppConfig(nextConfig)
      config.value = hydrated.config
      await persistConfig(store, config.value)
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.replaceAndSave', e)
      return false
    }
  }

  function updatePreference(cfg: Partial<AppConfig>) {
    config.value = hydrateAppConfig({ ...config.value, ...cfg }).config
  }

  function recordHistoryDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    const all = new Set([...historyDirectories, ...favoriteDirectories])
    if (all.has(directory)) return
    addHistoryDirectory(directory)
  }

  function addHistoryDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    config.value = { ...config.value, historyDirectories: history }
    void savePreference()
  }

  function favoriteDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    if (favoriteDirectories.includes(directory) || favoriteDirectories.length >= MAX_NUM_OF_DIRECTORIES) return
    const favorite = pushItemToFixedLengthArray(favoriteDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    const history = removeArrayItem(historyDirectories, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    void savePreference()
  }

  function cancelFavoriteDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    if (historyDirectories.includes(directory)) return
    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    void savePreference()
  }

  function removeDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = removeArrayItem(historyDirectories, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    void savePreference()
  }

  function recordRecentUserAgentProfile(profileId: string) {
    config.value = {
      ...config.value,
      recentUserAgentProfileIds: recordRecentUserAgentProfileId(
        config.value.recentUserAgentProfileIds,
        profileId,
        config.value.userAgentProfiles,
      ),
    }
    void savePreference()
  }

  function updateAppTheme(t: AppConfig['theme']) {
    updatePreference({ theme: t })
  }

  function updateAppLocale(l: string) {
    updatePreference({ locale: l })
  }

  /**
   * Resets all preferences to factory defaults and persists.
   * Preserves the current locale to avoid unexpected language switches.
   */
  async function resetToDefaults(): Promise<boolean> {
    const currentLocale = config.value.locale
    try {
      const store = await getStore()
      const defaults = {
        ...createDefaultAppConfig(),
        locale: currentLocale,
      }
      await store.set(STORE_KEY, defaults)
      await store.save()
      config.value = defaults
      invoke('refresh_runtime_config').catch((e: unknown) => logger.debug('PreferenceStore.refreshRuntimeConfig', e))
      return true
    } catch (e) {
      logger.error('PreferenceStore.resetToDefaults', e)
      return false
    }
  }

  async function fetchBtTracker(trackerSource: string[] = []) {
    const proxy = config.value.proxy || DEFAULT_APP_CONFIG.proxy
    return fetchBtTrackerFromSource(trackerSource, proxy)
  }

  /**
   * Emit deferred migration signals so MainLayout watchers fire
   * AFTER i18n locale is set. Call from main.ts after setI18nLocale().
   */
  function flushMigrationSignals() {
    if (pendingMigrationResult) {
      migrationResult.value = pendingMigrationResult
      pendingMigrationResult = null
    }
    if (pendingDbUpgradeVersion !== null) {
      dbUpgradeVersion.value = pendingDbUpgradeVersion
      pendingDbUpgradeVersion = null
    }
  }

  return {
    engineMode,
    pendingChanges,
    saveBeforeLeave,
    config,
    migrationResult,
    dbUpgradeVersion,
    theme,
    locale,
    resolvedLocale,
    direction,
    updatePreference,
    updateAndSave,
    replaceAndSave,
    loadPreference,
    reloadPreferenceFromDisk,
    savePreference,
    recordHistoryDirectory,
    addHistoryDirectory,
    favoriteDirectory,
    cancelFavoriteDirectory,
    removeDirectory,
    recordRecentUserAgentProfile,
    updateAppTheme,
    updateAppLocale,
    fetchBtTracker,
    resetToDefaults,
    flushMigrationSignals,
  }
})
