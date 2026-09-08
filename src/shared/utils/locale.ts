/** @fileoverview Locale negotiation and text direction. */
import { match } from '@formatjs/intl-localematcher'
import { isSupportedLocale, LOCALE_CATALOG, SUPPORTED_LOCALES, type SupportedLocale } from '@shared/localeCatalog'

/**
 * Resolves a raw OS locale string (e.g. `'zh-Hans-CN'`) to the best
 * matching locale code from the available set (e.g. `'zh-CN'`).
 *
 * Uses Intl locale matching and falls back to en-US for malformed tags.
 */
export function resolveSystemLocale(
  rawLocale: string,
  availableLocales: readonly SupportedLocale[] = SUPPORTED_LOCALES,
): SupportedLocale {
  try {
    const resolved = match([rawLocale], [...availableLocales], 'en-US')
    return isSupportedLocale(resolved) ? resolved : 'en-US'
  } catch {
    return 'en-US'
  }
}

const isRTL = (locale = 'en-US'): boolean => {
  return LOCALE_CATALOG.find(({ code }) => code === locale)?.direction === 'rtl'
}

export const getLangDirection = (locale = 'en-US'): string => {
  return isRTL(locale) ? 'rtl' : 'ltr'
}
