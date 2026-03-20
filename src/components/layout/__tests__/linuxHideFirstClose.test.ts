/**
 * @fileoverview Structural tests for the Linux hide-first close fix.
 *
 * Root cause: On Linux/Wayland + decorations:false, the compositor can destroy
 * the window despite `api.prevent_close()`.  When minimize-to-tray is DISABLED
 * and the user closes via the taskbar (not the app's custom title bar), the
 * Rust CloseRequested handler only emits "show-exit-dialog" without hiding the
 * window first.  The compositor races and destroys the window before the
 * frontend can show the dialog.
 *
 * Fix: On Linux, ALWAYS hide the window in the CloseRequested handler before
 * emitting any events.  When minimize-to-tray is disabled (!should_hide), hide
 * the window AND emit a special "restore-and-show-exit-dialog" event so the
 * frontend can re-show the window with the exit dialog.
 *
 * Industry reference: Clash Verge Rev (100k+ stars) unconditionally hides on
 * all CloseRequested events for this exact reason.
 *
 * Tests verify:
 * 1. lib.rs hides the window on Linux even when should_hide is false
 * 2. lib.rs emits "restore-and-show-exit-dialog" on Linux when !should_hide
 * 3. lib.rs logs the Linux hide-first action at info level
 * 4. MainLayout.vue listens for "restore-and-show-exit-dialog" event
 * 5. MainLayout.vue re-shows the window and opens exit dialog on restore event
 * 6. MainLayout.vue cleans up the restore listener on unmount
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
// Group 1: lib.rs — Linux hide-first behavior in on_window_event
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — Linux hide-first close behavior', () => {
  let source: string
  let crBlock: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
    crBlock = extractBody(source, '.on_window_event(')
  })

  it('hides the window on Linux even when should_hide is false', () => {
    // The CloseRequested handler must contain a Linux-specific path that
    // calls window.hide() regardless of the should_hide preference.
    // This prevents Wayland compositors from destroying the window.
    expect(crBlock).toContain('target_os = "linux"')
    // Must have window.hide() in the Linux-specific block within the else branch
    const elseIdx = crBlock.indexOf('} else {', crBlock.indexOf('if should_hide'))
    expect(elseIdx, 'must have else branch after should_hide').toBeGreaterThanOrEqual(0)
    const elseBranch = crBlock.slice(elseIdx)
    expect(elseBranch).toContain('window.hide()')
  })

  it('emits "restore-and-show-exit-dialog" on Linux when !should_hide', () => {
    // The else (!should_hide) branch must emit a special event on Linux
    // that tells the frontend to re-show the window and display the exit dialog.
    const elseIdx = crBlock.indexOf('} else {', crBlock.indexOf('if should_hide'))
    const elseBranch = crBlock.slice(elseIdx)
    expect(elseBranch).toContain('restore-and-show-exit-dialog')
  })

  it('still emits "show-exit-dialog" for non-Linux platforms', () => {
    // macOS and Windows should still use the original show-exit-dialog event
    // (no hide-first needed because their compositors respect prevent_close)
    const elseIdx = crBlock.indexOf('} else {', crBlock.indexOf('if should_hide'))
    const elseBranch = crBlock.slice(elseIdx)
    expect(elseBranch).toContain('show-exit-dialog')
  })

  it('logs the Linux hide-first action at info level', () => {
    // Must have diagnostic logging for the Linux hide-first path
    expect(crBlock).toContain('window:linux-hide-first')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 2: MainLayout.vue — restore-and-show-exit-dialog listener
// ═══════════════════════════════════════════════════════════════════

describe('MainLayout.vue — restore-and-show-exit-dialog listener', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
  })

  it('registers a listener for the "restore-and-show-exit-dialog" event', () => {
    expect(source).toContain('restore-and-show-exit-dialog')
    // Must use Tauri's listen() to register the event handler
    const idx = source.indexOf('restore-and-show-exit-dialog')
    expect(idx).toBeGreaterThanOrEqual(0)
    // The listen call should be near the event name
    const nearbyBefore = source.slice(Math.max(0, idx - 200), idx)
    expect(nearbyBefore).toContain('listen')
  })

  it('re-shows the window when the restore event fires', () => {
    // The handler must call window.show() to restore the hidden window
    const idx = source.indexOf('restore-and-show-exit-dialog')
    const nearbyBlock = source.slice(idx, idx + 600)
    expect(nearbyBlock).toContain('.show()')
  })

  it('sets focus on the restored window', () => {
    // After showing, must set focus so the dialog is interactive
    const idx = source.indexOf('restore-and-show-exit-dialog')
    const nearbyBlock = source.slice(idx, idx + 600)
    expect(nearbyBlock).toContain('.setFocus()')
  })

  it('opens the exit dialog after restoring the window', () => {
    // Must set showExitDialog = true after re-showing the window
    const idx = source.indexOf('restore-and-show-exit-dialog')
    const nearbyBlock = source.slice(idx, idx + 600)
    expect(nearbyBlock).toContain('showExitDialog')
  })

  it('stores the unlisten function for cleanup', () => {
    // Must have a variable to store the unlisten function
    expect(source).toContain('unlistenRestoreExitDialog')
  })

  it('cleans up the listener in onUnmounted', () => {
    // Must call the unlisten function during component unmount
    const unmountedBlock = source.slice(source.indexOf('onUnmounted'))
    expect(unmountedBlock).toContain('unlistenRestoreExitDialog')
  })
})
