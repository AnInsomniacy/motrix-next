/**
 * @fileoverview Speed limiter pure functions and integration helpers.
 *
 * Pure functions (testable without Vue/Pinia):
 * - parseSpeedLimitValue   — parse aria2 config string to {num, unit}
 * - buildSpeedLimitString  — build config string from num + unit
 * - formatLimitBadge       — compact badge text for Speedometer display
 * - hasConfiguredLimit     — check if config has non-zero speed limits
 * - resolveToggleAction    — state machine: what should left-click do?
 *
 * Integration helpers (dependency-injected for testability):
 * - toggleSpeedLimit       — toggle limit on/off via RPC + persist
 * - applyCustomLimit       — set specific values via RPC + persist
 */
import type { AppConfig } from '@shared/types'
import { logger } from '@shared/logger'

// ── Types ────────────────────────────────────────────────────────────

export interface SpeedLimitValue {
  num: number
  unit: string
}

export type ToggleAction = 'enable' | 'disable' | 'needs-config'

/** Dependency injection interface for integration functions. */
export interface SpeedLimiterDeps {
  changeGlobalOption: (options: Partial<AppConfig>) => Promise<void>
  updateAndSave: (partial: Partial<AppConfig>) => Promise<boolean>
}

// ── Pure Functions ───────────────────────────────────────────────────

/**
 * Parses an aria2 speed limit config string into a numeric value and unit.
 *
 * aria2 format: '0' (unlimited), '512K', '10M', '1G', or bare bytes '100'.
 * Bare byte values are too small for practical limits, so they map to {0, 'K'}.
 */
export function parseSpeedLimitValue(value: string): SpeedLimitValue {
  const str = String(value ?? '')
  if (!str || str === '0') return { num: 0, unit: 'K' }

  const match = /^(\d+\.?\d*)([KMG])$/.exec(str)
  if (!match) return { num: 0, unit: 'K' }

  return { num: parseFloat(match[1]), unit: match[2] }
}

/**
 * Builds an aria2 speed limit config string from a numeric value and unit.
 * Returns '0' for zero or negative values (aria2's "unlimited" sentinel).
 */
export function buildSpeedLimitString(num: number, unit: string): string {
  if (num <= 0) return '0'
  return `${num}${unit}`
}

/**
 * Formats a speed limit config value as a compact badge for the Speedometer.
 *
 * Examples: '10M' → '10 M/s', '512K' → '512 K/s', '0' → '∞', '1024K' → '1 M/s'.
 * Auto-promotes round values (1024K → 1 M/s, 1024M → 1 G/s) for cleaner display.
 */
export function formatLimitBadge(value: string): string {
  const parsed = parseSpeedLimitValue(value)
  if (parsed.num <= 0) return '∞'

  // Auto-promote: 1024K → 1 M/s, 1024M → 1 G/s
  if (parsed.unit === 'K' && parsed.num >= 1024 && parsed.num % 1024 === 0) {
    return `${parsed.num / 1024} M/s`
  }
  if (parsed.unit === 'M' && parsed.num >= 1024 && parsed.num % 1024 === 0) {
    return `${parsed.num / 1024} G/s`
  }

  return `${parsed.num} ${parsed.unit}/s`
}

/**
 * Returns true if the config has at least one non-zero overall speed limit.
 * Used to decide whether left-click can toggle or must prompt for values.
 */
export function hasConfiguredLimit(config: AppConfig): boolean {
  const dl = parseSpeedLimitValue(config.maxOverallDownloadLimit)
  const ul = parseSpeedLimitValue(config.maxOverallUploadLimit)
  return dl.num > 0 || ul.num > 0
}

/**
 * State machine resolver for the Speedometer left-click toggle.
 *
 * Returns:
 * - 'disable' — limit is active, clicking should turn it off
 * - 'enable'  — limit is inactive, config has values, clicking should apply them
 * - 'needs-config' — limit is inactive, no values configured, must show popover
 */
export function resolveToggleAction(config: AppConfig): ToggleAction {
  if (config.speedLimitEnabled) return 'disable'
  if (hasConfiguredLimit(config)) return 'enable'
  return 'needs-config'
}

// ── Integration Functions ────────────────────────────────────────────

/**
 * Toggles speed limit on/off. Calls aria2 RPC to apply/remove limits
 * and persists the toggle state to the preference store.
 *
 * @returns The action taken: 'enabled', 'disabled', or 'needs-config'.
 */
export async function toggleSpeedLimit(
  config: AppConfig,
  deps: SpeedLimiterDeps,
): Promise<'enabled' | 'disabled' | 'needs-config'> {
  const action = resolveToggleAction(config)

  if (action === 'needs-config') {
    logger.info('SpeedLimiter.toggle', 'no configured limits — prompting user')
    return 'needs-config'
  }

  if (action === 'disable') {
    // Remove limits from aria2 engine
    await deps.changeGlobalOption({
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
    })
    await deps.updateAndSave({ speedLimitEnabled: false })
    logger.info('SpeedLimiter.toggle', 'disabled — sent 0/0 to aria2')
    return 'disabled'
  }

  // action === 'enable': apply configured values
  const dl = config.maxOverallDownloadLimit
  const ul = config.maxOverallUploadLimit
  await deps.changeGlobalOption({
    maxOverallDownloadLimit: dl,
    maxOverallUploadLimit: ul,
  })
  await deps.updateAndSave({ speedLimitEnabled: true })
  logger.info('SpeedLimiter.toggle', `enabled — dl=${dl} ul=${ul}`)
  return 'enabled'
}

/**
 * Applies specific speed limit values to the aria2 engine and persists
 * them to the preference store. Automatically sets speedLimitEnabled
 * based on whether at least one limit is non-zero.
 */
export async function applyCustomLimit(
  downloadLimit: string,
  uploadLimit: string,
  deps: SpeedLimiterDeps,
): Promise<void> {
  await deps.changeGlobalOption({
    maxOverallDownloadLimit: downloadLimit,
    maxOverallUploadLimit: uploadLimit,
  })

  const dlParsed = parseSpeedLimitValue(downloadLimit)
  const ulParsed = parseSpeedLimitValue(uploadLimit)
  const hasLimit = dlParsed.num > 0 || ulParsed.num > 0

  await deps.updateAndSave({
    maxOverallDownloadLimit: downloadLimit,
    maxOverallUploadLimit: uploadLimit,
    speedLimitEnabled: hasLimit,
  })
  logger.info('SpeedLimiter.applyCustom', `dl=${downloadLimit} ul=${uploadLimit} enabled=${hasLimit}`)
}
