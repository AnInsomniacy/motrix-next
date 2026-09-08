import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import { CONFIG_VERSION } from '@shared/utils/configMigration'
import {
  buildSettingsBackup,
  parseSettingsBackup,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
} from '@shared/utils/settingsBackup'
import { buildSystemConfigFromAppConfig } from '@shared/utils/systemConfig'
import type { AppConfig } from '@shared/types'

describe('settingsBackup', () => {
  it('round-trips settings through the backup envelope', () => {
    const config = {
      ...DEFAULT_APP_CONFIG,
      configVersion: CONFIG_VERSION,
      theme: 'dark',
      taskCardMode: 'compact',
      rpcSecret: 'rpc-secret',
      extensionApiSecret: 'api-secret',
    } as AppConfig

    const backup = buildSettingsBackup(config, '3.9.3')
    const parsed = parseSettingsBackup(JSON.stringify(backup))

    expect(backup.format).toBe(SETTINGS_BACKUP_FORMAT)
    expect(backup.version).toBe(SETTINGS_BACKUP_VERSION)
    expect(backup.appVersion).toBe('3.9.3')
    expect(parsed.theme).toBe('dark')
    expect(parsed.taskCardMode).toBe('compact')
    expect(parsed.rpcSecret).toBe('rpc-secret')
    expect(parsed.extensionApiSecret).toBe('api-secret')
  })

  it('hydrates imported settings and rejects invalid backup files', () => {
    const imported = parseSettingsBackup(
      JSON.stringify({
        format: SETTINGS_BACKUP_FORMAT,
        version: SETTINGS_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        settings: {
          configVersion: CONFIG_VERSION,
          theme: 'missing',
          taskCardMode: 'missing',
          rpcSecret: 'keep-rpc',
          extensionApiSecret: 'keep-api',
        },
      }),
    )

    expect(imported.theme).toBe(DEFAULT_APP_CONFIG.theme)
    expect(imported.taskCardMode).toBe(DEFAULT_APP_CONFIG.taskCardMode)
    expect(imported.rpcSecret).toBe('keep-rpc')
    expect(imported.extensionApiSecret).toBe('keep-api')
    expect(() => parseSettingsBackup('{"settings":{}}')).toThrow('Invalid settings backup file')
  })
})

describe('buildSystemConfigFromAppConfig', () => {
  it('builds engine settings from imported app settings', () => {
    const config = {
      ...DEFAULT_APP_CONFIG,
      dir: '/Downloads',
      maxConcurrentDownloads: 9,
      streamMaxConnections: 12,
      btMaxPeers: 88,
      rpcListenPort: 29199,
      rpcSecret: 'imported-rpc',
      extensionApiSecret: 'imported-api',
      btTracker: 'udp://tracker.example:6969/announce,'.repeat(4000).slice(0, -1),
    } as AppConfig

    const system = buildSystemConfigFromAppConfig(config, '/Fallback')

    expect(system.dir).toBe('/Downloads')
    expect(system['max-concurrent-downloads']).toBe('9')
    expect(system['stream-max-connections']).toBe('12')
    expect(system['bt-max-peers']).toBe('88')
    expect(system['rpc-listen-port']).toBe('29199')
    expect(system['rpc-secret']).toBe('imported-rpc')
    expect(system['bt-tracker']).toBe(config.btTracker)
    expect(system['bt-tracker'].length).toBeGreaterThan(100_000)
  })
})
