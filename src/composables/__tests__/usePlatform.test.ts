/**
 * @fileoverview Tests for `usePlatform` composable.
 *
 * Verifies that the composable correctly exposes atomic boolean platform
 * flags, platform label, and architecture label — eliminating the need for
 * pre-combined flags like `isMacOrWin` scattered across components.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock @tauri-apps/plugin-os ───────────────────────────────────────
const mockPlatform = vi.fn<() => string>()

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: mockPlatform,
  arch: vi.fn(() => 'x86_64'),
  version: vi.fn(() => '6.1.0'),
}))

// Must import AFTER mock registration so the composable picks up the mock.

let usePlatform: typeof import('../usePlatform').usePlatform

beforeEach(async () => {
  vi.resetModules()
  mockPlatform.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Atomic boolean flags ─────────────────────────────────────────────

describe('usePlatform', () => {
  describe('atomic boolean flags', () => {
    it('returns isMac=true, isWindows=false, isLinux=false on macOS', async () => {
      mockPlatform.mockReturnValue('macos')
      const mod = await import('../usePlatform')
      usePlatform = mod.usePlatform
      const { isMac, isWindows, isLinux } = usePlatform()
      expect(isMac.value).toBe(true)
      expect(isWindows.value).toBe(false)
      expect(isLinux.value).toBe(false)
    })

    it('returns isWindows=true, isMac=false, isLinux=false on Windows', async () => {
      mockPlatform.mockReturnValue('windows')
      const mod = await import('../usePlatform')
      usePlatform = mod.usePlatform
      const { isMac, isWindows, isLinux } = usePlatform()
      expect(isMac.value).toBe(false)
      expect(isWindows.value).toBe(true)
      expect(isLinux.value).toBe(false)
    })

    it('returns isLinux=true, isMac=false, isWindows=false on Linux', async () => {
      mockPlatform.mockReturnValue('linux')
      const mod = await import('../usePlatform')
      usePlatform = mod.usePlatform
      const { isMac, isWindows, isLinux } = usePlatform()
      expect(isMac.value).toBe(false)
      expect(isWindows.value).toBe(false)
      expect(isLinux.value).toBe(true)
    })

    it('returns isAndroid=true and isMobile=true on Android', async () => {
      mockPlatform.mockReturnValue('android')
      const mod = await import('../usePlatform')
      usePlatform = mod.usePlatform
      const { isMac, isWindows, isLinux, isAndroid, isMobile } = usePlatform()
      expect(isMac.value).toBe(false)
      expect(isWindows.value).toBe(false)
      expect(isLinux.value).toBe(false)
      expect(isAndroid.value).toBe(true)
      expect(isMobile.value).toBe(true)
      expect(usePlatform().platformLabel.value).toBe('Android')
    })
  })

  // ─── Platform label ──────────────────────────────────────────────

  describe('platformLabel', () => {
    it.each([
      ['macos', 'macOS'],
      ['windows', 'Windows'],
      ['linux', 'Linux'],
    ])('maps "%s" to "%s"', async (raw, expected) => {
      mockPlatform.mockReturnValue(raw)
      const mod = await import('../usePlatform')
      const { platformLabel } = mod.usePlatform()
      expect(platformLabel.value).toBe(expected)
    })

    it('falls back to raw value for unknown platforms', async () => {
      mockPlatform.mockReturnValue('freebsd')
      const mod = await import('../usePlatform')
      const { platformLabel } = mod.usePlatform()
      expect(platformLabel.value).toBe('freebsd')
    })
  })

  // ─── Architecture label ──────────────────────────────────────────

  describe('archLabel', () => {
    it('returns "Apple Silicon" for aarch64 on macOS', async () => {
      mockPlatform.mockReturnValue('macos')
      const mod = await import('../usePlatform')
      const { archLabel } = mod.usePlatform()
      expect(archLabel('aarch64')).toBe('Apple Silicon')
    })

    it('returns "Intel" for x86_64 on macOS', async () => {
      mockPlatform.mockReturnValue('macos')
      const mod = await import('../usePlatform')
      const { archLabel } = mod.usePlatform()
      expect(archLabel('x86_64')).toBe('Intel')
    })

    it('returns "ARM64" for aarch64 on non-macOS', async () => {
      mockPlatform.mockReturnValue('linux')
      const mod = await import('../usePlatform')
      const { archLabel } = mod.usePlatform()
      expect(archLabel('aarch64')).toBe('ARM64')
    })

    it('returns "x64" for x86_64 on non-macOS', async () => {
      mockPlatform.mockReturnValue('windows')
      const mod = await import('../usePlatform')
      const { archLabel } = mod.usePlatform()
      expect(archLabel('x86_64')).toBe('x64')
    })

    it('returns raw value for unknown architectures', async () => {
      mockPlatform.mockReturnValue('linux')
      const mod = await import('../usePlatform')
      const { archLabel } = mod.usePlatform()
      expect(archLabel('riscv64')).toBe('riscv64')
    })
  })

  // ─── Error resilience ────────────────────────────────────────────

  describe('error resilience', () => {
    it('defaults all flags to false when platform() throws', async () => {
      mockPlatform.mockImplementation(() => {
        throw new Error('Tauri API unavailable')
      })
      const mod = await import('../usePlatform')
      const { isMac, isWindows, isLinux, platformLabel } = mod.usePlatform()
      expect(isMac.value).toBe(false)
      expect(isWindows.value).toBe(false)
      expect(isLinux.value).toBe(false)
      expect(platformLabel.value).toBe('')
    })
  })

  // ─── Composability ────────────────────────────────────────────────

  describe('composability — consumers combine flags inline', () => {
    it('isMac || isWindows replaces old isMacOrWin', async () => {
      mockPlatform.mockReturnValue('macos')
      const mod = await import('../usePlatform')
      const { isMac, isWindows } = mod.usePlatform()
      expect(isMac.value || isWindows.value).toBe(true)
    })

    it('isMac || isLinux replaces old isMacOrLinux', async () => {
      mockPlatform.mockReturnValue('linux')
      const mod = await import('../usePlatform')
      const { isMac, isLinux } = mod.usePlatform()
      expect(isMac.value || isLinux.value).toBe(true)
    })

    it('Windows does not match isMac || isLinux', async () => {
      mockPlatform.mockReturnValue('windows')
      const mod = await import('../usePlatform')
      const { isMac, isLinux } = mod.usePlatform()
      expect(isMac.value || isLinux.value).toBe(false)
    })
  })

  // ─── Singleton semantics ──────────────────────────────────────────

  describe('singleton semantics', () => {
    it('returns the same reactive refs across multiple calls', async () => {
      mockPlatform.mockReturnValue('macos')
      const mod = await import('../usePlatform')
      const a = mod.usePlatform()
      const b = mod.usePlatform()
      expect(a.isMac).toBe(b.isMac)
      expect(a.isWindows).toBe(b.isWindows)
      expect(a.isLinux).toBe(b.isLinux)
      expect(a.platform).toBe(b.platform)
    })
  })
})
