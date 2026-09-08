import type { AppConfig } from '@shared/types'

// ── Types ───────────────────────────────────────────────────────────

export interface GeneralForm {
  [key: string]: unknown
  locale: AppConfig['locale']
  theme: AppConfig['theme']
  colorScheme: string
  customColorScheme: string
  taskCardMode: AppConfig['taskCardMode']
  reduceMotion: boolean
  taskListWatermark: boolean
  sidebarTaskCounts: boolean
  autoCheckUpdate: boolean
  autoCheckUpdateInterval: number
  updateChannel: AppConfig['updateChannel']
  showProgressBar: boolean
  dockBadgeSpeed: boolean
  openAtLogin: boolean
  autoHideWindow: boolean
  keepWindowState: boolean
  resumeAllWhenAppLaunched: boolean
  minimizeToTrayOnClose: boolean
  hideDockOnMinimize: boolean
  traySpeedometer: boolean
  lightweightMode: boolean
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the general form state from the preference store config.
 */
export function buildGeneralForm(config: AppConfig): GeneralForm {
  return {
    locale: config.locale,
    theme: config.theme,
    colorScheme: config.colorScheme,
    customColorScheme: config.customColorScheme,
    taskCardMode: config.taskCardMode,
    reduceMotion: config.reduceMotion,
    taskListWatermark: config.taskListWatermark,
    sidebarTaskCounts: config.sidebarTaskCounts,
    autoCheckUpdate: config.autoCheckUpdate,
    autoCheckUpdateInterval: config.autoCheckUpdateInterval,
    updateChannel: config.updateChannel,
    showProgressBar: config.showProgressBar,
    dockBadgeSpeed: config.dockBadgeSpeed,
    openAtLogin: config.openAtLogin,
    autoHideWindow: config.autoHideWindow,
    keepWindowState: config.keepWindowState,
    resumeAllWhenAppLaunched: config.resumeAllWhenAppLaunched,
    minimizeToTrayOnClose: config.minimizeToTrayOnClose,
    hideDockOnMinimize: config.hideDockOnMinimize,
    traySpeedometer: config.traySpeedometer,
    lightweightMode: config.lightweightMode,
  }
}
