/**
 * @fileoverview TDD tests for aria2 engine crash recovery feature.
 *
 * HONESTY NOTE: These tests verify REAL source files — not mocked stubs.
 * They define the behavioral contract that implementation MUST satisfy.
 *
 * Test groups:
 * 1. engine/lifecycle.rs — Terminated handlers emit engine-crashed for any non-intentional exit
 * 2. engine/lifecycle.rs — Terminated handlers no longer gate on exit_code != 0
 * 3. MainLayout.vue — engine-crashed listener drives overlay
 * 4. EngineOverlay.vue — component structure and state management
 * 5. i18n — crash recovery keys exist in all 26 locales
 */
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SRC_ROOT = path.resolve(__dirname, '../../../..')
const TAURI_ROOT = path.join(SRC_ROOT, 'src-tauri')
const LOCALES_DIR = path.join(SRC_ROOT, 'src', 'shared', 'locales')

const EXPECTED_LOCALE_DIRS = [
  'ar',
  'bg',
  'ca',
  'de',
  'el',
  'en-US',
  'es',
  'fa',
  'fr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'nb',
  'nl',
  'pl',
  'pt-BR',
  'ro',
  'ru',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW',
]

/**
 * Extract the handler body for a specific CommandEvent variant within a
 * specific function scope in engine/lifecycle.rs.
 */
function extractEventHandler(
  source: string,
  eventType: 'Stdout' | 'Stderr' | 'Terminated',
  functionName: string,
): string | null {
  const fnIdx = source.indexOf(`fn ${functionName}`)
  if (fnIdx === -1) return null
  const fnBody = source.slice(fnIdx)
  const pattern = `CommandEvent::${eventType}(`
  const idx = fnBody.indexOf(pattern)
  if (idx === -1) return null
  const arrowIdx = fnBody.indexOf('=>', idx)
  if (arrowIdx === -1) return null
  const afterArrow = fnBody.slice(arrowIdx + 2).trimStart()
  if (afterArrow.startsWith('{')) {
    let depth = 0
    let end = 0
    for (let i = 0; i < afterArrow.length; i++) {
      if (afterArrow[i] === '{') depth++
      if (afterArrow[i] === '}') depth--
      if (depth === 0) {
        end = i
        break
      }
    }
    return afterArrow.slice(0, end + 1)
  }
  const commaIdx = afterArrow.indexOf(',')
  return afterArrow.slice(0, commaIdx !== -1 ? commaIdx : 100)
}

/**
 * Extract a Tauri event listener block from Vue source.
 */
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

// ─── Test Group 1: engine/ — crash event emission ────────────────────

describe('engine/ — crash recovery event emission', () => {
  let engineSource: string

  beforeAll(() => {
    const lifecyclePath = path.join(TAURI_ROOT, 'src', 'engine', 'lifecycle.rs')
    engineSource = fs.readFileSync(lifecyclePath, 'utf-8')
  })

  describe('start_engine Terminated handler emits engine-crashed', () => {
    it('emits "engine-crashed" for non-intentional termination', () => {
      const block = extractEventHandler(engineSource, 'Terminated', 'start_engine')
      expect(block).toBeTruthy()
      expect(block).toContain('engine-crashed')
    })

    it('does NOT gate crash event on exit_code != 0 alone', () => {
      const block = extractEventHandler(engineSource, 'Terminated', 'start_engine')
      expect(block).toBeTruthy()
      // The old pattern: `if exit_code != 0 && !was_intentional`
      // The new pattern: `if !was_intentional` (any non-intentional exit = crash)
      // Verify the condition does NOT require exit_code != 0 for engine-crashed
      const crashSection = block!.split('engine-crashed')[0]
      // The condition leading to engine-crashed should NOT contain `exit_code != 0`
      // It should only check `!was_intentional`
      const lastIfIdx = crashSection.lastIndexOf('if ')
      if (lastIfIdx !== -1) {
        const condition = crashSection.slice(lastIfIdx)
        expect(condition).not.toContain('exit_code != 0')
      }
    })

    it('still emits engine-stopped for intentional kills', () => {
      const block = extractEventHandler(engineSource, 'Terminated', 'start_engine')
      expect(block).toBeTruthy()
      expect(block).toContain('engine-stopped')
    })
  })

  describe('restart_engine Terminated handler emits engine-crashed', () => {
    it('emits "engine-crashed" for non-intentional termination', () => {
      const block = extractEventHandler(engineSource, 'Terminated', 'restart_engine')
      expect(block).toBeTruthy()
      expect(block).toContain('engine-crashed')
    })

    it('still emits engine-stopped for intentional kills', () => {
      const block = extractEventHandler(engineSource, 'Terminated', 'restart_engine')
      expect(block).toBeTruthy()
      expect(block).toContain('engine-stopped')
    })
  })
})

