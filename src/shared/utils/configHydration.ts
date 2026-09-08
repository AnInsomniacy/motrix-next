/** @fileoverview Centralized AppConfig hydration, migration, and repair. */
import {
  DEFAULT_APP_CONFIG,
  FILE_ALLOCATION_OPTIONS,
  APP_LOG_LEVELS,
  ARIA2_LOG_LEVELS,
  PROXY_SCOPE_OPTIONS,
  UPDATE_CHANNELS,
} from '@shared/constants'
import {
  NUMERIC_CONFIG_CONSTRAINTS,
  NUMERIC_CONFIG_ENUM_VALUES,
  PORT_RECOVERY_CONSTRAINT,
  type NumericConfigKey,
  isNumericValueValid,
} from '@shared/configConstraints'
import { getAllowedColorSchemeIds, normalizeCustomColorScheme } from '@shared/utils/colorSchemeConfig'
import { runMigrations, type MigrationResult } from '@shared/utils/configMigration'
import { normalizeProxyMode } from '@shared/utils/proxy'
import type { AppConfig, ClipboardConfig, PortConflictRecoveryConfig, ProxyConfig } from '@shared/types'
import { normalizeFileCategory } from '@shared/utils/fileCategory'
import { isValidOptionalIpAddress } from '@shared/utils/ipAddress'
import { isValidBtPeerIdPrefix, isValidBtUserAgent } from '@shared/utils/btIdentity'
import {
  normalizeRecentUserAgentProfileIds,
  normalizeUserAgentProfiles,
  normalizeUserAgentRules,
} from '@shared/utils/userAgentPolicy'
import {
  ALL_SORT_FIELDS,
  DEFAULT_TASK_MANUAL_ORDER,
  DEFAULT_TASK_SORT,
  PROGRESS_SORT_FIELDS,
  TERMINAL_SORT_FIELDS,
  type TaskManualOrderConfig,
  type TaskSortConfig,
} from '@/composables/useTaskSort'

export interface HydratedAppConfig {
  config: AppConfig
  migration: MigrationResult
  repairs: string[]
  shouldPersist: boolean
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function generateConfigSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(values, (value) => chars[value % chars.length]).join('')
}

