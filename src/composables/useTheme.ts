import { ref, watch } from 'vue'
import { usePreferenceStore } from '@/stores/preference'
import { APP_THEME } from '@shared/constants'

export function useTheme() {
    const preferenceStore = usePreferenceStore()
    const isDark = ref(false)

    function applyTheme(theme?: string) {
        if (!theme || theme === APP_THEME.AUTO) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)')
            isDark.value = mq.matches
        } else {
            isDark.value = theme === APP_THEME.DARK
        }

        document.documentElement.classList.toggle('dark', isDark.value)
        document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
    }

    watch(() => preferenceStore.theme, applyTheme, { immediate: true })

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => {
        if (!preferenceStore.theme || preferenceStore.theme === APP_THEME.AUTO) {
            applyTheme(APP_THEME.AUTO)
        }
    })

    return { isDark, applyTheme }
}
