/**
 * @fileoverview Structural tests: every relaunch() call MUST be preceded by
 * stop_engine_command to kill the aria2c sidecar before the NSIS installer
 * takes over on Windows.
 *
 * Problem: On Windows, relaunch() launches the NSIS installer which forcefully
 * terminates the main Tauri process. NSIS has no knowledge of the aria2c
 * sidecar child process. If aria2c.exe is still running, Windows' mandatory
 * file locking prevents NSIS from overwriting it → update failure.
 *
 * Fix: Every code path that calls relaunch() must first call
 * stop_engine_command (via useIpc().stopEngine()) and await it.
 *
 * Verification strategy: For each Vue file that imports `relaunch`, verify
 * it also imports/calls `stop_engine_command` or `stopEngine`, and that
 * every relaunch() call is preceded by the engine stop call.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC = path.resolve(__dirname, '..', '..', '..')
const UPDATE_DIALOG = path.join(SRC, 'components', 'preference', 'UpdateDialog.vue')
const BASIC = path.join(SRC, 'components', 'preference', 'Basic.vue')
const ADVANCED = path.join(SRC, 'components', 'preference', 'Advanced.vue')

describe('graceful engine shutdown before relaunch()', () => {
  let updateDialogSrc: string
  let basicSrc: string
  let advancedSrc: string

  beforeAll(() => {
    updateDialogSrc = fs.readFileSync(UPDATE_DIALOG, 'utf-8')
    basicSrc = fs.readFileSync(BASIC, 'utf-8')
    advancedSrc = fs.readFileSync(ADVANCED, 'utf-8')
  })

  // ── UpdateDialog.vue ──────────────────────────────────────────────

  describe('UpdateDialog.vue', () => {
    it('imports or calls stop_engine_command / stopEngine / apply_update', () => {
      expect(
        updateDialogSrc.includes('stop_engine_command') ||
          updateDialogSrc.includes('stopEngine') ||
          updateDialogSrc.includes('apply_update'),
      ).toBe(true)
    })

    it('calls download_update (not install_update) for the download phase', () => {
      expect(updateDialogSrc).toContain('download_update')
      // install_update should no longer exist — download and install are split
      expect(updateDialogSrc).not.toContain("'install_update'")
    })

    it('handleInstallAndRelaunch is async (must await apply_update)', () => {
      expect(updateDialogSrc).toMatch(/async\s+function\s+handleInstallAndRelaunch/)
    })

    it('handleInstallAndRelaunch calls apply_update before relaunch', () => {
      const fn = extractFunction(updateDialogSrc, 'handleInstallAndRelaunch')
      expect(fn).toBeTruthy()
      const applyIdx = fn!.indexOf('apply_update')
      const relaunchIdx = fn!.indexOf('relaunch()')
      expect(applyIdx).toBeGreaterThanOrEqual(0)
      expect(relaunchIdx).toBeGreaterThan(applyIdx)
    })

    it('calls apply_update directly without artificial delay', () => {
      const fn = extractFunction(updateDialogSrc, 'handleInstallAndRelaunch')
      expect(fn).toBeTruthy()
      // No artificial timer — apply_update is awaited directly
      expect(fn!.includes('await invoke')).toBe(true)
      expect(fn!.includes('MIN_')).toBe(false)
    })
  })

  // ── Basic.vue ─────────────────────────────────────────────────────

  describe('Basic.vue', () => {
    it('imports or calls stop_engine_command / stopEngine', () => {
      expect(basicSrc.includes('stop_engine_command') || basicSrc.includes('stopEngine')).toBe(true)
    })

    it('every relaunch() call is preceded by stopEngine/stop_engine_command', () => {
      // Find all relaunch() occurrences and verify each has a stop before it
      assertStopBeforeEveryRelaunch(basicSrc, 'Basic.vue')
    })
  })

  // ── Advanced.vue ──────────────────────────────────────────────────

  describe('Advanced.vue', () => {
    it('imports or calls stop_engine_command / stopEngine', () => {
      expect(advancedSrc.includes('stop_engine_command') || advancedSrc.includes('stopEngine')).toBe(true)
    })

    it('every relaunch() call is preceded by stopEngine/stop_engine_command', () => {
      assertStopBeforeEveryRelaunch(advancedSrc, 'Advanced.vue')
    })
  })

  // ── Rust backend: updater.rs ─────────────────────────────────────

  describe('updater.rs (Rust backend)', () => {
    const UPDATER_RS = path.join(SRC, '..', 'src-tauri', 'src', 'commands', 'updater.rs')
    let updaterSrc: string

    beforeAll(() => {
      updaterSrc = fs.readFileSync(UPDATER_RS, 'utf-8')
    })

    it('exposes download_update as a tauri command', () => {
      expect(updaterSrc).toContain('pub async fn download_update')
    })

    it('exposes apply_update as a tauri command', () => {
      expect(updaterSrc).toContain('pub async fn apply_update')
    })

    it('apply_update calls stop_engine before .install()', () => {
      // Extract only the apply_update function body for precise assertion
      const fnStart = updaterSrc.indexOf('pub async fn apply_update')
      expect(fnStart).toBeGreaterThanOrEqual(0)
      const fnBody = updaterSrc.slice(fnStart)
      const stopIdx = fnBody.indexOf('stop_engine')
      const installIdx = fnBody.indexOf('.install(')
      expect(stopIdx).toBeGreaterThanOrEqual(0)
      expect(installIdx).toBeGreaterThan(stopIdx)
    })

    it('download_update does NOT call stop_engine (engine stays alive during download)', () => {
      const fnStart = updaterSrc.indexOf('pub async fn download_update')
      const fnEnd = updaterSrc.indexOf('pub async fn apply_update')
      expect(fnStart).toBeGreaterThanOrEqual(0)
      expect(fnEnd).toBeGreaterThan(fnStart)
      const downloadFnBody = updaterSrc.slice(fnStart, fnEnd)
      expect(downloadFnBody).not.toContain('stop_engine')
    })

    it('does NOT use combined download-and-install (must split download/install)', () => {
      const banned = 'download_and_' + 'install'
      const testBoundary = updaterSrc.indexOf('#[cfg(test)]')
      const productionCode = testBoundary > 0 ? updaterSrc.slice(0, testBoundary) : updaterSrc
      expect(productionCode).not.toContain(banned)
    })

    it('uses shared state to pass downloaded bytes between commands', () => {
      expect(updaterSrc).toContain('DownloadedUpdate')
    })
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/** Extracts the body of a named function (supports `function name` and `async function name`). */
function extractFunction(source: string, name: string): string | null {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const match = pattern.exec(source)
  if (!match) return null
  const start = source.indexOf('{', match.index)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(match.index, i + 1)
  }
  return null
}

/**
 * For every occurrence of `relaunch()` in the source, asserts that
 * `stopEngine` or `stop_engine_command` appears in the same enclosing
 * block (within 500 chars before the relaunch call).
 */
function assertStopBeforeEveryRelaunch(source: string, filename: string) {
  const relaunchPattern = /relaunch\(\)/g
  let match: RegExpExecArray | null
  let found = 0
  while ((match = relaunchPattern.exec(source)) !== null) {
    found++
    // Look in the 500 chars before this relaunch() call
    const lookback = source.slice(Math.max(0, match.index - 500), match.index)
    const hasStop = lookback.includes('stopEngine') || lookback.includes('stop_engine_command')
    expect(hasStop, `${filename}: relaunch() at offset ${match.index} has no preceding stopEngine`).toBe(true)
  }
  expect(found, `${filename}: expected at least 1 relaunch() call`).toBeGreaterThanOrEqual(1)
}