export function createDefaultAppConfig(): AppConfig {
  const base = clonePlain(DEFAULT_APP_CONFIG)
  return {
    ...base,
    rpcSecret: generateConfigSecret(),
    extensionApiSecret: generateConfigSecret(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAllowed<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value)
}

function repairEnum<T extends readonly string[]>(
  config: Record<string, unknown>,
  key: keyof AppConfig & string,
  allowed: T,
  fallback: string,
  repairs: string[],
): void {
  if (isAllowed(config[key], allowed)) return
  config[key] = fallback
  repairs.push(key)
}

function normalizeHttpUrl(value: unknown, fallback: string, key: string, repairs: string[]): string {
  if (typeof value === 'string') {
    try {
      const url = new URL(value.trim())
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    } catch {
      // Repaired below.
    }
  }
  repairs.push(key)
  return fallback
}

function normalizeProxy(value: unknown, repairs: string[]): ProxyConfig {
  const defaults = clonePlain(DEFAULT_APP_CONFIG.proxy)
  const saved = isRecord(value) ? value : {}
  const merged = { ...defaults, ...saved } as ProxyConfig
  const mode = normalizeProxyMode(merged.mode)

  if (mode !== merged.mode) {
    repairs.push('proxy.mode')
  }

  const scope = Array.isArray(merged.scope) ? merged.scope.filter((item) => PROXY_SCOPE_OPTIONS.includes(item)) : []
  if (scope.length !== (Array.isArray(merged.scope) ? merged.scope.length : 0)) {
    repairs.push('proxy.scope')
  }

  return {
    ...merged,
    mode,
    server: typeof merged.server === 'string' ? merged.server : defaults.server,
    username: typeof merged.username === 'string' ? merged.username : defaults.username,
    password: typeof merged.password === 'string' ? merged.password : defaults.password,
    bypass: typeof merged.bypass === 'string' ? merged.bypass : defaults.bypass,
    scope: scope.length ? scope : [...PROXY_SCOPE_OPTIONS],
  }
}

function normalizeClipboard(value: unknown): ClipboardConfig {
  const defaults = DEFAULT_APP_CONFIG.clipboard
  const saved = isRecord(value) ? value : {}
  return {
    enable: typeof saved.enable === 'boolean' ? saved.enable : defaults.enable,
    http: typeof saved.http === 'boolean' ? saved.http : defaults.http,
    sftp: typeof saved.sftp === 'boolean' ? saved.sftp : defaults.sftp,
    magnet: typeof saved.magnet === 'boolean' ? saved.magnet : defaults.magnet,
    ed2k: typeof saved.ed2k === 'boolean' ? saved.ed2k : defaults.ed2k,
    thunder: typeof saved.thunder === 'boolean' ? saved.thunder : defaults.thunder,
    btHash: typeof saved.btHash === 'boolean' ? saved.btHash : defaults.btHash,
  }
}

function normalizePortRecovery(value: unknown, repairs: string[]): PortConflictRecoveryConfig {
  const defaults = DEFAULT_APP_CONFIG.portConflictRecovery
  const saved = isRecord(value) ? value : {}
  const endpointsAreValid =
    (saved.rangeStart === undefined || isNumericValueValid(saved.rangeStart, PORT_RECOVERY_CONSTRAINT)) &&
    (saved.rangeEnd === undefined || isNumericValueValid(saved.rangeEnd, PORT_RECOVERY_CONSTRAINT))
  const rangeStart = endpointsAreValid ? Number(saved.rangeStart ?? defaults.rangeStart) : defaults.rangeStart
  const rangeEnd = endpointsAreValid ? Number(saved.rangeEnd ?? defaults.rangeEnd) : defaults.rangeEnd
  const validRange = endpointsAreValid && rangeStart <= rangeEnd

  if (!validRange) {
    repairs.push('portConflictRecovery.range')
  }

  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    rangeStart: validRange ? rangeStart : defaults.rangeStart,
    rangeEnd: validRange ? rangeEnd : defaults.rangeEnd,
    rpc: typeof saved.rpc === 'boolean' ? saved.rpc : defaults.rpc,
    extensionApi: typeof saved.extensionApi === 'boolean' ? saved.extensionApi : defaults.extensionApi,
    bt: typeof saved.bt === 'boolean' ? saved.bt : defaults.bt,
    ed2k: typeof saved.ed2k === 'boolean' ? saved.ed2k : defaults.ed2k,
    ed2kUdp: typeof saved.ed2kUdp === 'boolean' ? saved.ed2kUdp : defaults.ed2kUdp,
  }
}

function normalizeTaskManualOrder(value: unknown, repairs: string[]): TaskManualOrderConfig {
  const saved = isRecord(value) ? value : {}
  const normalizeList = (key: keyof TaskManualOrderConfig): string[] => {
    const raw = saved[key]
    if (!Array.isArray(raw)) {
      repairs.push(`taskManualOrder.${key}`)
      return [...DEFAULT_TASK_MANUAL_ORDER[key]]
    }
    const result = raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
    if (result.length !== raw.length) repairs.push(`taskManualOrder.${key}`)
    return Array.from(new Set(result))
  }

  return {
    all: normalizeList('all'),
    progress: normalizeList('progress'),
    failed: normalizeList('failed'),
    completed: normalizeList('completed'),
  }
}

function normalizeTaskSort(value: unknown, repairs: string[]): TaskSortConfig {
  const saved = isRecord(value) ? value : {}
  const normalize = <K extends keyof TaskSortConfig>(
    key: K,
    fields: readonly TaskSortConfig[K]['field'][],
  ): TaskSortConfig[K] => {
    const entry = isRecord(saved[key]) ? saved[key] : {}
    const defaults = DEFAULT_TASK_SORT[key]
    const field = fields.includes(entry.field as TaskSortConfig[K]['field'])
      ? (entry.field as TaskSortConfig[K]['field'])
      : defaults.field
    const direction = entry.direction === 'asc' || entry.direction === 'desc' ? entry.direction : defaults.direction
    if (field !== entry.field || direction !== entry.direction) repairs.push(`taskSort.${key}`)
    return { field, direction } as TaskSortConfig[K]
  }

  return {
    all: normalize('all', ALL_SORT_FIELDS),
    progress: normalize('progress', PROGRESS_SORT_FIELDS),
    failed: normalize('failed', TERMINAL_SORT_FIELDS),
    completed: normalize('completed', TERMINAL_SORT_FIELDS),
  }
}

