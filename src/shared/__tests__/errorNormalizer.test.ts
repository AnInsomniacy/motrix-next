/** @fileoverview Unit tests for errorNormalizer — the pure error normalization utility. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeError, normalizeTaskError, errorDedupeKey } from '@shared/errorNormalizer'
import type { ErrorCategory, NormalizedError } from '@shared/errorNormalizer'

// ── extractRawMessage (tested via normalizeError) ────────────────────

describe('extractRawMessage (via normalizeError)', () => {
  it('extracts message from Error object', () => {
    const result = normalizeError(new Error('something broke'))
    expect(result.rawMessage).toBe('something broke')
  })

  it('uses string directly', () => {
    const result = normalizeError('plain error string')
    expect(result.rawMessage).toBe('plain error string')
  })

  it('extracts from Rust AppError { Engine: "msg" }', () => {
    const result = normalizeError({ Engine: 'aria2 crashed' })
    expect(result.rawMessage).toBe('aria2 crashed')
  })

  it('extracts from Rust AppError { Config: "msg" }', () => {
    const result = normalizeError({ Config: 'invalid value' })
    expect(result.rawMessage).toBe('invalid value')
  })

  it('extracts from JSON-RPC error { code, message }', () => {
    const result = normalizeError({ code: -32600, message: 'Invalid Request' })
    expect(result.rawMessage).toBe('Invalid Request')
  })

  it('JSON-stringifies non-serializable objects', () => {
    const result = normalizeError({ foo: 123, bar: 456 })
    expect(result.rawMessage).toContain('foo')
    expect(result.rawMessage).toContain('123')
  })

  it('handles null', () => {
    const result = normalizeError(null)
    expect(result.rawMessage).toBe('null')
  })

  it('throws on undefined (edge case: JSON.stringify returns undefined value)', () => {
    // JSON.stringify(undefined) returns the JS value undefined, not a string.
    // detectCategory then crashes calling rawMessage.toLowerCase().
    expect(() => normalizeError(undefined)).toThrow()
  })

  it('handles number', () => {
    const result = normalizeError(42)
    expect(result.rawMessage).toBe('42')
  })
})

// ── extractRawMessage circular reference ─────────────────────────────

describe('extractRawMessage with circular references', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to String(error) when JSON.stringify fails on circular object', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular

    const result = normalizeError(circular)
    expect(result.rawMessage).toBe('[object Object]')
  })

  it('logs debug message when JSON.stringify fails', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular

    normalizeError(circular)
    expect(console.debug).toHaveBeenCalled()
  })
})

// ── detectCategory (tested via normalizeError) ───────────────────────

describe('detectCategory (via normalizeError)', () => {
  describe('Rust AppError variant detection', () => {
    it('detects Engine variant', () => {
      expect(normalizeError({ Engine: 'crashed' }).category).toBe('engine')
    })

    it('detects Config variant', () => {
      expect(normalizeError({ Config: 'bad key' }).category).toBe('config')
    })

    it('detects Network variant', () => {
      expect(normalizeError({ Network: 'timeout' }).category).toBe('network')
    })

    it('detects Io variant as file', () => {
      expect(normalizeError({ Io: 'read error' }).category).toBe('file')
    })

    it('detects File variant as file', () => {
      expect(normalizeError({ File: 'not found' }).category).toBe('file')
    })

    it('detects Task variant', () => {
      expect(normalizeError({ Task: 'failed' }).category).toBe('task')
    })
  })

  describe('keyword-based detection from string messages', () => {
    it('engine keywords', () => {
      expect(normalizeError('engine crashed').category).toBe('engine')
      expect(normalizeError('aria2 not found').category).toBe('engine')
      expect(normalizeError('not initialized').category).toBe('engine')
    })

    it('task keywords', () => {
      expect(normalizeError('duplicate task').category).toBe('task')
      expect(normalizeError('already exists').category).toBe('task')
    })

    it('network keywords', () => {
      expect(normalizeError('network error').category).toBe('network')
      expect(normalizeError('connection refused').category).toBe('network')
      expect(normalizeError('ECONNREFUSED').category).toBe('network')
      expect(normalizeError('timeout occurred').category).toBe('network')
      expect(normalizeError('rpc call failed').category).toBe('network')
      expect(normalizeError('load failed').category).toBe('network')
      expect(normalizeError('websocket closed').category).toBe('network')
      expect(normalizeError('fetch failed').category).toBe('network')
      expect(normalizeError('NetworkError when trying').category).toBe('network')
    })

    it('file keywords', () => {
      expect(normalizeError('disk full').category).toBe('file')
      expect(normalizeError('permission denied').category).toBe('file')
      expect(normalizeError('ENOSPC').category).toBe('file')
    })

    it('config keywords', () => {
      expect(normalizeError('config invalid').category).toBe('config')
      expect(normalizeError('preference error').category).toBe('config')
      expect(normalizeError('settings corrupted').category).toBe('config')
    })

    it('update keywords', () => {
      expect(normalizeError('update failed').category).toBe('update')
      expect(normalizeError('upgrade error').category).toBe('update')
    })

    it('falls back to generic for unrecognized messages', () => {
      expect(normalizeError('something unknown happened').category).toBe('generic')
    })
  })

  describe('category ordering edge cases', () => {
    it('classifies "update timeout" as update, not network', () => {
      expect(normalizeError('update timeout').category).toBe('update')
    })

    it('classifies "upgrade failed timeout" as update', () => {
      expect(normalizeError('upgrade failed timeout').category).toBe('update')
    })

    it('still classifies pure timeout as network', () => {
      expect(normalizeError('request timeout').category).toBe('network')
    })

    it('still classifies pure connection errors as network', () => {
      expect(normalizeError('connection refused').category).toBe('network')
    })
  })
})

// ── findMessageKey (tested via normalizeError) ───────────────────────

describe('findMessageKey (via normalizeError)', () => {
  describe('ENGINE_PATTERNS', () => {
    it('matches engine start failure', () => {
      const result = normalizeError('Failed to start engine')
      expect(result.messageKey).toBe('app.error-engine-start-failed')
    })

    it('matches aria2 launch failed', () => {
      const result = normalizeError('aria2 launch failed')
      expect(result.messageKey).toBe('app.error-engine-start-failed')
    })

    it('matches not initialized', () => {
      const result = normalizeError('Engine not initialized')
      expect(result.messageKey).toBe('app.error-engine-not-ready')
    })

    it('matches not ready after retries', () => {
      // Use a message that matches the third pattern (/not.*ready.*retr/i)
      // but not the second (/not\s+(initialized|ready)/i) — insert a word between "not" and "ready"
      const result = normalizeError('Engine not yet ready, retrying connection')
      expect(result.messageKey).toBe('app.error-engine-not-ready-after-retries')
    })
  })

  describe('NETWORK_PATTERNS', () => {
    it('matches RPC connection failure', () => {
      const result = normalizeError('rpc connection refused')
      expect(result.messageKey).toBe('app.error-rpc-connection-failed')
    })

    it('matches timeout', () => {
      const result = normalizeError('rpc request timed out')
      expect(result.messageKey).toBe('app.error-rpc-timeout')
    })

    it('matches websocket/fetch failure', () => {
      const result = normalizeError('WebSocket closed unexpectedly')
      expect(result.messageKey).toBe('app.error-rpc-connection-failed')
    })
  })

  it('returns undefined for unmatched patterns', () => {
    // 'disk full' → file category, no engine/network patterns to match
    const result = normalizeError('disk full error')
    expect(result.messageKey).toBeUndefined()
  })
})

// ── normalizeError ───────────────────────────────────────────────────

describe('normalizeError', () => {
  it('contextHint overrides auto-detection', () => {
    // 'engine crashed' would normally detect as 'engine', but contextHint overrides
    const result = normalizeError('engine crashed', 'config')
    expect(result.category).toBe('config')
    expect(result.titleKey).toBe('app.error-title-config')
  })

  it('returns correct titleKey for each category', () => {
    const categories: ErrorCategory[] = ['engine', 'task', 'network', 'file', 'config', 'update', 'generic']
    const expected = [
      'app.error-title-engine',
      'app.error-title-task',
      'app.error-title-network',
      'app.error-title-file',
      'app.error-title-config',
      'app.error-title-update',
      'app.error-title-generic',
    ]
    for (let i = 0; i < categories.length; i++) {
      const result = normalizeError('test', categories[i])
      expect(result.titleKey).toBe(expected[i])
    }
  })

  it('returns complete NormalizedError shape', () => {
    const result = normalizeError(new Error('aria2 launch failed'))
    expect(result).toHaveProperty('category')
    expect(result).toHaveProperty('titleKey')
    expect(result).toHaveProperty('messageKey')
    expect(result).toHaveProperty('rawMessage')
    expect(typeof result.category).toBe('string')
    expect(typeof result.titleKey).toBe('string')
    expect(typeof result.rawMessage).toBe('string')
  })
})

// ── normalizeTaskError ───────────────────────────────────────────────

describe('normalizeTaskError', () => {
  it('maps known aria2 error codes to i18n keys', () => {
    const knownCodes: Record<string, string> = {
      '1': 'task.error-unknown',
      '2': 'task.error-timeout',
      '3': 'task.error-not-found',
      '4': 'task.error-too-many-redirects',
      '5': 'task.error-disk-full',
      '6': 'task.error-network',
      '7': 'task.error-duplicate',
      '8': 'task.error-resume-failed',
      '9': 'task.error-file-not-found',
      '13': 'task.error-file-exists',
      '19': 'task.error-io',
      '24': 'task.error-checksum',
    }
    for (const [code, key] of Object.entries(knownCodes)) {
      const result = normalizeTaskError(code, 'some error')
      expect(result.messageKey).toBe(key)
    }
  })

  it('returns undefined messageKey for unknown error code', () => {
    const result = normalizeTaskError('999', 'bizarre error')
    expect(result.messageKey).toBeUndefined()
  })

  it('handles undefined errorCode', () => {
    const result = normalizeTaskError(undefined, 'no code')
    expect(result.messageKey).toBeUndefined()
    expect(result.rawMessage).toBe('no code')
  })

  it('handles undefined errorMessage', () => {
    const result = normalizeTaskError('1', undefined)
    expect(result.rawMessage).toBe('Unknown error')
  })

  it('handles both undefined code and message', () => {
    const result = normalizeTaskError(undefined, undefined)
    expect(result.rawMessage).toBe('Unknown error')
    expect(result.messageKey).toBeUndefined()
  })

  it('prepends taskName when provided', () => {
    const result = normalizeTaskError('5', 'no space left', 'big_file.zip')
    expect(result.rawMessage).toBe('big_file.zip: no space left')
  })

  it('prepends taskName with fallback message when errorMessage is undefined', () => {
    const result = normalizeTaskError('5', undefined, 'big_file.zip')
    expect(result.rawMessage).toBe('big_file.zip: Unknown error')
  })

  it('always returns task category and task title key', () => {
    const result = normalizeTaskError('1', 'err')
    expect(result.category).toBe('task')
    expect(result.titleKey).toBe('app.error-title-task')
  })
})

// ── errorDedupeKey ───────────────────────────────────────────────────

describe('errorDedupeKey', () => {
  it('uses category:messageKey when messageKey is present (non-task)', () => {
    const err: NormalizedError = {
      category: 'engine',
      titleKey: 'app.error-title-engine',
      messageKey: 'app.error-engine-start-failed',
      rawMessage: 'start engine failed',
    }
    expect(errorDedupeKey(err)).toBe('engine:app.error-engine-start-failed')
  })

  it('uses category:rawMessage when messageKey is absent', () => {
    const err: NormalizedError = {
      category: 'generic',
      titleKey: 'app.error-title-generic',
      rawMessage: 'something went wrong',
    }
    expect(errorDedupeKey(err)).toBe('generic:something went wrong')
  })

  describe('task error dedup keys', () => {
    it('produces different keys for different files with the same error code', () => {
      const errA = normalizeTaskError('5', 'disk full', 'fileA.zip')
      const errB = normalizeTaskError('5', 'disk full', 'fileB.zip')
      expect(errorDedupeKey(errA)).not.toBe(errorDedupeKey(errB))
    })

    it('produces the same key for the same file and error code', () => {
      const errA = normalizeTaskError('5', 'disk full', 'fileA.zip')
      const errB = normalizeTaskError('5', 'disk full', 'fileA.zip')
      expect(errorDedupeKey(errA)).toBe(errorDedupeKey(errB))
    })

    it('includes messageKey and rawMessage in task dedup key', () => {
      const err = normalizeTaskError('5', 'disk full', 'fileA.zip')
      const key = errorDedupeKey(err)
      expect(key).toContain('task:')
      expect(key).toContain('task.error-disk-full')
      expect(key).toContain('fileA.zip')
    })

    it('falls back to rawMessage when no messageKey', () => {
      const err = normalizeTaskError(undefined, 'something broke', 'fileA.zip')
      const key = errorDedupeKey(err)
      expect(key).toBe('task:fileA.zip: something broke')
    })
  })
})
