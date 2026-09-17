import { describe, expect, it } from 'vitest'
import { argbFromHex, Hct, Contrast } from '@material/material-color-utilities'
import { buildAppColorTokens, buildColorSchemeTheme, resolveColorScheme } from '../colorScheme'
import { hydrateAppConfig } from '../configHydration'

function contrast(a: string, b: string) {
  return Contrast.ratioOfTones(Hct.fromInt(argbFromHex(a)).tone, Hct.fromInt(argbFromHex(b)).tone)
}

describe('Rayburst theme', () => {
  it('uses purple for new and invalid preferences', () => {
    expect(hydrateAppConfig().config.colorScheme).toBe('rayburst')
    expect(hydrateAppConfig({ colorScheme: 'unknown' }).config.colorScheme).toBe('rayburst')
    expect(resolveColorScheme(undefined, undefined).seed).toBe('#946ECE')
  })
  it('keeps semantic button labels readable through interaction states', () => {
    const theme = buildColorSchemeTheme(resolveColorScheme('rayburst', undefined))
    for (const dark of [false, true]) {
      const tokens = buildAppColorTokens(theme, dark)
      for (const name of ['primary', 'info', 'success', 'warning', 'error'] as const) {
        for (const state of ['color', 'hover', 'pressed'] as const) {
          expect(contrast(tokens[name][state], tokens[name].onColor)).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(tokens.warning.color).not.toBe(tokens.primary.color)
    }
  })
})
