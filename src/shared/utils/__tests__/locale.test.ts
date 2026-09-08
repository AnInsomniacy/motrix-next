import { describe, expect, it } from 'vitest'
import { getLangDirection, resolveSystemLocale } from '../locale'

describe('locale utilities', () => {
  it.each([
    ['zh-Hans-CN', 'zh-CN'],
    ['zh-Hant-HK', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['en-AU', 'en-US'],
    ['pt-PT', 'pt-BR'],
    ['xx-YY', 'en-US'],
  ])('matches %s to %s', (requested, expected) => {
    expect(resolveSystemLocale(requested)).toBe(expected)
  })

  it('falls back safely for malformed locale tags', () => {
    expect(resolveSystemLocale('not a locale')).toBe('en-US')
  })

  it('derives text direction from the locale catalog', () => {
    expect(getLangDirection('ar')).toBe('rtl')
    expect(getLangDirection('fa')).toBe('rtl')
    expect(getLangDirection('en-US')).toBe('ltr')
  })
})
