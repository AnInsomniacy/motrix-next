/**
 * @fileoverview Structural tests for the "Hide Dock Icon on Minimize" feature.
 *
 * The feature involves three separate code paths that hide the main window,
 * each of which must call `set_dock_visible` before hiding. The Rust command
 * reads the `hideDockOnMinimize` preference from the persistent store (not
 * from JS in-memory state) and only sets `ActivationPolicy::Accessory` when
 * the user has opted in.
 *
 * Tests follow the project's structural source-code analysis pattern
 * (see trayFocusBehavior.test.ts) — reading source files and asserting
 * that critical code patterns are present.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '../../../..')
const TAURI_ROOT = path.resolve(SRC_ROOT, 'src-tauri')

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extracts a function body from source code (brace-balanced extraction).
 * Returns the content between the opening `{` and its matching `}`.
 */
function extractFunctionBody(source: string, fnSignature: string): string | null {
  const start = source.indexOf(fnSignature)
  if (start === -1) return null
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) return null
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    if (depth === 0) return source.slice(braceStart, i + 1)
  }
  return null
}

/**
 * Asserts that `needle` appears before `after` in the given source string.
 * Used to verify call ordering (e.g. set_dock_visible before hide).
 */
function assertOrderedBefore(source: string, needle: string, after: string, context: string): void {
  const needleIdx = source.indexOf(needle)
  const afterIdx = source.indexOf(after, needleIdx)
  expect(needleIdx, `${context}: "${needle}" must exist`).toBeGreaterThanOrEqual(0)
  expect(afterIdx, `${context}: "${after}" must exist`).toBeGreaterThanOrEqual(0)
  expect(needleIdx, `${context}: "${needle}" must appear before "${after}"`).toBeLessThan(afterIdx)
}

// ═══════════════════════════════════════════════════════════════════
// Group 1: WindowControls.vue — custom ✕ button Dock hide
// ═══════════════════════════════════════════════════════════════════

