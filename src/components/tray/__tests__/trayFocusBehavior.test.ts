/**
 * @fileoverview Structural tests for the cross-platform custom tray menu.
 *
 * macOS/Windows use the custom Vue-based TrayMenu.vue popup, positioned
 * via cursor coordinates from TrayIconEvent::Click.position.  No native
 * OS menu is used.  Linux is excluded at compile time because
 * libappindicator does not emit TrayIconEvent::Click.
 *
 * Verifies:
 * 1. tray.rs — cursor-based positioning with screen-bounds clamping,
 *    no tauri-plugin-positioner, Linux isolation via cfg gates
 * 2. TrayMenu.vue — emits actions, auto-hides on blur
 * 3. MainLayout.vue — handles all tray-menu-action events
 * 4. trayMenuItems.ts — correct item definitions
 * 5. main.ts — tray-menu window skips heavy initialization
 * 6. Linux isolation — popup, positioning, and right-click handler gated
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TAURI_ROOT = path.resolve(__dirname, '../../../../src-tauri')
const SRC_ROOT = path.resolve(__dirname, '../../../..')

// ─── Test Group 1: tray.rs — cursor-based custom tray ───────────────

describe('tray.rs — cursor-based custom tray menu', () => {
  let traySource: string

  beforeAll(() => {
    traySource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'tray.rs'), 'utf-8')
  })

  describe('cursor-based positioning', () => {
    it('uses set_position for cursor-based popup positioning', () => {
      expect(traySource).toContain('set_position')
    })

    it('extracts position from TrayIconEvent::Click', () => {
      // The right-click handler must destructure the position field
      const rightClickBlock = extractClickBlock(traySource, 'MouseButton::Right')
      expect(rightClickBlock).toBeTruthy()
      // show_tray_popup must receive cursor coordinates
      expect(rightClickBlock).toContain('position')
      expect(rightClickBlock).toContain('show_tray_popup')
    })

    it('clamps popup to screen bounds', () => {
      // Must use .clamp() or equivalent to prevent off-screen overflow
      expect(traySource).toContain('.clamp(')
    })

    it('does NOT use tauri-plugin-positioner', () => {
      expect(traySource).not.toContain('tauri_plugin_positioner')
      expect(traySource).not.toContain('Position::TrayCenter')
      expect(traySource).not.toContain('move_window')
      expect(traySource).not.toContain('on_tray_event')
    })

    it('handles both top and bottom taskbar layouts', () => {
      // Must consider cursor Y position relative to screen height
      // to decide whether popup goes above or below the cursor
      const fnBody = extractFunctionBody(traySource, 'show_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('screen_h')
    })
  })

  describe('native menu: macOS/Windows skip, Linux required', () => {
    it('attaches .menu() only under cfg(target_os = "linux")', () => {
      // Linux: libappindicator requires a native menu for the tray icon to show.
      // macOS/Windows: use custom Vue popup instead.
      expect(traySource).toContain('.menu(')
      // The .menu() call must be inside a #[cfg(target_os = "linux")] block
      const menuIdx = traySource.indexOf('.menu(')
      expect(menuIdx).toBeGreaterThanOrEqual(0)
      const preceding = traySource.slice(Math.max(0, menuIdx - 500), menuIdx)
      expect(preceding).toContain('#[cfg(target_os = "linux")]')
    })
  })

  describe('popup lifecycle', () => {
    it('does NOT eagerly create popup at startup', () => {
      const setupStart = traySource.indexOf('pub fn setup_tray')
      const builderStart = traySource.indexOf('TrayIconBuilder::with_id')
      expect(setupStart).toBeGreaterThanOrEqual(0)
      expect(builderStart).toBeGreaterThanOrEqual(0)
      const between = traySource.slice(setupStart, builderStart)
      const codeLines = between.split('\n').filter((l) => !l.trim().startsWith('//'))
      expect(codeLines.join('\n')).not.toContain('ensure_tray_popup(')
    })

    it('creates popup lazily inside click handler (via show_tray_popup)', () => {
      const eventBlock = extractTrayIconEventBlock(traySource)
      expect(eventBlock).toBeTruthy()
      // show_tray_popup calls ensure_tray_popup internally
      expect(eventBlock).toContain('show_tray_popup')
    })

    it('popup starts hidden (visible=false)', () => {
      const fnBody = extractFunctionBody(traySource, 'ensure_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('.visible(false)')
    })

    it('popup has shadow disabled to prevent macOS water stain artifact', () => {
      const fnBody = extractFunctionBody(traySource, 'ensure_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('.shadow(false)')
    })

    it('popup accepts first mouse click without requiring prior focus (macOS)', () => {
      // On macOS, an unfocused window swallows the first click just to gain focus.
      // accept_first_mouse(true) makes buttons respond immediately on show.
      const fnBody = extractFunctionBody(traySource, 'ensure_tray_popup')
      expect(fnBody).toBeTruthy()
      expect(fnBody).toContain('.accept_first_mouse(true)')
    })
  })

  describe('left-click shows main window (all platforms)', () => {
    it('left-click handler shows and focuses main window', () => {
      const leftClickBlock = extractClickBlock(traySource, 'MouseButton::Left')
      expect(leftClickBlock).toBeTruthy()
      expect(leftClickBlock).toContain('window.show()')
      expect(leftClickBlock).toContain('window.set_focus()')
    })
  })

  describe('right-click handler', () => {
    it('calls show_tray_popup on right-click', () => {
      const rightClickBlock = extractClickBlock(traySource, 'MouseButton::Right')
      expect(rightClickBlock).toBeTruthy()
      expect(rightClickBlock).toContain('show_tray_popup')
    })
  })
})

// ─── Test Group 2: positioner plugin fully removed ──────────────────

describe('positioner plugin fully removed', () => {
  it('Cargo.toml does NOT contain positioner dependency', () => {
    const cargoToml = fs.readFileSync(path.join(TAURI_ROOT, 'Cargo.toml'), 'utf-8')
    expect(cargoToml).not.toContain('tauri-plugin-positioner')
  })

  it('lib.rs does NOT register positioner plugin', () => {
    const libSource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'lib.rs'), 'utf-8')
    expect(libSource).not.toContain('tauri_plugin_positioner')
  })
})

// ─── Test Group 2b: Linux isolation — popup excluded at compile time ─

describe('tray.rs — Linux isolation (cfg gates)', () => {
  let traySource: string

  beforeAll(() => {
    traySource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'tray.rs'), 'utf-8')
  })

  describe('ensure_tray_popup is gated for non-Linux only', () => {
    it('has #[cfg(not(target_os = "linux"))] before fn ensure_tray_popup', () => {
      const fnIdx = traySource.indexOf('fn ensure_tray_popup')
      expect(fnIdx).toBeGreaterThanOrEqual(0)
      // The cfg gate must appear in the 200 chars preceding the fn definition
      const preceding = traySource.slice(Math.max(0, fnIdx - 200), fnIdx)
      expect(preceding).toContain('#[cfg(not(target_os = "linux"))]')
    })
  })

  describe('show_tray_popup is gated for non-Linux only', () => {
    it('has #[cfg(not(target_os = "linux"))] before fn show_tray_popup', () => {
      const fnIdx = traySource.indexOf('fn show_tray_popup')
      expect(fnIdx).toBeGreaterThanOrEqual(0)
      const preceding = traySource.slice(Math.max(0, fnIdx - 200), fnIdx)
      expect(preceding).toContain('#[cfg(not(target_os = "linux"))]')
    })
  })

  describe('popup constants are gated for non-Linux only', () => {
    it('POPUP_WIDTH is gated with cfg(not(target_os = "linux"))', () => {
      const constIdx = traySource.indexOf('const POPUP_WIDTH')
      expect(constIdx).toBeGreaterThanOrEqual(0)
      const preceding = traySource.slice(Math.max(0, constIdx - 200), constIdx)
      expect(preceding).toContain('#[cfg(not(target_os = "linux"))]')
    })
  })

  describe('startup pre-creation is gated for non-Linux only', () => {
    it('ensure_tray_popup(app) call after builder.build is cfg-gated', () => {
      // The eager pre-creation at the end of setup_tray must be skipped on Linux
      const buildIdx = traySource.indexOf('builder.build(app)')
      expect(buildIdx).toBeGreaterThanOrEqual(0)
      const afterBuild = traySource.slice(buildIdx, buildIdx + 500)
      // Either the call itself or a block containing it must be cfg-gated
      expect(afterBuild).toContain('#[cfg(not(target_os = "linux"))]')
    })
  })

  describe('left-click handler has NO Linux gate (all platforms)', () => {
    it('left-click handler is NOT gated by cfg', () => {
      const leftClickIdx = traySource.indexOf('MouseButton::Left')
      expect(leftClickIdx).toBeGreaterThanOrEqual(0)
      const preceding = traySource.slice(Math.max(0, leftClickIdx - 300), leftClickIdx)
      // Must NOT be gated — left-click → show main window works everywhere
      expect(preceding).not.toContain('#[cfg(not(target_os = "linux"))]')
    })
  })
})

// ─── Test Group 2c: Linux native tray menu (libappindicator requirement) ──

describe('tray.rs — Linux native tray menu (libappindicator)', () => {
  let traySource: string

  beforeAll(() => {
    traySource = fs.readFileSync(path.join(TAURI_ROOT, 'src', 'tray.rs'), 'utf-8')
  })

  it('builds a Menu from existing MenuItems under cfg(target_os = "linux")', () => {
    // libappindicator requires a native OS menu for the icon to be visible.
    // The menu must be constructed with Menu::with_items using the same
    // MenuItem instances (show, new-task, resume-all, pause-all, quit).
    expect(traySource).toContain('Menu::with_items')
    const menuBuildIdx = traySource.indexOf('Menu::with_items')
    const preceding = traySource.slice(Math.max(0, menuBuildIdx - 500), menuBuildIdx)
    expect(preceding).toContain('#[cfg(target_os = "linux")]')
  })

  it('adds .on_menu_event() handler under cfg(target_os = "linux")', () => {
    // Native menu items need a click handler to emit actions
    expect(traySource).toContain('.on_menu_event(')
    const eventIdx = traySource.indexOf('.on_menu_event(')
    const preceding = traySource.slice(Math.max(0, eventIdx - 500), eventIdx)
    expect(preceding).toContain('#[cfg(target_os = "linux")]')
  })

  it('clones MenuItems so they can be used in both Menu and TrayMenuState', () => {
    // MenuItem must be cloned: one copy goes into Menu::with_items,
    // the other into the HashMap for dynamic label updates.
    expect(traySource).toContain('.clone()')
  })

  it('includes separators in the native menu (PredefinedMenuItem::separator)', () => {
    expect(traySource).toContain('PredefinedMenuItem::separator')
  })

  it('handles quit action in on_menu_event (exits the app)', () => {
    // The native menu quit handler must call app.exit or equivalent
    const menuEventBlock = extractMenuEventBlock(traySource)
    expect(menuEventBlock).toBeTruthy()
    expect(menuEventBlock).toContain('tray-quit')
  })
})

// ─── Test Group 3: MainLayout.vue — tray-menu-action handler ───────

describe('MainLayout.vue — tray-menu-action handler', () => {
  let mainLayoutSource: string

  beforeAll(() => {
    mainLayoutSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
  })

  it('listens for tray-menu-action event', () => {
    expect(mainLayoutSource).toContain("'tray-menu-action'")
  })

  const EXPECTED_ACTIONS = ['show', 'new-task', 'resume-all', 'pause-all', 'quit']

  for (const action of EXPECTED_ACTIONS) {
    it(`handles "${action}" action`, () => {
      const trayBlock = extractListenerBlock(mainLayoutSource, 'tray-menu-action')
      expect(trayBlock).toBeTruthy()
      expect(trayBlock).toContain(`'${action}'`)
    })
  }

  it('"new-task" calls show + setFocus before showAddTaskDialog', () => {
    const trayBlock = extractListenerBlock(mainLayoutSource, 'tray-menu-action')
    expect(trayBlock).toBeTruthy()
    const newTaskCase = extractCaseBlock(trayBlock!, "'new-task'")
    expect(newTaskCase).toBeTruthy()
    expect(newTaskCase).toContain('.show()')
    expect(newTaskCase).toContain('setFocus')
  })
})

// ─── Test Group 4: TrayMenu.vue — emission and auto-hide ───────────

describe('TrayMenu.vue — menu items and event emission', () => {
  let trayMenuSource: string

  beforeAll(() => {
    trayMenuSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'components', 'tray', 'TrayMenu.vue'), 'utf-8')
  })

  it('emits tray-menu-action on item click', () => {
    expect(trayMenuSource).toContain("emit('tray-menu-action'")
  })

  it('auto-hides popup after click', () => {
    expect(trayMenuSource).toContain('currentWindow.hide()')
  })

  it('closes on Escape key', () => {
    expect(trayMenuSource).toContain("e.key === 'Escape'")
  })

  it('closes on focus loss', () => {
    expect(trayMenuSource).toContain('onFocusChanged')
  })

  it('has focus-change delay guard to prevent race condition freeze', () => {
    // The popup must NOT respond to focus-loss immediately after showing.
    // Without a delay guard, macOS triggers onFocusChanged during show()
    // animation, causing hide/show thrashing and UI freeze.
    expect(trayMenuSource).toContain('focusGuardActive')
  })

  it('sets body background to transparent for proper window rendering', () => {
    // Without this, transparent Tauri window shows white body behind
    // the rounded-corner popup, creating a visible white rectangle.
    expect(trayMenuSource).toContain('background: transparent')
  })

  it('does NOT reference tauri-plugin-positioner', () => {
    expect(trayMenuSource).not.toContain('tauri-plugin-positioner')
  })
})

// ─── Test Group 5: main.ts — tray-menu window skip ─────────────────

describe('main.ts — tray-menu window skips heavy initialization', () => {
  let mainSource: string

  beforeAll(() => {
    mainSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'main.ts'), 'utf-8')
  })

  it('detects tray-menu window label to skip init', () => {
    // main.ts must check getCurrentWindow().label === 'tray-menu'
    // and skip all engine/store/clipboard initialization
    expect(mainSource).toContain("'tray-menu'")
  })

  it('returns early before heavy initialization for tray-menu window', () => {
    // The tray-menu guard must appear BEFORE preferenceStore.loadPreference()
    const trayMenuIdx = mainSource.indexOf("'tray-menu'")
    const loadPrefIdx = mainSource.indexOf('loadPreference')
    expect(trayMenuIdx).toBeGreaterThan(-1)
    expect(loadPrefIdx).toBeGreaterThan(-1)
    expect(trayMenuIdx).toBeLessThan(loadPrefIdx)
  })
})

// ─── Test Group 6: trayMenuItems.ts — completeness ──────────────────

describe('trayMenuItems.ts — menu item definitions', () => {
  let items: Array<{ type: string; id: string; labelKey?: string; icon?: string }>

  beforeAll(async () => {
    const mod = await import('../trayMenuItems')
    items = mod.TRAY_MENU_ITEMS
  })

  it('has exactly 7 entries (5 actions + 2 separators)', () => {
    expect(items).toHaveLength(7)
  })

  it('has correct action IDs in order', () => {
    const actionIds = items.filter((i) => i.type === 'item').map((i) => i.id)
    expect(actionIds).toEqual(['show', 'new-task', 'resume-all', 'pause-all', 'quit'])
  })

  it('all action items have labelKey and icon', () => {
    for (const item of items.filter((i) => i.type === 'item')) {
      expect(item.labelKey).toBeTruthy()
      expect(item.icon).toBeTruthy()
    }
  })

  it('quit has danger variant', () => {
    const quit = items.find((i) => i.id === 'quit')
    expect(quit).toBeTruthy()
    expect((quit as { variant?: string }).variant).toBe('danger')
  })
})

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract the entire on_tray_icon_event block */
function extractTrayIconEventBlock(source: string): string | null {
  // Use the chained method call form to avoid matching doc comments
  const idx = source.indexOf('.on_tray_icon_event(')
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(braceStart, end + 1)
}

