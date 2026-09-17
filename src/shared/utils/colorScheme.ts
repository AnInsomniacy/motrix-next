import {
  CorePalette,
  Hct,
  Contrast,
  Scheme,
  argbFromHex,
  customColor,
  hexFromArgb,
  themeFromSourceColor,
  type CustomColor,
  type CustomColorGroup,
  type Theme,
  type TonalPalette,
} from '@material/material-color-utilities'
import {
  COLOR_SCHEMES,
  DEFAULT_COLOR_SCHEME_ID,
  CUSTOM_COLOR_SCHEME_ID,
  type ColorSchemeDefinition,
} from '@shared/constants'
import { normalizeCustomColorScheme } from '@shared/utils/colorSchemeConfig'

const LOW_SATURATION_THRESHOLD = 12

export type SemanticColorName = 'info' | 'success' | 'warning' | 'error'

const EXTENDED_COLORS: readonly CustomColor[] = [
  { name: 'info', value: argbFromHex('#0061A4'), blend: true },
  { name: 'success', value: argbFromHex('#386A20'), blend: true },
  { name: 'warning', value: argbFromHex('#7C5800'), blend: true },
  { name: 'error', value: argbFromHex('#BA1A1A'), blend: true },
]

function buildExtendedColors(): CustomColor[] {
  return EXTENDED_COLORS.map((color) => ({ ...color }))
}

export interface StatefulColorRole {
  color: string
  onColor: string
  container: string
  onContainer: string
  hover: string
  pressed: string
}

export interface AppColorTokens {
  primary: StatefulColorRole
  tertiary: StatefulColorRole
  info: StatefulColorRole
  success: StatefulColorRole
  warning: StatefulColorRole
  error: StatefulColorRole
  surface: string
  onSurface: string
  onSurfaceVariant: string
  surfaceDim: string
  surfaceContainerLowest: string
  surfaceContainerLow: string
  surfaceContainer: string
  surfaceContainerHigh: string
  surfaceContainerHighest: string
  outline: string
  outlineVariant: string
  inverseSurface: string
  onInverseSurface: string
  statusActive: string
  statusWaiting: string
  statusPaused: string
  statusError: string
  statusSuccess: string
}

const SURFACE_TONES = {
  light: {
    surfaceDim: 84,
    surfaceContainerLowest: 98,
    surfaceContainerLow: 94,
    surfaceContainer: 91,
    surfaceContainerHigh: 88,
    surfaceContainerHighest: 85,
  },
  dark: {
    surfaceDim: 6,
    surfaceContainerLowest: 4,
    surfaceContainerLow: 10,
    surfaceContainer: 12,
    surfaceContainerHigh: 17,
    surfaceContainerHighest: 22,
  },
} as const

function buildContentTheme(source: number): Theme {
  const palette = CorePalette.contentOf(source)
  const extendedColors = buildExtendedColors()
  return {
    source,
    schemes: {
      light: Scheme.lightContent(source),
      dark: Scheme.darkContent(source),
    },
    palettes: {
      primary: palette.a1,
      secondary: palette.a2,
      tertiary: palette.a3,
      neutral: palette.n1,
      neutralVariant: palette.n2,
      error: palette.error,
    },
    customColors: extendedColors.map((color) => customColor(source, color)),
  }
}

export function buildColorSchemeTheme(scheme: ColorSchemeDefinition): Theme {
  const seed = normalizeCustomColorScheme(scheme.seed)
  const source = argbFromHex(seed)
  const extendedColors = buildExtendedColors()
  const usesContentPalette =
    scheme.variant === 'content' ||
    (scheme.id === CUSTOM_COLOR_SCHEME_ID && Hct.fromInt(source).chroma <= LOW_SATURATION_THRESHOLD)
  return usesContentPalette ? buildContentTheme(source) : themeFromSourceColor(source, extendedColors)
}

function getExtendedColor(theme: Theme, name: SemanticColorName): CustomColorGroup {
  const group = theme.customColors.find((candidate) => candidate.color.name === name)
  if (!group) throw new Error(`Missing extended color: ${name}`)
  return group
}