describe('WindowControls.vue — Dock hide on custom close button', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(SRC_ROOT, 'src', 'components', 'layout', 'WindowControls.vue'), 'utf-8')
  })

  it('close() is an async function (required for await invoke)', () => {
    expect(source).toContain('async function close()')
  })

  it('invokes set_dock_visible when minimizeToTrayOnClose is true', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')
    expect(closeBody).toBeTruthy()
    expect(closeBody).toContain("invoke('set_dock_visible'")
  })

  it('calls set_dock_visible BEFORE appWindow.hide()', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')!
    assertOrderedBefore(closeBody, "invoke('set_dock_visible'", 'appWindow.hide()', 'WindowControls.close()')
  })

  it('emits close event to parent when minimize-to-tray is disabled', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')
    expect(closeBody).toBeTruthy()
    // Must NOT call appWindow.close() — causes webview freeze on macOS (Tauri v2 bug).
    // Instead emits 'close' to the parent component which shows the exit dialog.
    expect(closeBody).not.toContain('appWindow.close()')
    expect(closeBody).toContain("emit('close')")
  })

  it('passes { visible: false } to set_dock_visible', () => {
    const closeBody = extractFunctionBody(source, 'async function close()')
    expect(closeBody).toBeTruthy()
    expect(closeBody).toContain('{ visible: false }')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 2: MainLayout.vue — onCloseRequested + exit dialog paths
// ═══════════════════════════════════════════════════════════════════

describe('MainLayout.vue — Dock hide on window close paths', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
  })

  describe('onCloseRequested direct hide path', () => {
    it('invokes set_dock_visible in the minimizeToTrayOnClose branch', () => {
      // The onCloseRequested handler checks minimizeToTrayOnClose and calls
      // set_dock_visible as a Rust command. Assert this pattern exists.
      const handlerStart = source.indexOf('onCloseRequested(async')
      expect(handlerStart).toBeGreaterThanOrEqual(0)
      const handlerBody = extractFunctionBody(source, 'onCloseRequested(async')
      expect(handlerBody).toBeTruthy()
      expect(handlerBody).toContain("invoke('set_dock_visible'")
    })

    it('calls set_dock_visible BEFORE appWindow.hide() in direct path', () => {
      const handlerBody = extractFunctionBody(source, 'onCloseRequested(async')!
      // Within the minimizeToTrayOnClose branch, set_dock_visible must precede hide
      const branchStart = handlerBody.indexOf('minimizeToTrayOnClose')
      const branchSlice = handlerBody.slice(branchStart)
      assertOrderedBefore(branchSlice, "invoke('set_dock_visible'", 'appWindow.hide()', 'onCloseRequested direct path')
    })
  })

  describe('onExitDialogAfterLeave path', () => {
    it('invokes set_dock_visible in exit dialog after-leave handler', () => {
      const fnBody = extractFunctionBody(source, 'async function onExitDialogAfterLeave()')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain("invoke('set_dock_visible'")
    })

    it('calls set_dock_visible BEFORE appWindow.hide()', () => {
      const fnBody = extractFunctionBody(source, 'async function onExitDialogAfterLeave()')!
      assertOrderedBefore(fnBody, "invoke('set_dock_visible'", 'appWindow.hide()', 'onExitDialogAfterLeave')
    })
  })

  describe('exit dialog rememberChoice synchronization', () => {
    it('syncs rememberChoice from minimizeToTrayOnClose when dialog opens via onCloseRequested', () => {
      const handlerBody = extractFunctionBody(source, 'onCloseRequested(async')!
      // The dialog path (non-minimize) should set rememberChoice before showing dialog
      expect(handlerBody).toContain('rememberChoice.value = !!preferenceStore.config.minimizeToTrayOnClose')
    })

    it('tray quit calls handleExitConfirm directly (no dialog, no rememberChoice)', () => {
      // Tray quit bypasses the exit dialog entirely — it calls
      // handleExitConfirm() directly, matching industry standard behavior
      // (Discord, Telegram, Steam). No rememberChoice sync is needed.
      // Tray-menu-action handler is inline in useAppEvents module.
      const eventsSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'composables', 'useAppEvents.ts'), 'utf-8')
      const quitIdx = eventsSource.indexOf("case 'quit':")
      expect(quitIdx).toBeGreaterThanOrEqual(0)
      const quitBlock = eventsSource.slice(quitIdx, eventsSource.indexOf('break', quitIdx) + 10)
      expect(quitBlock).toContain('handleExitConfirm')
      expect(quitBlock).not.toContain('showExitDialog')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 3: commands/app.rs — Rust set_dock_visible command
// ═══════════════════════════════════════════════════════════════════

describe('commands/app.rs — set_dock_visible Rust command', () => {
  let source: string
  let fnBody: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'commands', 'app.rs'), 'utf-8')
    fnBody = extractFunctionBody(source, 'pub fn set_dock_visible')!
  })

  it('is a #[tauri::command]', () => {
    const fnIdx = source.indexOf('pub fn set_dock_visible')
    const preceding = source.slice(Math.max(0, fnIdx - 100), fnIdx)
    expect(preceding).toContain('#[tauri::command]')
  })

  it('accepts (app: AppHandle, visible: bool) parameters', () => {
    expect(source).toContain('pub fn set_dock_visible(app: AppHandle, visible: bool)')
  })

  it('wraps macOS logic in #[cfg(target_os = "macos")]', () => {
    expect(fnBody).toContain('#[cfg(target_os = "macos")]')
  })

  it('has a #[cfg(not(target_os = "macos"))] no-op branch', () => {
    expect(fnBody).toContain('#[cfg(not(target_os = "macos"))]')
  })

  it('reads hideDockOnMinimize from the persistent store when hiding', () => {
    // When visible=false, must read the preference from store, not from JS
    expect(fnBody).toContain('.store("config.json")')
    expect(fnBody).toContain('"hideDockOnMinimize"')
  })

  it('sets ActivationPolicy::Regular when visible=true', () => {
    expect(fnBody).toContain('ActivationPolicy::Regular')
  })

  it('sets ActivationPolicy::Accessory when hiding and preference is true', () => {
    expect(fnBody).toContain('ActivationPolicy::Accessory')
  })

  it('does NOT unconditionally set Accessory — checks hide_dock first', () => {
    // The Accessory policy must be behind an `if hide_dock` guard
    const accessoryIdx = fnBody.indexOf('ActivationPolicy::Accessory')
    const beforeAccessory = fnBody.slice(0, accessoryIdx)
    expect(beforeAccessory).toContain('if hide_dock')
  })

  it('uses StoreExt for store access', () => {
    expect(fnBody).toContain('StoreExt')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Group 4: lib.rs — on_window_event close interception + Reopen restore
//
// CloseRequested is handled in Builder::on_window_event() — the FIRST
// hook in Tauri's event lifecycle — rather than the later RunEvent
// callback.  This guarantees api.prevent_close() fires before the
// compositor can destroy the window on all platforms (critical for
// Linux/Wayland + decorations:false).
// ═══════════════════════════════════════════════════════════════════

describe('lib.rs — on_window_event close interception', () => {
  let source: string

  beforeAll(() => {
    source = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
  })

  describe('Architecture: CloseRequested is in on_window_event, NOT handle_run_event', () => {
    it('registers .on_window_event() on the Builder chain', () => {
      expect(source).toContain('.on_window_event(')
    })

    it('handles CloseRequested inside on_window_event', () => {
      const onWinEventStart = source.indexOf('.on_window_event(')
      expect(onWinEventStart).toBeGreaterThanOrEqual(0)
      // Extract on_window_event body
      const onWinBody = extractFunctionBody(source, '.on_window_event(')
      expect(onWinBody).toBeTruthy()
      expect(onWinBody).toContain('CloseRequested')
    })

    it('does NOT handle CloseRequested in handle_run_event', () => {
      const runEventBody = extractFunctionBody(source, 'fn handle_run_event')
      expect(runEventBody).toBeTruthy()
      expect(runEventBody).not.toContain('CloseRequested')
    })
  })

  describe('on_window_event CloseRequested handler', () => {
    let onWinBody: string

    beforeAll(() => {
      onWinBody = extractFunctionBody(source, '.on_window_event(')!
    })

    it('calls api.prevent_close() unconditionally for the main window', () => {
      expect(onWinBody).toContain('api.prevent_close()')
    })

    it('only intercepts the "main" window', () => {
      expect(onWinBody).toContain('window.label() != "main"')
    })

    it('reads minimizeToTrayOnClose from the persistent store', () => {
      expect(onWinBody).toContain('"minimizeToTrayOnClose"')
    })

    it('reads hideDockOnMinimize from the persistent store', () => {
      expect(onWinBody).toContain('"hideDockOnMinimize"')
    })

    it('reads both preferences from a single store access (no redundant reads)', () => {
      const storeReads = onWinBody.split('.store("config.json")').length - 1
      expect(storeReads).toBe(1)
    })

    it('hides the window when should_hide is true', () => {
      expect(onWinBody).toContain('window.hide()')
    })

    it('wraps set_activation_policy(Accessory) in cfg(target_os = "macos")', () => {
      expect(onWinBody).toContain('#[cfg(target_os = "macos")]')
      expect(onWinBody).toContain('ActivationPolicy::Accessory')
    })

    it('emits show-exit-dialog when minimize-to-tray is disabled', () => {
      expect(onWinBody).toContain('app.emit("show-exit-dialog"')
    })

    it('on_window_event is registered BEFORE .setup() in the Builder chain', () => {
      const onWinIdx = source.indexOf('.on_window_event(')
      // Use '.setup(|app|' to match the Builder chain call, not the
      // standalone setup_app function definition earlier in the file.
      const setupIdx = source.indexOf('.setup(|app|')
      expect(onWinIdx).toBeGreaterThanOrEqual(0)
      expect(setupIdx).toBeGreaterThanOrEqual(0)
      expect(onWinIdx).toBeLessThan(setupIdx)
    })
  })

  describe('handle_run_event — cleanup and Reopen', () => {
    it('documents that CloseRequested is handled by on_window_event', () => {
      // The doc comment above handle_run_event should reference on_window_event
      const fnStart = source.indexOf('fn handle_run_event')
      const docBlock = source.slice(Math.max(0, fnStart - 600), fnStart)
      expect(docBlock).toContain('on_window_event')
    })

    it('handles RunEvent::Exit for engine + UPnP cleanup', () => {
      const runEventBody = extractFunctionBody(source, 'fn handle_run_event')!
      expect(runEventBody).toContain('RunEvent::Exit')
      expect(runEventBody).toContain('stop_engine')
      expect(runEventBody).toContain('stop_mapping')
    })

    it('handles RunEvent::Reopen on macOS', () => {
      expect(source).toContain('tauri::RunEvent::Reopen')
    })

    it('restores ActivationPolicy::Regular on Reopen', () => {
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      expect(reopenIdx).toBeGreaterThanOrEqual(0)
      const reopenBlock = source.slice(reopenIdx, source.indexOf('}', reopenIdx + 200))
      expect(reopenBlock).toContain('ActivationPolicy::Regular')
    })

    it('shows and focuses the main window on Reopen', () => {
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      const reopenBlock = source.slice(reopenIdx, source.indexOf('}', reopenIdx + 200))
      expect(reopenBlock).toContain('window.show()')
      expect(reopenBlock).toContain('window.set_focus()')
    })

    it('Reopen handler is gated to macOS only', () => {
      const reopenIdx = source.indexOf('RunEvent::Reopen')
      const preceding = source.slice(Math.max(0, reopenIdx - 100), reopenIdx)
      expect(preceding).toContain('#[cfg(target_os = "macos")]')
    })
  })
})
