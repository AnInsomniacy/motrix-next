/** @fileoverview Canonical desktop locale metadata shared by loading and UI selection. */
import catalog from '@shared/locales/catalog.json'

export type SupportedLocale = keyof typeof catalog

export const LOCALE_CATALOG = Object.entries(catalog).map(([code, metadata]) => ({
  // Object.entries erases JSON object key literals; catalog is the validated source of these keys.
  code: code as SupportedLocale,
  ...metadata,
}))

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = LOCALE_CATALOG.map(({ code }) => code)

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.some((supported) => supported === locale)
}