function interactionTones(palette: TonalPalette, dark: boolean): Pick<StatefulColorRole, 'hover' | 'pressed'> {
  return {
    hover: hexFromArgb(palette.tone(dark ? 70 : Contrast.darker(100, 4.6))),
    pressed: hexFromArgb(palette.tone(dark ? 90 : 30)),
  }
}

function schemeRole(
  palette: TonalPalette,
  values: { color: number; onColor: number; container: number; onContainer: number },
  dark: boolean,
): StatefulColorRole {
  return {
    color: hexFromArgb(values.color),
    onColor: hexFromArgb(values.onColor),
    container: hexFromArgb(values.container),
    onContainer: hexFromArgb(values.onContainer),
    ...interactionTones(palette, dark),
  }
}

function extendedRole(theme: Theme, name: SemanticColorName, dark: boolean): StatefulColorRole {
  const group = getExtendedColor(theme, name)
  const values = dark ? group.dark : group.light
  return schemeRole(
    CorePalette.of(group.value).a1,
    {
      color: values.color,
      onColor: values.onColor,
      container: values.colorContainer,
      onContainer: values.onColorContainer,
    },
    dark,
  )
}

export function buildAppColorTokens(theme: Theme, dark: boolean): AppColorTokens {
  const scheme = dark ? theme.schemes.dark : theme.schemes.light
  const surfaceTones = dark ? SURFACE_TONES.dark : SURFACE_TONES.light
  const neutral = theme.palettes.neutral
  const primary = schemeRole(
    theme.palettes.primary,
    {
      color: scheme.primary,
      onColor: scheme.onPrimary,
      container: scheme.primaryContainer,
      onContainer: scheme.onPrimaryContainer,
    },
    dark,
  )
  const tertiary = schemeRole(
    theme.palettes.tertiary,
    {
      color: scheme.tertiary,
      onColor: scheme.onTertiary,
      container: scheme.tertiaryContainer,
      onContainer: scheme.onTertiaryContainer,
    },
    dark,
  )
  const info = extendedRole(theme, 'info', dark)
  const success = extendedRole(theme, 'success', dark)
  const warning = extendedRole(theme, 'warning', dark)
  const error = extendedRole(theme, 'error', dark)

  return {
    primary,
    tertiary,
    info,
    success,
    warning,
    error,
    surface: hexFromArgb(scheme.surface),
    onSurface: hexFromArgb(scheme.onSurface),
    onSurfaceVariant: hexFromArgb(scheme.onSurfaceVariant),
    surfaceDim: hexFromArgb(neutral.tone(surfaceTones.surfaceDim)),
    surfaceContainerLowest: hexFromArgb(neutral.tone(surfaceTones.surfaceContainerLowest)),
    surfaceContainerLow: hexFromArgb(neutral.tone(surfaceTones.surfaceContainerLow)),
    surfaceContainer: hexFromArgb(neutral.tone(surfaceTones.surfaceContainer)),
    surfaceContainerHigh: hexFromArgb(neutral.tone(surfaceTones.surfaceContainerHigh)),
    surfaceContainerHighest: hexFromArgb(neutral.tone(surfaceTones.surfaceContainerHighest)),
    outline: hexFromArgb(scheme.outline),
    outlineVariant: hexFromArgb(scheme.outlineVariant),
    inverseSurface: hexFromArgb(scheme.inverseSurface),
    onInverseSurface: hexFromArgb(scheme.inverseOnSurface),
    statusActive: primary.color,
    statusWaiting: info.color,
    statusPaused: hexFromArgb(scheme.outline),
    statusError: error.color,
    statusSuccess: success.color,
  }
}

export function resolveColorScheme(id: string | undefined, customColor: string | undefined): ColorSchemeDefinition {
  if (id === CUSTOM_COLOR_SCHEME_ID) {
    return {
      id: CUSTOM_COLOR_SCHEME_ID,
      labelKey: 'preferences.color-scheme-custom',
      seed: normalizeCustomColorScheme(customColor),
    }
  }
  return (
    COLOR_SCHEMES.find((scheme) => scheme.id === id) ||
    COLOR_SCHEMES.find((scheme) => scheme.id === DEFAULT_COLOR_SCHEME_ID)!
  )
}
