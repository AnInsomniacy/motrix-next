/** @fileoverview Tests for centralized AppConfig hydration. */
import { describe, expect, it } from 'vitest'
import {
  COLOR_SCHEMES,
  DEFAULT_APP_CONFIG,
  FILE_ALLOCATION_OPTIONS,
  APP_LOG_LEVELS,
  ARIA2_LOG_LEVELS,
  PROXY_SCOPE_OPTIONS,
  UPDATE_CHANNELS,
} from '@shared/constants'
import { CONFIG_VERSION } from '@shared/utils/configMigration'
import { hydrateAppConfig } from '@shared/utils/configHydration'
import type { AppConfig } from '@shared/types'

describe('hydrateAppConfig', () => {
  it('hydrates missing top-level fields from defaults', () => {
    const result = hydrateAppConfig({ theme: 'dark', locale: 'ja' })

    expect(result.config.theme).toBe('dark')
    expect(result.config.locale).toBe('ja')
    expect(result.config.colorScheme).toBe(DEFAULT_APP_CONFIG.colorScheme)
    expect(result.config.maxConcurrentDownloads).toBe(DEFAULT_APP_CONFIG.maxConcurrentDownloads)
    expect(result.config.useIndependentDownloadWindow).toBe(true)
  })

  it('deep-hydrates fixed nested objects without overwriting saved subfields', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      proxy: { mode: 'manual', server: 'http://127.0.0.1:7890' } as AppConfig['proxy'],
      clipboard: { http: false } as AppConfig['clipboard'],
      portConflictRecovery: { enabled: false, rangeStart: 29050 } as AppConfig['portConflictRecovery'],
    })

    expect(result.config.proxy).toEqual({
      ...DEFAULT_APP_CONFIG.proxy,
      mode: 'manual',
      server: 'http://127.0.0.1:7890',
    })
    expect(result.config.clipboard).toEqual({ ...DEFAULT_APP_CONFIG.clipboard, http: false })
    expect(result.config.portConflictRecovery).toEqual({
      ...DEFAULT_APP_CONFIG.portConflictRecovery,
      enabled: false,
      rangeStart: 29050,
    })
  })

  it('preserves user-owned arrays including intentionally empty arrays', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      trackerSource: [],
      customTrackerUrls: ['https://example.com/trackers.txt'],
      historyDirectories: [],
      favoriteDirectories: ['/downloads'],
      fileCategories: [],
    })

    expect(result.config.trackerSource).toEqual([])
    expect(result.config.customTrackerUrls).toEqual(['https://example.com/trackers.txt'])
    expect(result.config.historyDirectories).toEqual([])
    expect(result.config.favoriteDirectories).toEqual(['/downloads'])
    expect(result.config.fileCategories).toEqual([])
  })

  it('repairs user-agent profiles, rules, and recent profile ids', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      userAgentProfiles: [
        { id: 'quark', name: 'Quark Drive', value: 'QuarkUA/1.0', createdAt: 1, updatedAt: 1 },
        { id: 'quark', name: 'Duplicate', value: 'DuplicateUA/1.0', createdAt: 2, updatedAt: 2 },
        { id: 'empty', name: 'Empty', value: '', createdAt: 3, updatedAt: 3 },
      ],
      userAgentRules: [
        {
          id: 'quark-rule',
          enabled: true,
          hostPattern: '*.quark.cn',
          profileId: 'quark',
          overridePlugin: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'missing-profile',
          enabled: true,
          hostPattern: 'pan.baidu.com',
          profileId: 'missing',
          overridePlugin: true,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      recentUserAgentProfileIds: ['quark', 'missing', 'quark'],
    } as Partial<AppConfig>)

    expect(result.config.userAgentProfiles).toEqual([
      { id: 'quark', name: 'Quark Drive', value: 'QuarkUA/1.0', createdAt: 1, updatedAt: 1 },
    ])
    expect(result.config.userAgentRules).toEqual([
      {
        id: 'quark-rule',
        enabled: true,
        hostPattern: '*.quark.cn',
        profileId: 'quark',
        overridePlugin: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    expect(result.config.recentUserAgentProfileIds).toEqual(['quark'])
    expect(result.repairs).toEqual(
      expect.arrayContaining(['userAgentProfiles', 'userAgentRules', 'recentUserAgentProfileIds']),
    )
  })

  it('repairs invalid scalar enums and records repair names', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      theme: 'neon' as AppConfig['theme'],
      taskCardMode: 'tiny' as AppConfig['taskCardMode'],
      colorScheme: 'missing-scheme',
      updateChannel: 'nightly' as AppConfig['updateChannel'],
      logLevel: 'verbose' as AppConfig['logLevel'],
      aria2LogLevel: 'verbose' as AppConfig['aria2LogLevel'],
      fileAllocation: 'magic',
      fileDeletionMode: 'erase' as AppConfig['fileDeletionMode'],
    })

    expect(result.config.theme).toBe(DEFAULT_APP_CONFIG.theme)
    expect(result.config.taskCardMode).toBe(DEFAULT_APP_CONFIG.taskCardMode)
    expect(result.config.colorScheme).toBe(DEFAULT_APP_CONFIG.colorScheme)
    expect(result.config.updateChannel).toBe(DEFAULT_APP_CONFIG.updateChannel)
    expect(result.config.logLevel).toBe(DEFAULT_APP_CONFIG.logLevel)
    expect(result.config.aria2LogLevel).toBe(DEFAULT_APP_CONFIG.aria2LogLevel)
    expect(result.config.fileAllocation).toBe(DEFAULT_APP_CONFIG.fileAllocation)
    expect(result.config.fileDeletionMode).toBe(DEFAULT_APP_CONFIG.fileDeletionMode)
    expect(result.repairs).toEqual(
      expect.arrayContaining([
        'theme',
        'taskCardMode',
        'colorScheme',
        'updateChannel',
        'logLevel',
        'aria2LogLevel',
        'fileAllocation',
        'fileDeletionMode',
      ]),
    )
  })

  it('repairs invalid external BitTorrent endpoint values', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      btExternalIp: 'tracker.example.com',
      btExternalPort: 70000,
    })

    expect(result.config.btExternalIp).toBe(DEFAULT_APP_CONFIG.btExternalIp)
    expect(result.config.btExternalPort).toBe(DEFAULT_APP_CONFIG.btExternalPort)
    expect(result.repairs).toEqual(expect.arrayContaining(['btExternalIp', 'btExternalPort']))
  })

  it('repairs invalid nested values and keeps valid nested values', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      proxy: { ...DEFAULT_APP_CONFIG.proxy, mode: 'broken' as AppConfig['proxy']['mode'], scope: ['download', 'bad'] },
      portConflictRecovery: {
        ...DEFAULT_APP_CONFIG.portConflictRecovery,
        rangeStart: 70000,
        rangeEnd: 65000,
        bt: false,
      },
    })

    expect(result.config.proxy.mode).toBe('direct')
    expect(result.config.proxy.scope).toEqual(['download'])
    expect(result.config.portConflictRecovery.rangeStart).toBe(DEFAULT_APP_CONFIG.portConflictRecovery.rangeStart)
    expect(result.config.portConflictRecovery.rangeEnd).toBe(DEFAULT_APP_CONFIG.portConflictRecovery.rangeEnd)
    expect(result.config.portConflictRecovery.bt).toBe(false)
    expect(result.repairs).toEqual(expect.arrayContaining(['proxy.mode', 'portConflictRecovery.range']))
  })

  it('repairs invalid manual task order entries', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      taskManualOrder: {
        active: ['a', '', 'a', 1],
        stopped: 'bad',
        all: ['z'],
      } as never,
    })

    expect(result.config.taskManualOrder).toEqual({
      active: ['a'],
      stopped: [],
      all: ['z'],
    })
    expect(result.repairs).toEqual(expect.arrayContaining(['taskManualOrder.active', 'taskManualOrder.stopped']))
  })

  it('repairs legacy auto proxy mode to disabled direct mode', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      proxy: { ...DEFAULT_APP_CONFIG.proxy, mode: 'auto' as never, server: 'http://127.0.0.1:7890' },
    })

    expect(result.config.proxy.mode).toBe('direct')
    expect(result.repairs).toContain('proxy.mode')
  })

  it('drops removed tracker auto-sync config without migration', () => {
    const result = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      autoSyncTracker: true,
    } as Partial<AppConfig> & { autoSyncTracker: boolean })

    expect(result.config).not.toHaveProperty('autoSyncTracker')
    expect(result.config.btTrackerAutoSync).toBe(DEFAULT_APP_CONFIG.btTrackerAutoSync)
  })

  it('generates required secrets for old configs that do not have them', () => {
    const missing = hydrateAppConfig({ configVersion: CONFIG_VERSION })
    const cleared = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      rpcSecret: '',
      extensionApiSecret: '',
    })

    expect(missing.config.rpcSecret).toHaveLength(16)
    expect(missing.config.extensionApiSecret).toHaveLength(16)
    expect(missing.config.rpcSecret).not.toBe(missing.config.extensionApiSecret)
    expect(missing.repairs).toEqual(expect.arrayContaining(['rpcSecret', 'extensionApiSecret']))
    expect(missing.shouldPersist).toBe(true)
    expect(cleared.config.rpcSecret).toBe('')
    expect(cleared.config.extensionApiSecret).toBe('')
  })

  it('returns migration and persistence signals', () => {
    const migrated = hydrateAppConfig({ proxy: { ...DEFAULT_APP_CONFIG.proxy, scope: [] } })
    const current = hydrateAppConfig({
      configVersion: CONFIG_VERSION,
      theme: 'light',
      rpcSecret: 'rpc-secret',
      extensionApiSecret: 'api-secret',
    })

    expect(migrated.migration.migrated).toBe(true)
    expect(migrated.config.configVersion).toBe(CONFIG_VERSION)
    expect(migrated.shouldPersist).toBe(true)
    expect(current.migration.migrated).toBe(false)
    expect(current.shouldPersist).toBe(false)
  })

  it('does not downgrade configs from a future schema version', () => {
    const future = CONFIG_VERSION + 10
    const result = hydrateAppConfig({ configVersion: future, theme: 'light' })

    expect(result.config.configVersion).toBe(future)
    expect(result.migration.migrated).toBe(false)
  })

  it('keeps defaults aligned with allowed enum sets', () => {
    expect(['auto', 'light', 'dark']).toContain(DEFAULT_APP_CONFIG.theme)
    expect(['full', 'compact']).toContain(DEFAULT_APP_CONFIG.taskCardMode)
    expect(COLOR_SCHEMES.some((scheme) => scheme.id === DEFAULT_APP_CONFIG.colorScheme)).toBe(true)
    expect(UPDATE_CHANNELS).toContain(DEFAULT_APP_CONFIG.updateChannel)
    expect(APP_LOG_LEVELS).toContain(DEFAULT_APP_CONFIG.logLevel)
    expect(ARIA2_LOG_LEVELS).toContain(DEFAULT_APP_CONFIG.aria2LogLevel)
    expect(DEFAULT_APP_CONFIG.logLevel).toBe('warn')
    expect(DEFAULT_APP_CONFIG.aria2LogLevel).toBe('warn')
    expect(FILE_ALLOCATION_OPTIONS).toContain(DEFAULT_APP_CONFIG.fileAllocation)
    expect(DEFAULT_APP_CONFIG.proxy.scope).toEqual(PROXY_SCOPE_OPTIONS)
  })
})
