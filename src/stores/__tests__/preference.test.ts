/** @fileoverview Unit tests for PreferenceStore with mocked Tauri store. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePreferenceStore } from '../preference'
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import type { AppConfig } from '@shared/types'

// Mock @tauri-apps/plugin-store — returns an in-memory store
const mockStoreData = new Map<string, unknown>()
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn((key: string) => Promise.resolve(mockStoreData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      mockStoreData.set(key, value)
      return Promise.resolve()
    }),
    save: vi.fn().mockResolvedValue(undefined),
  }),
}))

describe('PreferenceStore', () => {
  let store: ReturnType<typeof usePreferenceStore>

  beforeEach(() => {
    mockStoreData.clear()
    setActivePinia(createPinia())
    store = usePreferenceStore()
  })

  // ─── updatePreference / updateAndSave ───────────────────
  it('defaults the empty logo on and preserves an explicit opt-out after reload', async () => {
    expect(store.config.showLogoWhenEmpty).toBe(true)
    await store.updateAndSave({ showLogoWhenEmpty: false })
    setActivePinia(createPinia())
    const reloaded = usePreferenceStore()
    await reloaded.loadPreference()
    expect(reloaded.config.showLogoWhenEmpty).toBe(false)
  })

  it('updatePreference merges config without persisting', () => {
    store.updatePreference({ theme: 'light' })
    expect(store.config.theme).toBe('light')
  })

  it('updateAndSave merges config and persists', async () => {
    await store.updateAndSave({ locale: 'zh-CN' })
    expect(store.config.locale).toBe('zh-CN')
    // Store.set should have been called
    expect(mockStoreData.get('preferences')).toBeDefined()
  })

  it('replaceAndSave replaces config instead of merging with current state', async () => {
    await store.updateAndSave({ theme: 'dark', locale: 'zh-CN' })
    await store.replaceAndSave({
      theme: 'light',
      rpcSecret: 'replacement-rpc',
      extensionApiSecret: 'replacement-api',
    })

    const saved = mockStoreData.get('preferences') as AppConfig
    expect(store.config.theme).toBe('light')
    expect(store.config.locale).toBe(DEFAULT_APP_CONFIG.locale)
    expect(store.config.rpcSecret).toBe('replacement-rpc')
    expect(store.config.extensionApiSecret).toBe('replacement-api')
    expect(saved.locale).toBe(DEFAULT_APP_CONFIG.locale)
  })

  // ─── loadPreference ─────────────────────────────────────

  it('loadPreference merges saved config into state', async () => {
    mockStoreData.set('preferences', { theme: 'dark', locale: 'ja-JP' })
    await store.loadPreference()
    expect(store.config.theme).toBe('dark')
    expect(store.config.locale).toBe('ja-JP')
  })

  it('loadPreference keeps defaults when no saved data', async () => {
    await store.loadPreference()
    expect(store.config.theme).toBe('auto')
    expect(store.config.locale).toBe('auto')
  })

  it('loadPreference creates and persists secrets on first launch', async () => {
    await store.loadPreference()

    const saved = mockStoreData.get('preferences') as AppConfig
    expect(store.config.rpcSecret).toHaveLength(16)
    expect(store.config.extensionApiSecret).toHaveLength(16)
    expect(saved.rpcSecret).toBe(store.config.rpcSecret)
    expect(saved.extensionApiSecret).toBe(store.config.extensionApiSecret)
  })

  it('loadPreference hydrates missing nested config fields', async () => {
    mockStoreData.set('preferences', {
      clipboard: { enable: false },
      proxy: { mode: 'manual', server: 'http://127.0.0.1:7890' },
    })

    await store.loadPreference()

    expect(store.config.clipboard).toEqual({ ...DEFAULT_APP_CONFIG.clipboard, enable: false })
    expect(store.config.proxy).toEqual({
      ...DEFAULT_APP_CONFIG.proxy,
      mode: 'manual',
      server: 'http://127.0.0.1:7890',
    })
  })

  it('loadPreference persists repaired invalid config once', async () => {
    mockStoreData.set('preferences', {
      theme: 'bad-theme',
      updateChannel: 'nightly',
    })

    await store.loadPreference()

    const saved = mockStoreData.get('preferences') as AppConfig
    expect(store.config.theme).toBe(DEFAULT_APP_CONFIG.theme)
    expect(store.config.updateChannel).toBe(DEFAULT_APP_CONFIG.updateChannel)
    expect(saved.theme).toBe(DEFAULT_APP_CONFIG.theme)
    expect(saved.updateChannel).toBe(DEFAULT_APP_CONFIG.updateChannel)
  })

  // ─── computed: theme / locale / direction ───────────────

  it('theme computed reflects config.theme', () => {
    store.updatePreference({ theme: 'light' })
    expect(store.theme).toBe('light')
  })

  it('locale computed reflects config.locale', () => {
    store.updatePreference({ locale: 'ar' })
    expect(store.locale).toBe('ar')
  })

  it('direction computed returns rtl for Arabic', () => {
    store.updatePreference({ locale: 'ar' })
    expect(store.direction).toBe('rtl')
  })

  it('direction computed returns ltr for English', () => {
    store.updatePreference({ locale: 'en-US' })
    expect(store.direction).toBe('ltr')
  })

  // ─── updateAppTheme / updateAppLocale ───────────────────

  it('updateAppTheme updates theme in config', () => {
    store.updateAppTheme('light')
    expect(store.config.theme).toBe('light')
  })

  it('updateAppLocale updates locale in config', () => {
    store.updateAppLocale('zh-TW')
    expect(store.config.locale).toBe('zh-TW')
  })

  // ─── recordHistoryDirectory ─────────────────────────────

  it('recordHistoryDirectory adds new directory', () => {
    store.updatePreference({ historyDirectories: [], favoriteDirectories: [] })
    store.recordHistoryDirectory('/downloads')
    expect(store.config.historyDirectories).toContain('/downloads')
  })

  it('recordHistoryDirectory skips if already in history', () => {
    store.updatePreference({ historyDirectories: ['/downloads'], favoriteDirectories: [] })
    store.recordHistoryDirectory('/downloads')
    expect(store.config.historyDirectories).toEqual(['/downloads'])
  })

  it('recordHistoryDirectory skips if already in favorites', () => {
    store.updatePreference({ historyDirectories: [], favoriteDirectories: ['/downloads'] })
    store.recordHistoryDirectory('/downloads')
    expect(store.config.historyDirectories).toEqual([])
  })

  // ─── favoriteDirectory ──────────────────────────────────

  it('favoriteDirectory moves directory from history to favorites', () => {
    store.updatePreference({ historyDirectories: ['/old', '/new'], favoriteDirectories: [] })
    store.favoriteDirectory('/new')
    expect(store.config.favoriteDirectories).toContain('/new')
    expect(store.config.historyDirectories).not.toContain('/new')
  })

  it('favoriteDirectory skips if already in favorites', () => {
    store.updatePreference({ historyDirectories: [], favoriteDirectories: ['/fav'] })
    store.favoriteDirectory('/fav')
    // Should not double-add
    expect(store.config.favoriteDirectories).toEqual(['/fav'])
  })

  // ─── cancelFavoriteDirectory ────────────────────────────

  it('cancelFavoriteDirectory moves directory from favorites to history', () => {
    store.updatePreference({ historyDirectories: [], favoriteDirectories: ['/fav'] })
    store.cancelFavoriteDirectory('/fav')
    expect(store.config.favoriteDirectories).not.toContain('/fav')
    expect(store.config.historyDirectories).toContain('/fav')
  })

  it('cancelFavoriteDirectory skips if already in history', () => {
    store.updatePreference({ historyDirectories: ['/dir'], favoriteDirectories: ['/dir'] })
    store.cancelFavoriteDirectory('/dir')
    // Already in history, should not re-add
    expect(store.config.favoriteDirectories).toContain('/dir')
  })

  // ─── removeDirectory ────────────────────────────────────

  it('removeDirectory removes from both history and favorites', () => {
    store.updatePreference({ historyDirectories: ['/a', '/b'], favoriteDirectories: ['/a'] })
    store.removeDirectory('/a')
    expect(store.config.historyDirectories).not.toContain('/a')
    expect(store.config.favoriteDirectories).not.toContain('/a')
    expect(store.config.historyDirectories).toContain('/b')
  })

  // ── direction edge cases ──────────────────────────────────

  it('direction returns rtl for Farsi locale', () => {
    store.updatePreference({ locale: 'fa' })
    expect(store.direction).toBe('rtl')
  })
})
