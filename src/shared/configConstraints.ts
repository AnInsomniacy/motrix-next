import type { AppConfig } from '@shared/types'

export interface NumericConstraint {
  min: number
  max: number
  integer?: boolean
}

export interface ConfigValidationIssue {
  path: string
  constraint: NumericConstraint
}

/**
 * Runtime contract for every user-editable numeric preference.
 *
 * Engine limits mirror the bundled Aria2 Next option handlers. Product limits
 * are intentionally conservative where the engine itself is effectively
 * unbounded, preventing settings that would exhaust desktop resources.
 */
export const NUMERIC_CONFIG_CONSTRAINTS = {
  autoCheckUpdateInterval: { min: 0, max: 8760, integer: true },
  speedScheduleDays: { min: 0, max: 96, integer: true },
  taskPageSize: { min: 1, max: 100, integer: true },
  maxConcurrentDownloads: { min: 1, max: 100, integer: true },
  streamMaxConnections: { min: 1, max: 256, integer: true },
  maxTries: { min: 0, max: 60, integer: true },
  retryWait: { min: 0, max: 600, integer: true },
  connectTimeout: { min: 1, max: 600, integer: true },
  timeout: { min: 1, max: 600, integer: true },
  rpcListenPort: { min: 1024, max: 65535, integer: true },
  extensionApiPort: { min: 1024, max: 65535, integer: true },
  listenPort: { min: 1024, max: 65535, integer: true },
  btExternalPort: { min: 0, max: 65535, integer: true },
  btMaxPeers: { min: 0, max: 500, integer: true },
  btMaxConnections: { min: 2, max: 10000, integer: true },
  btMaxUploads: { min: 1, max: 1000, integer: true },
  btMaxUploadsPerTorrent: { min: 1, max: 1000, integer: true },
  shareRatio: { min: 1, max: 100 },
  shareTime: { min: 60, max: 525600, integer: true },
  btTrackerSyncIntervalHours: { min: 0, max: 168, integer: true },
  btPeerBlocklistSyncIntervalHours: { min: 0, max: 168, integer: true },
  ed2kListenPort: { min: 0, max: 65535, integer: true },
  ed2kUdpListenPort: { min: 0, max: 65535, integer: true },
  ed2kUploadSlots: { min: 1, max: 100, integer: true },
  ed2kMaxConnections: { min: 1, max: 1024, integer: true },
  ed2kSearchTimeout: { min: 10, max: 600, integer: true },
  ed2kBootstrapSyncIntervalHours: { min: 0, max: 168, integer: true },
  completedRecordRetentionDays: { min: 0, max: 3650, integer: true },
} as const satisfies Partial<Record<keyof AppConfig, NumericConstraint>>

export type NumericConfigKey = keyof typeof NUMERIC_CONFIG_CONSTRAINTS

export const PORT_RECOVERY_CONSTRAINT = { min: 1024, max: 65535, integer: true } as const

export const NUMERIC_CONFIG_ENUM_VALUES = {
  autoCheckUpdateInterval: [0, 24, 168, 720, 4320, 8760],
  speedScheduleDays: [0, 31, 96],
  btTrackerSyncIntervalHours: [0, 6, 12, 24, 168],
  btPeerBlocklistSyncIntervalHours: [0, 6, 12, 24, 168],
  ed2kBootstrapSyncIntervalHours: [0, 6, 12, 24, 168],
} as const satisfies Partial<Record<keyof AppConfig, readonly number[]>>

export function isNumericValueValid(value: unknown, constraint: NumericConstraint): value is number {
  const numericValue = Number(value)
  return (
    Number.isFinite(numericValue) &&
    (!constraint.integer || Number.isInteger(numericValue)) &&
    numericValue >= constraint.min &&
    numericValue <= constraint.max
  )
}

export function isConfigNumericValueValid(key: NumericConfigKey, value: unknown): boolean {
  return isNumericValueValid(value, NUMERIC_CONFIG_CONSTRAINTS[key])
}

export function getInvalidNumericConfigKeys(config: Partial<AppConfig>): NumericConfigKey[] {
  return (Object.keys(NUMERIC_CONFIG_CONSTRAINTS) as NumericConfigKey[]).filter(
    (key) => config[key] !== undefined && !isConfigNumericValueValid(key, config[key]),
  )
}

export function validateAppConfigCandidate(config: Partial<AppConfig>): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = getInvalidNumericConfigKeys(config).map((path) => ({
    path,
    constraint: NUMERIC_CONFIG_CONSTRAINTS[path],
  }))

  for (const [path, allowed] of Object.entries(NUMERIC_CONFIG_ENUM_VALUES)) {
    const value = config[path as keyof AppConfig]
    if (value !== undefined && !allowed.includes(Number(value) as never)) {
      issues.push({
        path,
        constraint: { min: Math.min(...allowed), max: Math.max(...allowed), integer: true },
      })
    }
  }

  const recovery = config.portConflictRecovery
  if (recovery) {
    if (!isNumericValueValid(recovery.rangeStart, PORT_RECOVERY_CONSTRAINT)) {
      issues.push({ path: 'portConflictRecovery.rangeStart', constraint: PORT_RECOVERY_CONSTRAINT })
    }
    if (!isNumericValueValid(recovery.rangeEnd, PORT_RECOVERY_CONSTRAINT)) {
      issues.push({ path: 'portConflictRecovery.rangeEnd', constraint: PORT_RECOVERY_CONSTRAINT })
    }
    if (recovery.rangeStart > recovery.rangeEnd) {
      issues.push({ path: 'portConflictRecovery.range', constraint: PORT_RECOVERY_CONSTRAINT })
    }
  }

  return issues
}
