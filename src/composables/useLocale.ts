/** @fileoverview vue-i18n instance with lazily loaded locale messages.
 *
 * Only en-US (the fallback) ships in the main bundle. The active locale is
 * dynamically imported once during bootstrap — a locale change requires an
 * app restart (enforced by the General preference page), so no runtime
 * switching path is needed beyond loadLocale().
 */
import { createI18n } from 'vue-i18n'
import { setI18nLocale } from '@shared/utils/i18n'
import { isSupportedLocale, type SupportedLocale } from '@shared/localeCatalog'
import enUS from '@shared/locales/en-US/messages.json'

type LocaleMessages = typeof enUS

const localeLoaders = import.meta.glob<{ default: LocaleMessages }>([
  '@shared/locales/*/messages.json',
  '!@shared/locales/en-US/messages.json',
])

const messages: Record<string, LocaleMessages> = { 'en-US': enUS as LocaleMessages }

export const i18n = createI18n({
  legacy: false,
  locale: 'en-US',
  fallbackLocale: 'en-US',
  messages,
})

/**
 * Dynamically loads a locale's messages into the i18n instance.
 * No-op for en-US and already-loaded locales. Unknown locales resolve
 * without loading (the fallback covers rendering).
 */
export async function loadLocale(locale: SupportedLocale): Promise<void> {
  if (i18n.global.availableLocales.includes(locale)) return
  const loader = Object.entries(localeLoaders).find(([path]) => path.endsWith(`/locales/${locale}/messages.json`))?.[1]
  if (!loader) throw new Error(`Locale resource is not bundled: ${locale}`)
  const messages = (await loader()).default
  i18n.global.setLocaleMessage(locale, messages)
}

export function useLocale() {
  async function setLocale(locale: string) {
    if (!isSupportedLocale(locale)) throw new Error(`Unsupported locale: ${locale}`)
    await loadLocale(locale)
    setI18nLocale(i18n, locale)
  }

  return { i18n, setLocale }
}