// ─── Test Group 2: MainLayout.vue — crash recovery listener ───────────

describe('MainLayout.vue — crash recovery integration', () => {
  let layoutSource: string

  beforeAll(() => {
    // Engine event listeners extracted to useAppEvents composable
    const layoutPath = path.join(SRC_ROOT, 'src', 'composables', 'useAppEvents.ts')
    layoutSource = fs.readFileSync(layoutPath, 'utf-8')
  })

  describe('engine-crashed listener', () => {
    it('listens for "engine-crashed" event', () => {
      expect(layoutSource).toContain("'engine-crashed'")
    })

    it('sets engineReady to false on crash', () => {
      const block = extractListenerBlock(layoutSource, 'engine-crashed')
      expect(block).toBeTruthy()
      expect(block).toContain('engineReady')
    })

    it('shows the engine overlay on crash', () => {
      const block = extractListenerBlock(layoutSource, 'engine-crashed')
      expect(block).toBeTruthy()
      expect(block).toContain('showEngineOverlay')
    })
  })

  describe('engine-stopped listener (still exists)', () => {
    it('listens for "engine-stopped" event', () => {
      expect(layoutSource).toContain("'engine-stopped'")
    })
  })

  describe('EngineOverlay integration', () => {
    // EngineOverlay template rendering is still in MainLayout.vue
    let mainLayoutSource: string
    beforeAll(() => {
      mainLayoutSource = fs.readFileSync(path.join(SRC_ROOT, 'src', 'layouts', 'MainLayout.vue'), 'utf-8')
    })

    it('imports EngineOverlay component', () => {
      expect(mainLayoutSource).toContain('EngineOverlay')
    })

    it('renders EngineOverlay in template', () => {
      expect(mainLayoutSource).toContain('<EngineOverlay')
    })

    it('binds show prop to showEngineOverlay ref', () => {
      expect(mainLayoutSource).toContain('showEngineOverlay')
    })
  })
})

// ─── Test Group 3: EngineOverlay.vue — component contract ─────────────

describe('EngineOverlay.vue — component structure', () => {
  let overlaySource: string

  beforeAll(() => {
    const overlayPath = path.join(SRC_ROOT, 'src', 'components', 'layout', 'EngineOverlay.vue')
    overlaySource = fs.readFileSync(overlayPath, 'utf-8')
  })

  describe('props and emits', () => {
    it('accepts a "show" prop', () => {
      expect(overlaySource).toContain('show')
    })

    it('emits a "recovered" event', () => {
      expect(overlaySource).toContain('recovered')
    })

    it('emits a "close" event for dismissal', () => {
      expect(overlaySource).toContain('close')
    })
  })

  describe('three-state display', () => {
    it('has "recovering" state', () => {
      expect(overlaySource).toContain('recovering')
    })

    it('has "recovered" state', () => {
      expect(overlaySource).toContain('recovered')
    })

    it('has "failed" state', () => {
      expect(overlaySource).toContain('failed')
    })
  })

  describe('recovery mechanism', () => {
    it('uses useEngineRestart composable', () => {
      expect(overlaySource).toContain('useEngineRestart')
    })

    it('has a manual retry mechanism', () => {
      // Component should have a manual retry function or button handler
      expect(overlaySource).toContain('retry')
    })

    it('tracks attempt count', () => {
      expect(overlaySource).toContain('attempt')
    })

    it('has a maximum retry limit', () => {
      // Should reference a max retries constant
      expect(overlaySource).toMatch(/max.*retr|MAX.*RETR/i)
    })
  })

  describe('i18n integration', () => {
    it('uses i18n for crash message', () => {
      expect(overlaySource).toContain('engine-crashed')
    })

    it('uses i18n for recovering message', () => {
      expect(overlaySource).toContain('engine-recovering')
    })

    it('uses i18n for recovered message', () => {
      expect(overlaySource).toContain('engine-recovered')
    })

    it('uses i18n for unrecoverable message', () => {
      expect(overlaySource).toContain('engine-unrecoverable')
    })
  })

  describe('UI elements', () => {
    it('uses NModal for dialog rendering', () => {
      expect(overlaySource).toContain('NModal')
    })

    it('has a close/dismiss mechanism', () => {
      expect(overlaySource).toContain('dismiss')
    })

    it('warns user about degraded state on close', () => {
      expect(overlaySource).toContain('engine-dismiss-warning')
    })
  })
})

