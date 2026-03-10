/** @fileoverview Tests for config utilities. */
import { describe, it, expect } from 'vitest'
import {
  changeKeysCase,
  changeKeysToCamelCase,
  changeKeysToKebabCase,
  validateNumber,
  fixValue,
  separateConfig,
  diffConfig,
  checkIsNeedRestart,
  checkConfigChangeNeedsRestart,
  checkIsNeedRun,
  buildRpcUrl,
  formatOptionsForEngine,
  parseHeader,
} from '../config'

describe('changeKeysToCamelCase', () => {
  it('converts kebab-case keys to camelCase', () => {
    expect(changeKeysToCamelCase({ 'max-speed': 100 })).toEqual({ maxSpeed: 100 })
  })
  it('returns empty for empty object', () => {
    expect(changeKeysToCamelCase({})).toEqual({})
  })
  it('returns empty for default parameter', () => {
    expect(changeKeysToCamelCase()).toEqual({})
  })
})

describe('changeKeysToKebabCase', () => {
  it('converts camelCase keys to kebab-case', () => {
    expect(changeKeysToKebabCase({ maxSpeed: 100 })).toEqual({ 'max-speed': 100 })
  })
})

describe('changeKeysCase', () => {
  it('returns empty when converter is not a function', () => {
    expect(changeKeysCase({ a: 1 }, null as unknown as (s: string) => string)).toEqual({})
  })
})

describe('validateNumber', () => {
  it('validates numbers', () => {
    expect(validateNumber(42)).toBe(true)
    expect(validateNumber(3.14)).toBe(true)
  })
  it('rejects non-numbers', () => {
    expect(validateNumber('abc')).toBe(false)
    expect(validateNumber(NaN)).toBe(false)
    expect(validateNumber(Infinity)).toBe(false)
  })
})

describe('fixValue', () => {
  it('converts string booleans and numbers', () => {
    const result = fixValue({ a: 'true', b: 'false', c: '42', d: 'text' })
    expect(result).toEqual({ a: true, b: false, c: '42', d: 'text' })
  })
  it('passes through real numbers unchanged', () => {
    const result = fixValue({ n: 42, f: 3.14 })
    expect(result).toEqual({ n: 42, f: 3.14 })
  })
  it('returns empty for empty object', () => {
    expect(fixValue({})).toEqual({})
  })
})

describe('separateConfig', () => {
  it('separates user, system, and other keys', () => {
    const result = separateConfig({ theme: 'dark', dir: '/tmp', unknownKey: 'val' })
    expect(result.user).toHaveProperty('theme')
    expect(result.system).toHaveProperty('dir')
    expect(result.others).toHaveProperty('unknownKey')
  })
})

describe('diffConfig', () => {
  it('returns only changed keys', () => {
    const result = diffConfig({ a: 1, b: 2 }, { a: 1, b: 3 })
    expect(result).toEqual({ b: 3 })
  })
  it('returns empty for identical configs', () => {
    const result = diffConfig({ a: 1 }, { a: 1 })
    expect(result).toEqual({})
  })
  it('diffs arrays via JSON.stringify', () => {
    const result = diffConfig({ tags: ['a', 'b'] }, { tags: ['a', 'c'] })
    expect(result).toEqual({ tags: ['a', 'c'] })
  })
  it('returns empty for identical arrays', () => {
    const result = diffConfig({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })
    expect(result).toEqual({})
  })
  it('diffs nested objects via JSON.stringify', () => {
    const result = diffConfig({ proxy: { host: 'a' } }, { proxy: { host: 'b' } })
    expect(result).toEqual({ proxy: { host: 'b' } })
  })
})

describe('checkIsNeedRestart', () => {
  it('returns false for empty changes', () => {
    expect(checkIsNeedRestart({})).toBe(false)
  })
  it('returns true for restart-required keys', () => {
    expect(checkIsNeedRestart({ rpcListenPort: 6800 })).toBe(true)
  })
  it('returns false for non-restart keys', () => {
    expect(checkIsNeedRestart({ theme: 'dark' })).toBe(false)
  })
})

describe('checkConfigChangeNeedsRestart', () => {
  it('returns true when useNativeTrafficLights changes', () => {
    expect(checkConfigChangeNeedsRestart({ useNativeTrafficLights: false }, { useNativeTrafficLights: true })).toBe(
      true,
    )
  })

  it('returns false when restart-required keys are unchanged', () => {
    expect(checkConfigChangeNeedsRestart({ useNativeTrafficLights: true }, { useNativeTrafficLights: true })).toBe(
      false,
    )
  })

  it('returns false when only non-restart keys change', () => {
    expect(checkConfigChangeNeedsRestart({ theme: 'light' }, { theme: 'dark' })).toBe(false)
  })
})

describe('checkIsNeedRun', () => {
  it('returns false when disabled', () => {
    expect(checkIsNeedRun(false, 0, 1000)).toBe(false)
  })
  it('returns true when interval exceeded', () => {
    expect(checkIsNeedRun(true, Date.now() - 10000, 5000)).toBe(true)
  })
  it('returns false when within interval', () => {
    expect(checkIsNeedRun(true, Date.now() - 1000, 5000)).toBe(false)
  })
})

describe('buildRpcUrl', () => {
  it('builds url without secret', () => {
    expect(buildRpcUrl({ port: 6800 })).toContain(':6800/jsonrpc')
  })
  it('builds url with secret', () => {
    const result = buildRpcUrl({ port: 6800, secret: 'abc' })
    expect(result).toContain('token:abc@')
  })
})

describe('formatOptionsForEngine', () => {
  it('converts keys to kebab-case', () => {
    const result = formatOptionsForEngine({ maxSpeed: '100' })
    expect(result).toHaveProperty('max-speed')
  })
  it('joins arrays with newline', () => {
    const result = formatOptionsForEngine({ trackerSource: ['a', 'b'] })
    expect(result['tracker-source']).toBe('a\nb')
  })
  it('skips null/undefined/empty-string values', () => {
    const result = formatOptionsForEngine({ a: undefined, b: null, c: '' })
    expect(Object.keys(result).length).toBe(0)
  })
  it('keeps numeric 0 value (converted to string)', () => {
    const result = formatOptionsForEngine({ seedTime: 0 })
    expect(result['seed-time']).toBe('0')
  })
  it('converts boolean to string', () => {
    const result = formatOptionsForEngine({ checkIntegrity: true })
    expect(result['check-integrity']).toBe('true')
  })
})

describe('parseHeader', () => {
  it('parses header string', () => {
    const result = parseHeader('Content-Type: text/html')
    expect(result.contentType).toBe('text/html')
  })
  it('returns empty for empty string', () => {
    expect(parseHeader('')).toEqual({})
  })
  it('parses multiple headers separated by newlines', () => {
    const result = parseHeader('Content-Type: text/html\nAuthorization: Bearer abc')
    expect(result.contentType).toBe('text/html')
    expect(result.authorization).toBe('Bearer abc')
  })
  it('handles header value with colon', () => {
    const result = parseHeader('Accept: text/html; charset=utf-8')
    expect(result.accept).toBe('text/html; charset=utf-8')
  })
  it('returns empty for whitespace-only string', () => {
    expect(parseHeader('   ')).toEqual({})
  })
})
