/**
 * @fileoverview Structural tests for the close-to-tray Wayland regression fix.
 *
 * Root cause: On Linux/Wayland with decorations:false, the window compositor
 * can bypass both JS `onCloseRequested` and the `RunEvent::WindowEvent`
 * callback.  The fix registers `CloseRequested` handling in
 * `Builder::on_window_event()` — the FIRST hook in Tauri's event lifecycle —
 * where `api.prevent_close()` is guaranteed to execute before the compositor
 * can destroy the window.
 *
 * Tests verify:
 * 1. lib.rs handles CloseRequested in on_window_event (not handle_run_event)
 * 2. lib.rs calls api.prevent_close() unconditionally (macOS fix preserved)
 * 3. lib.rs hides the window in the should_hide branch
 * 4. lib.rs emits "show-exit-dialog" in the !should_hide branch
 * 5. MainLayout.vue listens for "show-exit-dialog" and sets showExitDialog
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '../../../..')
const TAURI_ROOT = path.resolve(SRC_ROOT, 'src-tauri')

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extracts a function/closure body from source code (brace-balanced extraction).
 * Returns the content between the opening `{` and its matching `}`.
 */
function extractBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `${signature} must exist in source`).toBeGreaterThanOrEqual(0)
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) return ''
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(braceStart, i + 1)
  }
  return ''
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: lib.rs — on_window_event CloseRequested handler
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — CloseRequested show-exit-dialog emit', () => {
  let source: string
  let crBlock: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
    crBlock = extractBody(source, '.on_window_event(')
  })

  it('handles CloseRequested in on_window_event (not handle_run_event)', () => {
    expect(crBlock).toContain('CloseRequested')
    const runEventBody = extractBody(source, 'fn handle_run_event')
    expect(runEventBody).not.toContain('CloseRequested')
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
    // The emit must be in the `else` block after the should_hide check
    const shouldHideIdx = crBlock.indexOf('if should_hide')
    const afterShouldHide = crBlock.slice(shouldHideIdx)
    // Find the else keyword
    const elseIdx = afterShouldHide.indexOf('else')
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
