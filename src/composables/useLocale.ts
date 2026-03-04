import { createI18n } from 'vue-i18n'

const localeModules = import.meta.glob('@shared/locales/*/index.js', { eager: true }) as Record<string, { default: Record<string, Record<string, string>> }>

const messages: Record<string, Record<string, unknown>> = {}

for (const path in localeModules) {
    const match = path.match(/locales\/([^/]+)\/index\.js$/)
    if (match) {
        const locale = match[1]
        messages[locale] = localeModules[path].default
    }
}

export const i18n = createI18n({
    legacy: false,
    locale: 'en-US',
    fallbackLocale: 'en-US',
    messages: messages as never,
})

export function useLocale() {
    function setLocale(locale: string) {
        ; (i18n.global.locale as unknown as { value: string }).value = locale
    }

    return { i18n, setLocale }
}
