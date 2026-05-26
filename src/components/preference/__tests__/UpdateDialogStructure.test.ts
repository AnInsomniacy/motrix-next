/**
 * @fileoverview Structural tests for UpdateDialog.vue.
 *
 * Verifies critical error-handling patterns by inspecting the component
 * source code directly. This approach avoids the need for a full Tauri
 * runtime while still enforcing code-quality invariants.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(process.cwd(), 'src/components/preference/UpdateDialog.vue'), 'utf-8')

// ── handleInstallAndRelaunch error handling ─────────────────────────

describe('handleInstallAndRelaunch error handling', () => {
  /** Extract the function body for targeted assertions. */
  function extractFunctionBody(fnName: string): string {
    const start = SOURCE.indexOf(`function ${fnName}`)
    if (start === -1) throw new Error(`${fnName} not found in source`)
    // Walk forward to find the matching closing brace
    let depth = 0
    let bodyStart = -1
    for (let i = start; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') {
        if (bodyStart === -1) bodyStart = i
        depth++
      } else if (SOURCE[i] === '}') {
        depth--
        if (depth === 0) return SOURCE.slice(bodyStart, i + 1)
      }
    }
    throw new Error(`Could not find closing brace for ${fnName}`)
  }

  it('wraps apply_update invoke in a try block', () => {
    const body = extractFunctionBody('handleInstallAndRelaunch')
    expect(body).toContain('try')
    expect(body).toContain('apply_update')
  })

  it('catches errors and transitions to error phase', () => {
    const body = extractFunctionBody('handleInstallAndRelaunch')
    expect(body).toContain('catch')
    // Must set phase to 'error' on failure — otherwise dialog locks
    expect(body).toContain("phase.value = 'error'")
  })

  it('sets errorMsg before transitioning to error phase', () => {
    const body = extractFunctionBody('handleInstallAndRelaunch')
    expect(body).toContain('formatUpdateError')
    expect(body).toContain('errorMsg.value')
  })

  it('only calls relaunch inside the try block, not after it', () => {
    const body = extractFunctionBody('handleInstallAndRelaunch')
    const tryIndex = body.indexOf('try')
    const catchIndex = body.indexOf('catch')
    const relaunchIndex = body.indexOf('relaunch()')

    expect(tryIndex).toBeGreaterThanOrEqual(0)
    expect(catchIndex).toBeGreaterThan(tryIndex)
    expect(relaunchIndex).toBeGreaterThan(tryIndex)
    // relaunch MUST be inside try (before catch), not after catch
    expect(relaunchIndex).toBeLessThan(catchIndex)
  })
})

// ── startDownload already has error handling (regression guard) ──────

describe('startDownload error handling (regression)', () => {
  it('has try/catch around download_update invoke', () => {
    const start = SOURCE.indexOf('function startDownload')
    expect(start).toBeGreaterThanOrEqual(0)
    const snippet = SOURCE.slice(start, start + 1200)
    expect(snippet).toContain('try')
    expect(snippet).toContain('catch')
  })

  it('uses the structured download result instead of assuming any success means ready', () => {
    const start = SOURCE.indexOf('async function startDownload')
    expect(start).toBeGreaterThanOrEqual(0)
    const snippet = SOURCE.slice(start, start + 1400)
    expect(snippet).toContain('resolvePhaseAfterDownload')
  })
})

describe('all-channel latest update channel handling', () => {
  it('stores the resolved release channel before downloading', () => {
    const start = SOURCE.indexOf('async function open')
    expect(start).toBeGreaterThanOrEqual(0)
    const snippet = SOURCE.slice(start, start + 1800)
    expect(snippet).toContain('update.channel')
    expect(snippet).toContain('activeChannel.value')
  })

  it('keeps the requested channel available for the dialog label', () => {
    expect(SOURCE).toContain('requestedChannel')
    expect(SOURCE).toContain('displayChannel')
  })
})

// ── open function error handling (regression guard) ──────────────────

describe('open function error handling (regression)', () => {
  it('has try/catch around check_for_update invoke', () => {
    const start = SOURCE.indexOf('async function open')
    expect(start).toBeGreaterThanOrEqual(0)
    // Use brace-matching to extract the full function body instead of a
    // fragile fixed-width character window that breaks on line reordering.
    let depth = 0
    let bodyStart = -1
    let snippet = ''
    for (let i = start; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') {
        if (bodyStart === -1) bodyStart = i
        depth++
      } else if (SOURCE[i] === '}') {
        depth--
        if (depth === 0) {
          snippet = SOURCE.slice(start, i + 1)
          break
        }
      }
    }
    expect(snippet).toContain('try')
    expect(snippet).toContain('catch')
    expect(snippet).toContain("phase.value = 'error'")
  })
})

describe('close behavior during protected phases', () => {
  it('disables modal close affordances via a shared helper', () => {
    expect(SOURCE).toContain('shouldAllowUpdateDialogClose')
  })

  it('guards the custom header close button during installing/downloading', () => {
    const closeStart = SOURCE.indexOf('function close()')
    expect(closeStart).toBeGreaterThanOrEqual(0)
    const closeSnippet = SOURCE.slice(closeStart, closeStart + 400)
    expect(closeSnippet).toContain('shouldAllowUpdateDialogClose')
  })
})

// ── lastCheckUpdateTime write placement (code review fix) ────────────

describe('lastCheckUpdateTime write placement in open()', () => {
  /** Extract the open() function body for targeted assertions. */
  function extractOpenBody(): string {
    const start = SOURCE.indexOf('async function open')
    if (start === -1) throw new Error('open() not found in source')
    let depth = 0
    let bodyStart = -1
    for (let i = start; i < SOURCE.length; i++) {
      if (SOURCE[i] === '{') {
        if (bodyStart === -1) bodyStart = i
        depth++
      } else if (SOURCE[i] === '}') {
        depth--
        if (depth === 0) return SOURCE.slice(bodyStart, i + 1)
      }
    }
    throw new Error('Could not find closing brace for open()')
  }

  it('writes lastCheckUpdateTime inside the try block, not in finally', () => {
    const body = extractOpenBody()
    // The timestamp write must exist somewhere in open()
    expect(body).toContain('lastCheckUpdateTime')
    // It must NOT be inside a finally block — that would suppress
    // future auto-checks after a failed manual check.
    expect(body).not.toMatch(/finally\s*\{[^}]*lastCheckUpdateTime/)
  })

  it('writes lastCheckUpdateTime after the successful check result', () => {
    const body = extractOpenBody()
    const tryIndex = body.indexOf('try')
    const catchIndex = body.indexOf('catch')
    const writeIndex = body.indexOf('lastCheckUpdateTime')

    expect(tryIndex).toBeGreaterThanOrEqual(0)
    expect(catchIndex).toBeGreaterThan(tryIndex)
    // The write must be between try and catch (inside try block)
    expect(writeIndex).toBeGreaterThan(tryIndex)
    expect(writeIndex).toBeLessThan(catchIndex)
  })
})
