/** @fileoverview Tests for format utilities. */
import { describe, it, expect } from 'vitest'
import {
  bytesToSize,
  extractSpeedUnit,
  timeRemaining,
  timeFormat,
  localeDateTimeFormat,
  ellipsis,
  convertCommaToLine,
  convertLineToComma,
} from '../format'

describe('bytesToSize', () => {
  it('returns 0 KB for zero bytes', () => {
    expect(bytesToSize(0)).toBe('0 KB')
  })
  it('formats bytes correctly', () => {
    expect(bytesToSize(500)).toBe('500 B')
  })
  it('formats kilobytes', () => {
    expect(bytesToSize(1024)).toBe('1.0 KB')
  })
  it('formats megabytes with precision', () => {
    expect(bytesToSize(1048576, 2)).toBe('1.00 MB')
  })
  it('formats gigabytes', () => {
    expect(bytesToSize(1073741824)).toBe('1.0 GB')
  })
  it('formats terabytes', () => {
    expect(bytesToSize(1099511627776)).toBe('1.0 TB')
  })
  it('handles string input', () => {
    expect(bytesToSize('2048')).toBe('2.0 KB')
  })
})

describe('extractSpeedUnit', () => {
  it('returns K for zero speed', () => {
    expect(extractSpeedUnit('0')).toBe('K')
  })
  it('extracts K unit', () => {
    expect(extractSpeedUnit('100K')).toBe('K')
  })
  it('extracts M unit', () => {
    expect(extractSpeedUnit('5.5M')).toBe('M')
  })
  it('extracts G unit', () => {
    expect(extractSpeedUnit('1.5G')).toBe('G')
  })
  it('returns K for invalid input', () => {
    expect(extractSpeedUnit('abc')).toBe('K')
  })
  it('returns K for empty string', () => {
    expect(extractSpeedUnit('')).toBe('K')
  })
})

describe('timeRemaining', () => {
  it('returns 0 for zero speed', () => {
    expect(timeRemaining(1000, 500, 0)).toBe(0)
  })
  it('calculates remaining time correctly', () => {
    expect(timeRemaining(1000, 500, 100)).toBe(5)
  })
  it('handles negative speed', () => {
    expect(timeRemaining(1000, 500, -1)).toBe(0)
  })
})

describe('timeFormat', () => {
  it('returns empty for zero seconds', () => {
    expect(timeFormat(0, {})).toBe('')
  })
  it('formats seconds', () => {
    expect(timeFormat(45, {})).toBe(' 45s ')
  })
  it('formats minutes and seconds', () => {
    expect(timeFormat(125, {})).toContain('2m')
  })
  it('formats hours', () => {
    expect(timeFormat(7200, {})).toContain('2h')
  })
  it('returns > 1 day for large values', () => {
    expect(timeFormat(100000, {})).toContain('> 1 day')
  })
  it('applies custom i18n labels', () => {
    const result = timeFormat(3661, { i18n: { hour: 'hr', minute: 'min', second: 'sec' } })
    expect(result).toContain('1hr')
    expect(result).toContain('1min')
    expect(result).toContain('1sec')
  })
  it('applies prefix and suffix', () => {
    const result = timeFormat(60, { prefix: 'ETA:', suffix: 'left' })
    expect(result).toContain('ETA:')
    expect(result).toContain('left')
  })
  it('returns empty for negative seconds', () => {
    expect(timeFormat(-10, {})).toBe('')
  })
})

describe('localeDateTimeFormat', () => {
  it('returns empty for zero timestamp', () => {
    expect(localeDateTimeFormat(0, 'en-US')).toBe('')
  })
  it('formats unix timestamp', () => {
    const result = localeDateTimeFormat(1609459200, 'en-US')
    expect(result).toContain('2021')
  })
  it('formats millisecond timestamp', () => {
    const result = localeDateTimeFormat(1609459200000, 'en-US')
    expect(result).toContain('2021')
  })
})

describe('ellipsis', () => {
  it('returns empty for empty string', () => {
    expect(ellipsis('')).toBe('')
  })
  it('returns unchanged for short strings', () => {
    expect(ellipsis('hello')).toBe('hello')
  })
  it('truncates long strings', () => {
    const long = 'a'.repeat(100)
    const result = ellipsis(long, 10)
    expect(result.length).toBe(13)
    expect(result.endsWith('...')).toBe(true)
  })
  it('returns unchanged when length exactly equals maxLen', () => {
    expect(ellipsis('abcde', 5)).toBe('abcde')
  })
  it('returns original string when maxLen is 0', () => {
    // maxLen <= 0 means no truncation per the code logic
    expect(ellipsis('hello', 0)).toBe('hello')
  })
})

describe('convertCommaToLine / convertLineToComma', () => {
  it('converts comma to newlines', () => {
    expect(convertCommaToLine('a,b,c')).toBe('a\nb\nc')
  })
  it('converts newlines to commas', () => {
    expect(convertLineToComma('a\nb\nc')).toBe('a,b,c')
  })
  it('trims spaces around comma-separated items', () => {
    expect(convertCommaToLine(' a , b , c ')).toBe('a\nb\nc')
  })
  it('handles empty string for both', () => {
    expect(convertCommaToLine('')).toBe('')
    expect(convertLineToComma('')).toBe('')
  })
})
