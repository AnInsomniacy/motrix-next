/**
 * @fileoverview Tests for useSpeedLimiter pure functions and composable.
 *
 * TDD RED phase — all tests written before implementation.
 *
 * Business logic under test:
 * - Speed limit string parsing and building (aria2 format: '10M', '512K', '0')
 * - Compact badge formatting for Speedometer display
 * - Configured-limit detection for toggle behavior
 * - Toggle action resolution (state machine transitions)
 * - Integration: toggle calls RPC + persists to store
 * - Integration: applyCustomLimit calls RPC + persists
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseSpeedLimitValue,
  buildSpeedLimitString,
  formatLimitBadge,
  hasConfiguredLimit,
  resolveToggleAction,
  type SpeedLimiterDeps,
} from '../useSpeedLimiter'
import type { AppConfig } from '@shared/types'
import { createDefaultAppConfig } from '@shared/utils/configHydration'

// ═══════════════════════════════════════════════════════════════════════
// parseSpeedLimitValue — Parse aria2 speed limit strings to {num, unit}
// ═══════════════════════════════════════════════════════════════════════

describe('parseSpeedLimitValue', () => {
  it('parses "0" as zero with default unit K', () => {
    const result = parseSpeedLimitValue('0')
    expect(result).toEqual({ num: 0, unit: 'K' })
  })

  it('parses empty string as zero with default unit K', () => {
    const result = parseSpeedLimitValue('')
    expect(result).toEqual({ num: 0, unit: 'K' })
  })

  it('parses "512K" correctly', () => {
    const result = parseSpeedLimitValue('512K')
    expect(result).toEqual({ num: 512, unit: 'K' })
  })

  it('parses "10M" correctly', () => {
    const result = parseSpeedLimitValue('10M')
    expect(result).toEqual({ num: 10, unit: 'M' })
  })

  it('parses "1G" correctly', () => {
    const result = parseSpeedLimitValue('1G')
    expect(result).toEqual({ num: 1, unit: 'G' })
  })

  it('parses bare number as bytes/s with unit K (num=0 since < 1K)', () => {
    // aria2 treats bare numbers as bytes/s — '100' means 100 bytes/s
    const result = parseSpeedLimitValue('100')
    expect(result).toEqual({ num: 0, unit: 'K' })
  })

  it('parses undefined as zero with default unit K', () => {
    const result = parseSpeedLimitValue(undefined as unknown as string)
    expect(result).toEqual({ num: 0, unit: 'K' })
  })

  it('parses numeric input coerced to string', () => {
    const result = parseSpeedLimitValue(1024 as unknown as string)
    expect(result).toEqual({ num: 0, unit: 'K' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// buildSpeedLimitString — Build aria2 speed limit config string
// ═══════════════════════════════════════════════════════════════════════

describe('buildSpeedLimitString', () => {
  it('returns "0" for zero value regardless of unit', () => {
    expect(buildSpeedLimitString(0, 'K')).toBe('0')
    expect(buildSpeedLimitString(0, 'M')).toBe('0')
  })

  it('builds "512K" for num=512, unit=K', () => {
    expect(buildSpeedLimitString(512, 'K')).toBe('512K')
  })

  it('builds "10M" for num=10, unit=M', () => {
    expect(buildSpeedLimitString(10, 'M')).toBe('10M')
  })

  it('builds "1G" for num=1, unit=G', () => {
    expect(buildSpeedLimitString(1, 'G')).toBe('1G')
  })

  it('returns "0" for negative values', () => {
    expect(buildSpeedLimitString(-5, 'M')).toBe('0')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// formatLimitBadge — Compact display for Speedometer limit badge
// ═══════════════════════════════════════════════════════════════════════

describe('formatLimitBadge', () => {
  it('returns "∞" for "0" (unlimited)', () => {
    expect(formatLimitBadge('0')).toBe('∞')
  })

  it('returns "∞" for empty string (unlimited)', () => {
    expect(formatLimitBadge('')).toBe('∞')
  })

  it('returns "512 K/s" for "512K"', () => {
    expect(formatLimitBadge('512K')).toBe('512 K/s')
  })

  it('returns "10 M/s" for "10M"', () => {
    expect(formatLimitBadge('10M')).toBe('10 M/s')
  })

  it('returns "1 G/s" for "1G"', () => {
    expect(formatLimitBadge('1G')).toBe('1 G/s')
  })

  it('converts "1024K" to "1 M/s" for cleaner display', () => {
    expect(formatLimitBadge('1024K')).toBe('1 M/s')
  })

  it('converts "1024M" to "1 G/s" for cleaner display', () => {
    expect(formatLimitBadge('1024M')).toBe('1 G/s')
  })

  it('does not convert non-round values (e.g., "500K" stays "500 K/s")', () => {
    expect(formatLimitBadge('500K')).toBe('500 K/s')
  })

  it('handles bare bytes value gracefully', () => {
    // '100' = 100 bytes/s — too small for practical display
    expect(formatLimitBadge('100')).toBe('∞')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// hasConfiguredLimit — Check if config has non-zero speed limits
// ═══════════════════════════════════════════════════════════════════════

describe('hasConfiguredLimit', () => {
  it('returns false when both limits are "0"', () => {
    const config = {
      ...createDefaultAppConfig(),
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
    } as AppConfig
    expect(hasConfiguredLimit(config)).toBe(false)
  })

  it('returns false when both limits are empty strings', () => {
    const config = {
      ...createDefaultAppConfig(),
      maxOverallDownloadLimit: '',
      maxOverallUploadLimit: '',
    } as AppConfig
    expect(hasConfiguredLimit(config)).toBe(false)
  })

  it('returns true when download limit is set', () => {
    const config = {
      ...createDefaultAppConfig(),
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '0',
    } as AppConfig
    expect(hasConfiguredLimit(config)).toBe(true)
  })

  it('returns true when upload limit is set', () => {
    const config = {
      ...createDefaultAppConfig(),
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '512K',
    } as AppConfig
    expect(hasConfiguredLimit(config)).toBe(true)
  })

  it('returns true when both limits are set', () => {
    const config = {
      ...createDefaultAppConfig(),
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
    } as AppConfig
    expect(hasConfiguredLimit(config)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// resolveToggleAction — State machine for left-click toggle behavior
// ═══════════════════════════════════════════════════════════════════════

describe('resolveToggleAction', () => {
  it('returns "disable" when limit is currently enabled', () => {
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: true,
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
    } as AppConfig
    expect(resolveToggleAction(config)).toBe('disable')
  })

  it('returns "enable" when limit is disabled and config has values', () => {
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: false,
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '0',
    } as AppConfig
    expect(resolveToggleAction(config)).toBe('enable')
  })

  it('returns "needs-config" when limit is disabled and no values configured', () => {
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: false,
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
    } as AppConfig
    expect(resolveToggleAction(config)).toBe('needs-config')
  })

  it('returns "needs-config" when limit is disabled and values are empty strings', () => {
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: false,
      maxOverallDownloadLimit: '',
      maxOverallUploadLimit: '',
    } as AppConfig
    expect(resolveToggleAction(config)).toBe('needs-config')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// toggleSpeedLimit — Integration: toggle limit on/off via RPC + store
// ═══════════════════════════════════════════════════════════════════════

describe('toggleSpeedLimit', () => {
  let mockChangeGlobalOption: SpeedLimiterDeps['changeGlobalOption']
  let mockUpdateAndSave: SpeedLimiterDeps['updateAndSave']

  beforeEach(() => {
    mockChangeGlobalOption = vi.fn<SpeedLimiterDeps['changeGlobalOption']>().mockResolvedValue(undefined)
    mockUpdateAndSave = vi.fn<SpeedLimiterDeps['updateAndSave']>().mockResolvedValue(true)
  })

  // Dynamic import to avoid module-level import issues with mocks
  async function loadToggle() {
    const { toggleSpeedLimit } = await import('../useSpeedLimiter')
    return toggleSpeedLimit
  }

  it('disables limit by sending 0/0 to aria2 and updating store', async () => {
    const toggleSpeedLimit = await loadToggle()
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: true,
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
    } as AppConfig

    const result = await toggleSpeedLimit(config, {
      changeGlobalOption: mockChangeGlobalOption,
      updateAndSave: mockUpdateAndSave,
    })

    expect(result).toBe('disabled')
    // Must send '0' to aria2 to remove limits
    expect(mockChangeGlobalOption).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
    })
    expect(mockUpdateAndSave).toHaveBeenCalledWith({ speedLimitEnabled: false })
  })

  it('enables limit by sending configured values to aria2', async () => {
    const toggleSpeedLimit = await loadToggle()
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: false,
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
    } as AppConfig

    const result = await toggleSpeedLimit(config, {
      changeGlobalOption: mockChangeGlobalOption,
      updateAndSave: mockUpdateAndSave,
    })

    expect(result).toBe('enabled')
    expect(mockChangeGlobalOption).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
    })
    expect(mockUpdateAndSave).toHaveBeenCalledWith({ speedLimitEnabled: true })
  })

  it('returns "needs-config" without calling RPC when no limits configured', async () => {
    const toggleSpeedLimit = await loadToggle()
    const config = {
      ...createDefaultAppConfig(),
      speedLimitEnabled: false,
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
    } as AppConfig

    const result = await toggleSpeedLimit(config, {
      changeGlobalOption: mockChangeGlobalOption,
      updateAndSave: mockUpdateAndSave,
    })

    expect(result).toBe('needs-config')
    expect(mockChangeGlobalOption).not.toHaveBeenCalled()
    expect(mockUpdateAndSave).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// applyCustomLimit — Set specific limit values via RPC + persist
// ═══════════════════════════════════════════════════════════════════════

describe('applyCustomLimit', () => {
  let mockChangeGlobalOption: SpeedLimiterDeps['changeGlobalOption']
  let mockUpdateAndSave: SpeedLimiterDeps['updateAndSave']

  beforeEach(() => {
    mockChangeGlobalOption = vi.fn<SpeedLimiterDeps['changeGlobalOption']>().mockResolvedValue(undefined)
    mockUpdateAndSave = vi.fn<SpeedLimiterDeps['updateAndSave']>().mockResolvedValue(true)
  })

  async function loadApply() {
    const { applyCustomLimit } = await import('../useSpeedLimiter')
    return applyCustomLimit
  }

  it('applies non-zero limits and enables speed limiting', async () => {
    const applyCustomLimit = await loadApply()

    await applyCustomLimit('10M', '512K', {
      changeGlobalOption: mockChangeGlobalOption,
      updateAndSave: mockUpdateAndSave,
    })

    expect(mockChangeGlobalOption).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
    })
    expect(mockUpdateAndSave).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '10M',
      maxOverallUploadLimit: '512K',
      speedLimitEnabled: true,
    })
  })

  it('applies zero download limit (only upload limited)', async () => {
    const applyCustomLimit = await loadApply()

    await applyCustomLimit('0', '512K', {
      changeGlobalOption: mockChangeGlobalOption,
      updateAndSave: mockUpdateAndSave,
    })

    expect(mockChangeGlobalOption).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '512K',
    })
    expect(mockUpdateAndSave).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '512K',
      speedLimitEnabled: true,
    })
  })

  it('disables speed limiting when both values are zero', async () => {
    const applyCustomLimit = await loadApply()

    await applyCustomLimit('0', '0', {
      changeGlobalOption: mockChangeGlobalOption,
      updateAndSave: mockUpdateAndSave,
    })

    expect(mockChangeGlobalOption).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
    })
    // Both zero = no limit = disable the toggle
    expect(mockUpdateAndSave).toHaveBeenCalledWith({
      maxOverallDownloadLimit: '0',
      maxOverallUploadLimit: '0',
      speedLimitEnabled: false,
    })
  })
})
