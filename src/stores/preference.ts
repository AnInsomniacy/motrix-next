/** @fileoverview Pinia store for user preferences with persistence and directory history. */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isEmpty } from 'lodash-es'
import { load } from '@tauri-apps/plugin-store'
import { getLangDirection, pushItemToFixedLengthArray, removeArrayItem } from '@shared/utils'
import { fetchBtTrackerFromSource } from '@shared/utils/tracker'
import { DEFAULT_APP_CONFIG, MAX_NUM_OF_DIRECTORIES } from '@shared/constants'
import { logger } from '@shared/logger'
import type { AppConfig, CloseAction, ProxyConfig } from '@shared/types'

const STORE_KEY = 'preferences'

export const usePreferenceStore = defineStore('preference', () => {
  const engineMode = ref('MAX')
  const pendingChanges = ref(false)
  /** Callback registered by the active preference page to save before navigation. */
  const saveBeforeLeave = ref<(() => Promise<void>) | null>(null)
  const config = ref<AppConfig>({ ...DEFAULT_APP_CONFIG } as AppConfig)

  const theme = computed(() => config.value.theme)
  const locale = computed(() => config.value.locale)
  const direction = computed(() => getLangDirection(config.value.locale || 'en-US'))

  async function getStore() {
    return await load('config.json')
  }

  async function loadPreference() {
    try {
      const store = await getStore()
      const saved = await store.get<Partial<AppConfig>>(STORE_KEY)
      if (saved && !isEmpty(saved)) {
        // Migrate legacy minimizeToTrayOnClose → closeAction
        const raw = saved as Record<string, unknown>
        if (!raw.closeAction && 'minimizeToTrayOnClose' in raw) {
          const legacy = raw.minimizeToTrayOnClose as boolean
          raw.closeAction = (legacy ? 'minimize' : 'ask') as CloseAction
          delete raw.minimizeToTrayOnClose
          // Persist migration so Rust reads the new key
          await store.set(STORE_KEY, raw)
          await store.save()
        }
        config.value = { ...config.value, ...(raw as Partial<AppConfig>) }
      }
    } catch (e) {
      logger.error('PreferenceStore.loadPreference', e)
    }
  }

  async function savePreference(): Promise<boolean> {
    try {
      const store = await getStore()
      await store.set(STORE_KEY, config.value)
      await store.save()
      return true
    } catch (e) {
      logger.error('PreferenceStore.savePreference', e)
      return false
    }
  }

  async function updateAndSave(cfg: Partial<AppConfig>): Promise<boolean> {
    const merged = { ...config.value, ...cfg }
    try {
      const store = await getStore()
      await store.set(STORE_KEY, merged)
      await store.save()
      config.value = merged
      return true
    } catch (e) {
      logger.error('PreferenceStore.updateAndSave', e)
      return false
    }
  }

  function updatePreference(cfg: Partial<AppConfig>) {
    config.value = { ...config.value, ...cfg }
  }

  async function fetchPreference(api: { fetchPreference: () => Promise<Partial<AppConfig>> }) {
    const cfg = await api.fetchPreference()
    updatePreference(cfg)
    return cfg
  }

  async function save(
    cfg: Partial<AppConfig>,
    api: { savePreference: (c: Partial<AppConfig>) => Promise<void> },
    saveSession: () => void,
  ) {
    saveSession()
    if (isEmpty(cfg)) return
    updatePreference(cfg)
    return api.savePreference(cfg)
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
  }

  function favoriteDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    if (favoriteDirectories.includes(directory) || favoriteDirectories.length >= MAX_NUM_OF_DIRECTORIES) return
    const favorite = pushItemToFixedLengthArray(favoriteDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    const history = removeArrayItem(historyDirectories, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
  }

  function cancelFavoriteDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    if (historyDirectories.includes(directory)) return
    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
  }

  function removeDirectory(directory: string) {
    const historyDirectories = config.value.historyDirectories || []
    const favoriteDirectories = config.value.favoriteDirectories || []
    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = removeArrayItem(historyDirectories, directory)
    config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
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
      const { generateSecret } = await import('@/composables/useAdvancedPreference')
      const store = await getStore()
      const defaults = {
        ...DEFAULT_APP_CONFIG,
        locale: currentLocale,
        rpcSecret: generateSecret(),
      } as AppConfig
      await store.set(STORE_KEY, defaults)
      await store.save()
      config.value = defaults
      return true
    } catch (e) {
      logger.error('PreferenceStore.resetToDefaults', e)
      return false
    }
  }

  async function fetchBtTracker(trackerSource: string[] = []) {
    const proxy = config.value.proxy || ({ enable: false } as ProxyConfig)
    return fetchBtTrackerFromSource(trackerSource, proxy)
  }

  return {
    engineMode,
    pendingChanges,
    saveBeforeLeave,
    config,
    theme,
    locale,
    direction,
    updatePreference,
    updateAndSave,
    loadPreference,
    savePreference,
    fetchPreference,
    save,
    recordHistoryDirectory,
    addHistoryDirectory,
    favoriteDirectory,
    cancelFavoriteDirectory,
    removeDirectory,
    updateAppTheme,
    updateAppLocale,
    fetchBtTracker,
    resetToDefaults,
  }
})
