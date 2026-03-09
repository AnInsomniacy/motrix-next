/** @fileoverview Pinia store for global application state: engine, tasks, stats, and polling. */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ADD_TASK_TYPE } from '@shared/constants'
import { invoke } from '@tauri-apps/api/core'
import { decodeThunderLink } from '@shared/utils'
import { logger } from '@shared/logger'
import { STAT_BASE_INTERVAL, STAT_PER_TASK_INTERVAL, STAT_MIN_INTERVAL, STAT_MAX_INTERVAL } from '@shared/timing'
import type { Aria2RawGlobalStat, Aria2Task, Aria2EngineOptions, TauriUpdate, AppConfig } from '@shared/types'

export const useAppStore = defineStore('app', () => {
  const systemTheme = ref('light')
  const trayFocused = ref(false)
  const aboutPanelVisible = ref(false)
  const engineInfo = ref<{ version: string; enabledFeatures: string[] }>({
    version: '',
    enabledFeatures: [],
  })
  const engineOptions = ref<Partial<AppConfig>>({})
  const interval = ref(STAT_BASE_INTERVAL)
  const stat = ref({
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numWaiting: 0,
    numStopped: 0,
  })
  const addTaskVisible = ref(false)
  const addTaskType = ref(ADD_TASK_TYPE.URI)
  const addTaskUrl = ref('')
  const addTaskTorrents = ref<File[]>([])
  const addTaskOptions = ref<Aria2EngineOptions>({})
  const droppedTorrentPaths = ref<string[]>([])
  const progress = ref(0)
  const pendingUpdate = ref<TauriUpdate | null>(null)

  function updateInterval(millisecond: number) {
    let val = millisecond
    if (val > STAT_MAX_INTERVAL) val = STAT_MAX_INTERVAL
    if (val < STAT_MIN_INTERVAL) val = STAT_MIN_INTERVAL
    if (interval.value === val) return
    interval.value = val
  }

  function increaseInterval(millisecond = 100) {
    if (interval.value < STAT_MAX_INTERVAL) interval.value += millisecond
  }

  function decreaseInterval(millisecond = 100) {
    if (interval.value > STAT_MIN_INTERVAL) interval.value -= millisecond
  }

  function resetInterval() {
    interval.value = STAT_BASE_INTERVAL
  }

  function showAddTaskDialog(taskType: string, torrentPaths?: string[]) {
    addTaskType.value = taskType
    droppedTorrentPaths.value = torrentPaths || []
    addTaskVisible.value = true
  }

  function hideAddTaskDialog() {
    addTaskVisible.value = false
    addTaskUrl.value = ''
    addTaskTorrents.value = []
    droppedTorrentPaths.value = []
  }

  function updateAddTaskOptions(options: Aria2EngineOptions = {}) {
    addTaskOptions.value = { ...options }
  }

  const compactSize = (b: number) => {
    if (b < 1024) return `${b}B`
    if (b < 1048576) return `${(b / 1024).toFixed(0)}K`
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)}M`
    return `${(b / 1073741824).toFixed(2)}G`
  }

  async function fetchGlobalStat(api: {
    getGlobalStat: () => Promise<Aria2RawGlobalStat>
    fetchActiveTaskList?: () => Promise<Aria2Task[]>
  }) {
    try {
      const data = await api.getGlobalStat()
      const parsed: Record<string, number> = {}
      Object.keys(data).forEach((key) => {
        parsed[key] = Number(data[key])
      })

      const { numActive } = parsed
      if (numActive > 0) {
        updateInterval(STAT_BASE_INTERVAL - STAT_PER_TASK_INTERVAL * numActive)
      } else {
        parsed.downloadSpeed = 0
        increaseInterval()
      }
      stat.value = parsed as typeof stat.value

      try {
        const prefStore = (await import('@/stores/preference')).usePreferenceStore()

        // Tray speed display (macOS menu bar)
        if (prefStore.config?.traySpeedometer && (parsed.downloadSpeed > 0 || parsed.uploadSpeed > 0)) {
          const title =
            parsed.downloadSpeed > 0 ? `↓${compactSize(parsed.downloadSpeed)}` : `↑${compactSize(parsed.uploadSpeed)}`
          await invoke('update_tray_title', { title })
        } else {
          await invoke('update_tray_title', { title: '' })
        }

        // Dock badge speed (macOS)
        if (prefStore.config?.dockBadgeSpeed !== false && parsed.downloadSpeed > 0) {
          await invoke('update_dock_badge', { label: `${compactSize(parsed.downloadSpeed)}/s` })
        } else {
          await invoke('update_dock_badge', { label: '' })
        }

        // Dock progress bar (macOS/Windows)
        if (prefStore.config?.showProgressBar && numActive > 0 && api.fetchActiveTaskList) {
          try {
            const tasks = await api.fetchActiveTaskList()
            const totalLen = tasks.reduce((s, t) => s + Number(t.totalLength), 0)
            const completedLen = tasks.reduce((s, t) => s + Number(t.completedLength), 0)
            if (totalLen > 0) {
              const prog = completedLen / totalLen
              progress.value = prog
              await invoke('update_progress_bar', { progress: prog })
            } else {
              // Tasks active but unknown size (e.g. metadata)
              progress.value = 0
              await invoke('update_progress_bar', { progress: 0.0 })
            }
          } catch (e) {
            logger.debug('AppStore.progressBar', e)
          }
        } else {
          progress.value = -1
          await invoke('update_progress_bar', { progress: -1.0 })
        }
      } catch (e) {
        logger.debug('AppStore.trayDock', e)
      }
    } catch (e) {
      logger.warn('AppStore.fetchGlobalStat', (e as Error).message)
    }
  }

  async function fetchEngineInfo(api: { getVersion: () => Promise<{ version: string; enabledFeatures: string[] }> }) {
    const data = await api.getVersion()
    engineInfo.value = { ...engineInfo.value, ...data }
  }

  async function fetchEngineOptions(api: { getGlobalOption: () => Promise<Record<string, string>> }) {
    const data = await api.getGlobalOption()
    engineOptions.value = { ...engineOptions.value, ...data }
    return data
  }

  function handleDeepLinkUrls(urls: string[]) {
    if (!urls || urls.length === 0) return

    const uriLines: string[] = []

    for (const url of urls) {
      const lower = url.toLowerCase()
      if (lower.endsWith('.torrent') || (lower.startsWith('file://') && lower.includes('.torrent'))) {
        const filePath = url.startsWith('file://') ? decodeURIComponent(url.replace(/^file:\/\//, '')) : url
        showAddTaskDialog(ADD_TASK_TYPE.TORRENT, [filePath])
      } else if (
        lower.endsWith('.metalink') ||
        lower.endsWith('.meta4') ||
        (lower.startsWith('file://') && (lower.includes('.metalink') || lower.includes('.meta4')))
      ) {
        const filePath = url.startsWith('file://') ? decodeURIComponent(url.replace(/^file:\/\//, '')) : url
        showAddTaskDialog(ADD_TASK_TYPE.TORRENT, [filePath])
      } else if (lower.startsWith('magnet:')) {
        uriLines.push(url)
      } else if (lower.startsWith('thunder://')) {
        uriLines.push(decodeThunderLink(url))
      } else if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('ftp://')) {
        uriLines.push(url)
      }
    }

    if (uriLines.length > 0) {
      addTaskUrl.value = uriLines.join('\n')
      showAddTaskDialog(ADD_TASK_TYPE.URI)
    }
  }

  return {
    systemTheme,
    trayFocused,
    aboutPanelVisible,
    engineInfo,
    engineOptions,
    interval,
    stat,
    addTaskVisible,
    addTaskType,
    addTaskUrl,
    addTaskTorrents,
    addTaskOptions,
    droppedTorrentPaths,
    progress,
    pendingUpdate,
    updateInterval,
    increaseInterval,
    decreaseInterval,
    resetInterval,
    showAddTaskDialog,
    hideAddTaskDialog,
    updateAddTaskOptions,
    fetchGlobalStat,
    fetchEngineInfo,
    fetchEngineOptions,
    handleDeepLinkUrls,
  }
})