function normalizeScalarValues(config: Record<string, unknown>, repairs: string[]): void {
  for (const [key, fallback] of Object.entries(DEFAULT_APP_CONFIG)) {
    if (key === 'rpcSecret' || key === 'extensionApiSecret') continue
    if ((typeof fallback === 'boolean' || typeof fallback === 'string') && typeof config[key] !== typeof fallback) {
      config[key] = fallback
      repairs.push(key)
    }
  }
  repairEnum(config, 'theme', ['auto', 'light', 'dark'] as const, DEFAULT_APP_CONFIG.theme, repairs)
  repairEnum(config, 'taskCardMode', ['full', 'compact'] as const, DEFAULT_APP_CONFIG.taskCardMode, repairs)
  repairEnum(config, 'colorScheme', getAllowedColorSchemeIds(), DEFAULT_APP_CONFIG.colorScheme, repairs)
  const customColorScheme = normalizeCustomColorScheme(config.customColorScheme)
  if (config.customColorScheme !== customColorScheme) repairs.push('customColorScheme')
  config.customColorScheme = customColorScheme
  repairEnum(config, 'updateChannel', UPDATE_CHANNELS, DEFAULT_APP_CONFIG.updateChannel, repairs)
  repairEnum(config, 'logLevel', APP_LOG_LEVELS, DEFAULT_APP_CONFIG.logLevel, repairs)
  repairEnum(config, 'aria2LogLevel', ARIA2_LOG_LEVELS, DEFAULT_APP_CONFIG.aria2LogLevel, repairs)
  repairEnum(config, 'fileAllocation', FILE_ALLOCATION_OPTIONS, DEFAULT_APP_CONFIG.fileAllocation, repairs)
  repairEnum(config, 'fileDeletionMode', ['trash', 'permanent'] as const, DEFAULT_APP_CONFIG.fileDeletionMode, repairs)
  repairEnum(
    config,
    'btEncryption',
    ['preferred', 'required', 'disabled'] as const,
    DEFAULT_APP_CONFIG.btEncryption,
    repairs,
  )
  repairEnum(config, 'btTransport', ['tcp', 'utp', 'both'] as const, DEFAULT_APP_CONFIG.btTransport, repairs)
  if (!isValidBtUserAgent(config.btUserAgent)) {
    config.btUserAgent = DEFAULT_APP_CONFIG.btUserAgent
    repairs.push('btUserAgent')
  }
  if (!isValidBtPeerIdPrefix(config.btPeerIdPrefix)) {
    config.btPeerIdPrefix = DEFAULT_APP_CONFIG.btPeerIdPrefix
    repairs.push('btPeerIdPrefix')
  }
  repairEnum(
    config,
    'magnetFileSelectionPolicy',
    ['download-all', 'prompt', 'manual'] as const,
    DEFAULT_APP_CONFIG.magnetFileSelectionPolicy,
    repairs,
  )
  repairEnum(
    config,
    'btBlocklistScope',
    ['peers', 'peers-and-trackers', 'all'] as const,
    DEFAULT_APP_CONFIG.btBlocklistScope,
    repairs,
  )

  if (typeof config.btExternalIp !== 'string' || !isValidOptionalIpAddress(config.btExternalIp)) {
    config.btExternalIp = DEFAULT_APP_CONFIG.btExternalIp
    repairs.push('btExternalIp')
  } else {
    config.btExternalIp = config.btExternalIp.trim()
  }
  for (const key of Object.keys(NUMERIC_CONFIG_CONSTRAINTS) as NumericConfigKey[]) {
    const constraint = NUMERIC_CONFIG_CONSTRAINTS[key]
    if (isNumericValueValid(config[key], constraint)) {
      config[key] = Number(config[key])
      continue
    }
    config[key] = DEFAULT_APP_CONFIG[key]
    repairs.push(key)
  }
  for (const [key, allowed] of Object.entries(NUMERIC_CONFIG_ENUM_VALUES)) {
    if (allowed.includes(Number(config[key]) as never)) continue
    config[key] = DEFAULT_APP_CONFIG[key as keyof typeof DEFAULT_APP_CONFIG]
    repairs.push(key)
  }
  config.btPeerBlocklistUrl = normalizeHttpUrl(
    config.btPeerBlocklistUrl,
    DEFAULT_APP_CONFIG.btPeerBlocklistUrl,
    'btPeerBlocklistUrl',
    repairs,
  )
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function normalizeUserAgentConfig(config: AppConfig, repairs: string[]): void {
  const profilesBefore = JSON.stringify(config.userAgentProfiles)
  const profiles = normalizeUserAgentProfiles(config.userAgentProfiles)
  config.userAgentProfiles = profiles
  if (JSON.stringify(profiles) !== profilesBefore) repairs.push('userAgentProfiles')

  const rulesBefore = JSON.stringify(config.userAgentRules)
  const rules = normalizeUserAgentRules(config.userAgentRules, profiles)
  config.userAgentRules = rules
  if (JSON.stringify(rules) !== rulesBefore) repairs.push('userAgentRules')

  const recentBefore = JSON.stringify(config.recentUserAgentProfileIds)
  const recent = normalizeRecentUserAgentProfileIds(config.recentUserAgentProfileIds, profiles)
  config.recentUserAgentProfileIds = recent
  if (JSON.stringify(recent) !== recentBefore) repairs.push('recentUserAgentProfileIds')
}

function normalizeSecrets(config: AppConfig, input: Partial<AppConfig> | null, repairs: string[]): void {
  if (!input || !('rpcSecret' in input) || config.rpcSecret == null) {
    config.rpcSecret = generateConfigSecret()
    repairs.push('rpcSecret')
  }
  if (!input || !('extensionApiSecret' in input) || config.extensionApiSecret == null) {
    config.extensionApiSecret = generateConfigSecret()
    repairs.push('extensionApiSecret')
  }
}

function normalizeFileCategories(config: AppConfig, repairs: string[]): void {
  const before = JSON.stringify(config.fileCategories)
  config.fileCategories = Array.isArray(config.fileCategories)
    ? config.fileCategories
        .filter((category): category is AppConfig['fileCategories'][number] => {
          if (!isRecord(category)) return false
          return (
            typeof category.label === 'string' &&
            Array.isArray(category.extensions) &&
            typeof category.directory === 'string'
          )
        })
        .map(normalizeFileCategory)
    : []
  if (JSON.stringify(config.fileCategories) !== before) repairs.push('fileCategories')
}

/**
 * Converts a partial persisted config into a complete, runtime-safe AppConfig.
 *
 * Migrations handle semantic schema changes. Hydration handles default
 * materialization and defensive repair for malformed persisted values.
 */
export function hydrateAppConfig(saved?: Partial<AppConfig> | null): HydratedAppConfig {
  const defaults = createDefaultAppConfig()
  const input = saved && isRecord(saved) ? (clonePlain(saved) as Partial<AppConfig>) : null
  const migration = input
    ? runMigrations(input)
    : { migrated: false, targetVersion: DEFAULT_APP_CONFIG.configVersion, errors: [] }
  const merged = { ...defaults, ...(input ?? {}) } as AppConfig
  const repairs: string[] = []
  const record = merged as Record<string, unknown>

  delete record.autoSelectAllMagnetFilesFromExtension
  delete record.autoSyncTracker
  delete record.protocols
  delete record.split
  delete record.maxConnectionPerServer
  delete record.engineMaxConnectionPerServer
  delete record.engineBinPath

  merged.proxy = normalizeProxy(input?.proxy ?? merged.proxy, repairs)
  merged.clipboard = normalizeClipboard(input?.clipboard ?? merged.clipboard)
  merged.portConflictRecovery = normalizePortRecovery(
    input?.portConflictRecovery ?? merged.portConflictRecovery,
    repairs,
  )
  merged.taskManualOrder = normalizeTaskManualOrder(input?.taskManualOrder ?? merged.taskManualOrder, repairs)
  merged.taskSort = normalizeTaskSort(input?.taskSort ?? merged.taskSort, repairs)

  normalizeScalarValues(record, repairs)
  normalizeSecrets(merged, input, repairs)
  normalizeFileCategories(merged, repairs)
  normalizeUserAgentConfig(merged, repairs)

  return {
    config: merged,
    migration,
    repairs: dedupe(repairs),
    shouldPersist: migration.migrated || repairs.length > 0,
  }
}