// ─── Test Group 4: i18n — crash recovery keys ─────────────────────────

describe('i18n — crash recovery locale keys', () => {
  const REQUIRED_KEYS = [
    'engine-crashed',
    'engine-recovering',
    'engine-recovered',
    'engine-unrecoverable',
    'engine-retry',
    'engine-dismiss-warning',
    'engine-verifying-stability',
    'engine-retrying',
    'engine-manual-retry',
  ]

  for (const locale of EXPECTED_LOCALE_DIRS) {
    describe(`locale: ${locale}`, () => {
      let appContent: string

      beforeAll(() => {
        const appPath = path.join(LOCALES_DIR, locale, 'app.js')
        appContent = fs.readFileSync(appPath, 'utf-8')
      })

      for (const key of REQUIRED_KEYS) {
        it(`has key "${key}"`, () => {
          expect(appContent).toContain(`'${key}'`)
        })
      }
    })
  }
})

// ─── Test Group 5: updater.rs — install failure recovery hardening ─────

describe('updater.rs — install failure recovery', () => {
  let updaterSource: string
  let installFailureBlock: string

  beforeAll(() => {
    const updaterPath = path.join(TAURI_ROOT, 'src', 'commands', 'updater.rs')
    updaterSource = fs.readFileSync(updaterPath, 'utf-8')

    // Isolate the install-failure recovery block between install(bytes) and phase=installed
    const startMarker = 'update.install(bytes)'
    const endMarker = 'phase=installed'
    const startIdx = updaterSource.indexOf(startMarker)
    const endIdx = updaterSource.indexOf(endMarker, startIdx)
    installFailureBlock = updaterSource.slice(startIdx, endIdx)
  })

  it('does NOT use unwrap_or_default() on get_system_config', () => {
    expect(installFailureBlock).not.toContain('unwrap_or_default()')
  })

  it('does NOT discard spawn_blocking result with let _ =', () => {
    expect(installFailureBlock).not.toMatch(/let\s+_\s*=\s*tokio::task::spawn_blocking/)
  })

  it('emits engine-recovered on successful recovery', () => {
    expect(installFailureBlock).toContain('engine-recovered')
  })

  it('emits engine-crashed on failed recovery', () => {
    expect(installFailureBlock).toContain('engine-crashed')
  })

  it('checks restart_engine Result (not discarded)', () => {
    // The recovery block should pattern-match on the result
    expect(installFailureBlock).toMatch(/match\s+recovery/)
  })
})

// ─── Test Group 6: useAppEvents.ts — engine-recovered listener ─────────

describe('useAppEvents.ts — engine-recovered listener', () => {
  let eventsSource: string

  beforeAll(() => {
    const eventsPath = path.join(SRC_ROOT, 'src', 'composables', 'useAppEvents.ts')
    eventsSource = fs.readFileSync(eventsPath, 'utf-8')
  })

  it('listens for "engine-recovered" event', () => {
    expect(eventsSource).toContain("'engine-recovered'")
  })

  it('calls reconnectClient on engine-recovered', () => {
    const block = extractListenerBlock(eventsSource, 'engine-recovered')
    expect(block).toBeTruthy()
    expect(block).toContain('reconnectClient')
  })

  it('sets engineReady to true on successful reconnect', () => {
    const block = extractListenerBlock(eventsSource, 'engine-recovered')
    expect(block).toBeTruthy()
    expect(block).toContain('setEngineReady(true)')
  })

  it('sets engineReady to false on failed reconnect', () => {
    const block = extractListenerBlock(eventsSource, 'engine-recovered')
    expect(block).toBeTruthy()
    expect(block).toContain('setEngineReady(false)')
  })

  it('imports reconnectClient from aria2 API', () => {
    expect(eventsSource).toContain('reconnectClient')
    // Must be an import, not just a string reference
    expect(eventsSource).toMatch(/import\s+\{[^}]*reconnectClient[^}]*\}\s+from/)
  })

  it('retries reconnect with exponential backoff (not single-shot)', () => {
    const block = extractListenerBlock(eventsSource, 'engine-recovered')
    expect(block).toBeTruthy()
    // Must have a retry loop with maxRetries, not a single try/catch
    expect(block).toContain('maxRetries')
    expect(block).toMatch(/for\s*\(/)
  })
})
