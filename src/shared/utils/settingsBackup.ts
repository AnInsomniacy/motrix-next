import { hydrateAppConfig } from '@shared/utils/configHydration'
import type { AppConfig } from '@shared/types'

export const SETTINGS_BACKUP_FORMAT = 'rayburst-settings'
export const SETTINGS_BACKUP_VERSION = 1

export interface SettingsBackupFile {
  format: typeof SETTINGS_BACKUP_FORMAT
  version: typeof SETTINGS_BACKUP_VERSION
  appVersion: string
  exportedAt: string
  settings: AppConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildSettingsBackup(config: AppConfig, appVersion: string): SettingsBackupFile {
  return {
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    settings: JSON.parse(JSON.stringify(config)) as AppConfig,
  }
}

export function parseSettingsBackup(content: string): AppConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Invalid settings backup file')
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid settings backup file')
  }
  if (parsed.format !== SETTINGS_BACKUP_FORMAT || parsed.version !== SETTINGS_BACKUP_VERSION) {
    throw new Error('Invalid settings backup file')
  }
  if (!isRecord(parsed.settings)) {
    throw new Error('Invalid settings backup file')
  }

  return hydrateAppConfig(parsed.settings as Partial<AppConfig>).config
}