/** Extract a MouseButton::X click handler block */
function extractClickBlock(source: string, button: string): string | null {
  const idx = source.indexOf(button)
  if (idx === -1) return null
  const arrowIdx = source.indexOf('=>', idx)
  if (arrowIdx === -1) return null
  const braceStart = source.indexOf('{', arrowIdx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(braceStart, end + 1)
}

/** Extract function body by name */
function extractFunctionBody(source: string, fnName: string): string | null {
  const idx = source.indexOf(`fn ${fnName}`)
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(braceStart, end + 1)
}

/** Extract event listener block from Vue source */
function extractListenerBlock(source: string, eventName: string): string | null {
  const needle = `'${eventName}'`
  const idx = source.indexOf(needle)
  if (idx === -1) return null
  const arrowIdx = source.indexOf('=>', idx)
  if (arrowIdx === -1) return null
  const braceStart = source.indexOf('{', arrowIdx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(braceStart, end + 1)
}

/** Extract a switch-case block */
function extractCaseBlock(source: string, caseValue: string): string | null {
  const needle = `case ${caseValue}:`
  const idx = source.indexOf(needle)
  if (idx === -1) return null
  const afterCase = source.slice(idx)
  const breakIdx = afterCase.indexOf('break')
  const nextCaseIdx = afterCase.indexOf('\n      case ', needle.length)
  let end: number
  if (breakIdx !== -1 && (nextCaseIdx === -1 || breakIdx < nextCaseIdx)) {
    end = breakIdx + 'break'.length
  } else if (nextCaseIdx !== -1) {
    end = nextCaseIdx
  } else {
    end = afterCase.length
  }
  return afterCase.slice(0, end)
}

/** Extract .on_menu_event() handler block from Rust source */
function extractMenuEventBlock(source: string): string | null {
  const idx = source.indexOf('.on_menu_event(')
  if (idx === -1) return null
  const braceStart = source.indexOf('{', idx)
  if (braceStart === -1) return null
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) {
      end = i
      break
    }
  }
  return source.slice(braceStart, end + 1)
}
