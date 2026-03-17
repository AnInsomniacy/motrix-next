/**
 * @fileoverview Structural tests for the close-to-tray Wayland regression fix.
 *
 * Root cause: Commit f06c6c4 (v3.2.0-beta.1) moved `api.prevent_close()` from
 * inside `if should_hide {}` to unconditional, fixing a macOS webview freeze.
 * However, when `should_hide == false`, the frontend `onCloseRequested` callback
 * does not reliably fire on Linux/Wayland (decorations:false + tao#1046),
 * leaving the window in limbo (Rust prevents close, frontend never shows dialog).
 *
 * Fix: Rust emits "show-exit-dialog" via `app.emit()` when `!should_hide`,
 * which is more reliable than the JS `onCloseRequested` listener on Wayland.
 * The frontend listens for this event and shows the exit dialog.
 *
 * Tests verify:
 * 1. lib.rs emits "show-exit-dialog" in the `!should_hide` branch
 * 2. lib.rs still calls api.prevent_close() unconditionally (macOS fix preserved)
 * 3. lib.rs still hides the window in the `should_hide` branch
 * 4. MainLayout.vue listens for "show-exit-dialog" and sets showExitDialog
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '../../../..')
const TAURI_ROOT = path.resolve(SRC_ROOT, 'src-tauri')

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the CloseRequested handler block from lib.rs.
 * Returns the source from "CloseRequested" up to (but not including)
 * the next major match arm (Reopen or the catch-all `_`).
 */
function extractCloseRequestedBlock(source: string): string {
  const crStart = source.indexOf('CloseRequested')
  expect(crStart, 'CloseRequested must exist in lib.rs').toBeGreaterThanOrEqual(0)
  // Find the next RunEvent match arm (Reopen or catch-all)
  const reopenIdx = source.indexOf('RunEvent::Reopen', crStart)
  const catchAllIdx = source.indexOf('_ =>', crStart)
  const endIdx = Math.min(reopenIdx > 0 ? reopenIdx : Infinity, catchAllIdx > 0 ? catchAllIdx : Infinity)
  expect(endIdx, 'must find end of CloseRequested block').toBeLessThan(Infinity)
  return source.slice(crStart, endIdx)
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: lib.rs — CloseRequested emits show-exit-dialog
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — CloseRequested show-exit-dialog emit', () => {
  let source: string
  let crBlock: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
    crBlock = extractCloseRequestedBlock(source)
  })

  it('calls api.prevent_close() unconditionally (macOS freeze fix preserved)', () => {
    // prevent_close must appear BEFORE the should_hide check
    const preventIdx = crBlock.indexOf('api.prevent_close()')
    const shouldHideIdx = crBlock.indexOf('if should_hide')
    expect(preventIdx, 'api.prevent_close() must exist').toBeGreaterThanOrEqual(0)
    expect(shouldHideIdx, 'should_hide check must exist').toBeGreaterThanOrEqual(0)
    expect(preventIdx, 'prevent_close must appear before should_hide check').toBeLessThan(shouldHideIdx)
  })

  it('hides the main window in the should_hide branch', () => {
    expect(crBlock).toContain('window.hide()')
  })

  it('emits "show-exit-dialog" when should_hide is false', () => {
    // The else branch (or !should_hide path) must emit the event
    expect(crBlock).toContain('show-exit-dialog')
    expect(crBlock).toContain('.emit(')
  })

  it('emit appears in the else branch (not inside should_hide)', () => {
    // The emit must be in the `else` block, not inside `if should_hide`
    const shouldHideIdx = crBlock.indexOf('if should_hide')
    const afterShouldHide = crBlock.slice(shouldHideIdx)
    const elseIdx = afterShouldHide.indexOf('} else {')
    expect(elseIdx, 'must have an else branch for !should_hide').toBeGreaterThanOrEqual(0)
    const elseBranch = afterShouldHide.slice(elseIdx)
    expect(elseBranch).toContain('show-exit-dialog')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 2: MainLayout.vue — listens for show-exit-dialog
// ═══════════════════════════════════════════════════════════════════

describe('MainLayout.vue — show-exit-dialog listener', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
  })

  it('registers a listener for the "show-exit-dialog" event', () => {
    expect(source).toContain('show-exit-dialog')
    expect(source).toContain('listen(')
  })

  it('sets showExitDialog to true when event is received', () => {
    // Find the listener block for show-exit-dialog
    const listenerIdx = source.indexOf('show-exit-dialog')
    expect(listenerIdx).toBeGreaterThanOrEqual(0)
    // The handler should reference showExitDialog
    const nearbyBlock = source.slice(listenerIdx, listenerIdx + 500)
    expect(nearbyBlock).toContain('showExitDialog')
  })

  it('cleans up the listener in onUnmounted', () => {
    // Must have an unlisten variable for cleanup
    expect(source).toContain('unlistenExitDialog')
    const unmountedBlock = source.slice(source.indexOf('onUnmounted'))
    expect(unmountedBlock).toContain('unlistenExitDialog')
  })
})
