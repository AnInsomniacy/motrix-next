import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isEmpty } from 'lodash-es'
import { load } from '@tauri-apps/plugin-store'
import {
    getLangDirection,
    pushItemToFixedLengthArray,
    removeArrayItem,
} from '@shared/utils'
import { fetchBtTrackerFromSource } from '@shared/utils/tracker'
import { MAX_NUM_OF_DIRECTORIES } from '@shared/constants'

const STORE_KEY = 'preferences'

export const usePreferenceStore = defineStore('preference', () => {
    const engineMode = ref('MAX')
    const config = ref<Record<string, unknown>>({})

    const theme = computed(() => config.value.theme as string | undefined)
    const locale = computed(() => config.value.locale as string | undefined)
    const direction = computed(() => getLangDirection((config.value.locale as string) || 'en-US'))

    async function getStore() {
        return await load('config.json')
    }

    async function loadPreference() {
        try {
            const store = await getStore()
            const saved = await store.get<Record<string, unknown>>(STORE_KEY)
            if (saved && !isEmpty(saved)) {
                config.value = { ...config.value, ...saved }
            }
        } catch (e) {
            console.error('loadPreference error:', e)
        }
    }

    async function savePreference() {
        try {
            const store = await getStore()
            await store.set(STORE_KEY, config.value)
            await store.save()
        } catch (e) {
            console.error('savePreference error:', e)
        }
    }

    async function updateAndSave(cfg: Record<string, unknown>) {
        config.value = { ...config.value, ...cfg }
        await savePreference()
    }

    function updatePreference(cfg: Record<string, unknown>) {
        config.value = { ...config.value, ...cfg }
    }

    async function fetchPreference(api: { fetchPreference: () => Promise<Record<string, unknown>> }) {
        const cfg = await api.fetchPreference()
        updatePreference(cfg)
        return cfg
    }

    async function save(
        cfg: Record<string, unknown>,
        api: { savePreference: (c: Record<string, unknown>) => Promise<unknown> },
        saveSession: () => void
    ) {
        saveSession()
        if (isEmpty(cfg)) return
        updatePreference(cfg)
        return api.savePreference(cfg)
    }

    function recordHistoryDirectory(directory: string) {
        const historyDirectories = (config.value.historyDirectories as string[]) || []
        const favoriteDirectories = (config.value.favoriteDirectories as string[]) || []
        const all = new Set([...historyDirectories, ...favoriteDirectories])
        if (all.has(directory)) return
        addHistoryDirectory(directory)
    }

    function addHistoryDirectory(directory: string) {
        const historyDirectories = (config.value.historyDirectories as string[]) || []
        const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
        config.value = { ...config.value, historyDirectories: history }
    }

    function favoriteDirectory(directory: string) {
        const historyDirectories = (config.value.historyDirectories as string[]) || []
        const favoriteDirectories = (config.value.favoriteDirectories as string[]) || []
        if (favoriteDirectories.includes(directory) || favoriteDirectories.length >= MAX_NUM_OF_DIRECTORIES) return
        const favorite = pushItemToFixedLengthArray(favoriteDirectories, MAX_NUM_OF_DIRECTORIES, directory)
        const history = removeArrayItem(historyDirectories, directory)
        config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    }

    function cancelFavoriteDirectory(directory: string) {
        const historyDirectories = (config.value.historyDirectories as string[]) || []
        const favoriteDirectories = (config.value.favoriteDirectories as string[]) || []
        if (historyDirectories.includes(directory)) return
        const favorite = removeArrayItem(favoriteDirectories, directory)
        const history = pushItemToFixedLengthArray(historyDirectories, MAX_NUM_OF_DIRECTORIES, directory)
        config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    }

    function removeDirectory(directory: string) {
        const historyDirectories = (config.value.historyDirectories as string[]) || []
        const favoriteDirectories = (config.value.favoriteDirectories as string[]) || []
        const favorite = removeArrayItem(favoriteDirectories, directory)
        const history = removeArrayItem(historyDirectories, directory)
        config.value = { ...config.value, historyDirectories: history, favoriteDirectories: favorite }
    }

    function updateAppTheme(t: string) {
        updatePreference({ theme: t })
    }

    function updateAppLocale(l: string) {
        updatePreference({ locale: l })
    }

    async function fetchBtTracker(trackerSource: string[] = []) {
        const proxy = (config.value.proxy as Record<string, unknown>) || { enable: false }
        return fetchBtTrackerFromSource(trackerSource, proxy)
    }

    return {
        engineMode,
        config,
        theme,
        locale,
        direction,
        updatePreference,
        updateAndSave,
        loadPreference,
        savePreference,
        fetchPreference,
        save,
        recordHistoryDirectory,
        addHistoryDirectory,
        favoriteDirectory,
        cancelFavoriteDirectory,
        removeDirectory,
        updateAppTheme,
        updateAppLocale,
        fetchBtTracker,
    }
})
