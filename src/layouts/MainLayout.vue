<script setup lang="ts">
/** @fileoverview Main application layout with sidebar, subnav, and IPC event handling. */
import { computed, ref, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { detectKind, createBatchItem } from '@shared/utils/batchHelpers'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { logger } from '@shared/logger'
import { platform } from '@tauri-apps/plugin-os'
import AsideBar from '@/components/layout/AsideBar.vue'
import TaskSubnav from '@/components/layout/TaskSubnav.vue'
import PreferenceSubnav from '@/components/layout/PreferenceSubnav.vue'
import Speedometer from '@/components/layout/Speedometer.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import AboutPanel from '@/components/about/AboutPanel.vue'
import AddTask from '@/components/task/AddTask.vue'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { useAppNotification } from '@/composables/useAppNotification'
import { openUrl } from '@tauri-apps/plugin-opener'
import aria2Api, { isEngineReady } from '@/api/aria2'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { NModal, NButton, NSpace, NIcon, useDialog } from 'naive-ui'
import { WarningOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const navDialog = useDialog()
const message = useAppMessage()
const { notifyError } = useAppNotification()

const isMac = platform() === 'macos'
const sessionUsesNativeTrafficLights = ref<boolean | null>(isMac ? null : false)
const showCustomWindowControls = computed(() => !isMac || sessionUsesNativeTrafficLights.value === false)
const isNativeWindowChrome = computed(() => isMac && sessionUsesNativeTrafficLights.value === true)
const isCustomWindowChrome = computed(() => showCustomWindowControls.value)
const roundedShellBackground =
  'linear-gradient(90deg, var(--aside-bg) 0, var(--aside-bg) var(--aside-width), var(--subnav-bg) var(--aside-width), var(--subnav-bg) calc(var(--aside-width) + var(--subnav-width)), var(--main-bg) calc(var(--aside-width) + var(--subnav-width)), var(--main-bg) 100%)'
type ContainerStyle = { '--window-shell-background': string }
const containerStyle = computed<ContainerStyle | undefined>(() =>
  isCustomWindowChrome.value
    ? {
        '--window-shell-background': roundedShellBackground,
      }
    : undefined,
)

const isTaskPage = computed(() => route.path.startsWith('/task'))
const isPreferencePage = computed(() => route.path.startsWith('/preference'))
const showAbout = ref(false)
const appReady = ref(false)
const showExitDialog = ref(false)
const isExiting = ref(false)

const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

let unlistenDragDrop: (() => void) | null = null
let unlistenMenuEvent: (() => void) | null = null
let unlistenCloseRequested: (() => void) | null = null
let unlistenDeepLink: (() => void) | null = null
let unlistenSingleInstance: (() => void) | null = null
let globalStatTimer: ReturnType<typeof setTimeout> | null = null

function startGlobalPolling() {
  stopGlobalPolling()
  function tick() {
    if (isEngineReady()) {
      appStore.fetchGlobalStat(aria2Api).catch((e) => logger.debug('MainLayout.globalStat', e))
    }
    globalStatTimer = setTimeout(tick, appStore.interval)
  }
  globalStatTimer = setTimeout(tick, appStore.interval)
}

function stopGlobalPolling() {
  if (globalStatTimer) {
    clearTimeout(globalStatTimer)
    globalStatTimer = null
  }
}

watch(
  () => appStore.pendingUpdate,
  (update) => {
    if (update) {
      nextTick(() => updateDialogRef.value?.open())
      appStore.pendingUpdate = null
    }
  },
)

async function handleExitConfirm() {
  isExiting.value = true
  showExitDialog.value = false
  appReady.value = false
  await new Promise((r) => setTimeout(r, 250))
  const appWindow = getCurrentWindow()
  await appWindow.destroy()
  // Terminate the Tauri process. destroy() only closes the webview;
  // without exit(), the tray icon and aria2 sidecar stay alive.
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

function handleExitCancel() {
  showExitDialog.value = false
}

onMounted(async () => {
  setTimeout(() => {
    appReady.value = true
  }, 120)
  startGlobalPolling()

  // Drain startup errors queued before Vue context was available
  if (appStore.startupErrors.length > 0) {
    for (const err of appStore.startupErrors) {
      notifyError(err.rawMessage, err.category)
    }
    appStore.startupErrors = []
  }

  router.beforeEach((to, from) => {
    const leavingPrefs = from.path.startsWith('/preference') && !to.path.startsWith('/preference')
    const switchingPrefsTab =
      from.path.startsWith('/preference') && to.path.startsWith('/preference') && from.path !== to.path
    if ((leavingPrefs || switchingPrefsTab) && preferenceStore.pendingChanges) {
      return new Promise<boolean>((resolve) => {
        navDialog.warning({
          title: t('preferences.not-saved'),
          content: t('preferences.not-saved-confirm'),
          positiveText: t('preferences.save-and-leave'),
          negativeText: t('preferences.leave-without-saving'),
          onPositiveClick: async () => {
            try {
              if (preferenceStore.saveBeforeLeave) {
                await preferenceStore.saveBeforeLeave()
              }
              preferenceStore.pendingChanges = false
              resolve(true)
            } catch (e) {
              notifyError(e, 'config')
              resolve(false)
            }
          },
          onNegativeClick: () => {
            preferenceStore.pendingChanges = false
            resolve(true)
          },
          onClose: () => {
            resolve(false)
          },
          onMaskClick: () => {
            resolve(false)
          },
        })
      })
    }
    return true
  })

  const webview = getCurrentWebview()
  unlistenDragDrop = await webview.onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      const paths = event.payload.paths
      const validPaths =
        paths?.filter((p: string) => p.endsWith('.torrent') || p.endsWith('.metalink') || p.endsWith('.meta4')) || []
      if (validPaths.length > 0) {
        const items = validPaths.map((p: string) => createBatchItem(detectKind(p), p))
        const skipped = appStore.enqueueBatch(items)
        if (skipped > 0) message.warning(t('task.duplicate-task'))
      }
    }
  })
  unlistenMenuEvent = await listen<string>('menu-event', async (event) => {
    const action = event.payload
    switch (action) {
      case 'new-task':
        appStore.showAddTaskDialog()
        break
      case 'open-torrent': {
        const selected = await openDialog({
          multiple: true,
          filters: [{ name: 'Torrent / Metalink', extensions: ['torrent', 'metalink', 'meta4'] }],
        })
        if (typeof selected === 'string') {
          const skipped = appStore.enqueueBatch([createBatchItem(detectKind(selected), selected)])
          if (skipped > 0) message.warning(t('task.duplicate-task'))
        } else if (Array.isArray(selected) && selected.length > 0) {
          const skipped = appStore.enqueueBatch(selected.map((p) => createBatchItem(detectKind(p), p)))
          if (skipped > 0) message.warning(t('task.duplicate-task'))
        }
        break
      }
      case 'preferences':
        router.push('/preference').catch(() => {
          /* duplicate navigation */
        })
        break
      case 'resume-all':
        taskStore.resumeAllTask().catch((e) => notifyError(e))
        break
      case 'pause-all':
        taskStore.pauseAllTask().catch((e) => notifyError(e))
        break
      case 'release-notes':
        openUrl('https://github.com/AnInsomniacy/motrix-next/releases').catch((e) => notifyError(e))
        break
      case 'report-issue':
        openUrl('https://github.com/AnInsomniacy/motrix-next/issues').catch((e) => notifyError(e))
        break
    }
  })

  unlistenDeepLink = await listen<string[]>('deep-link-open', (event) => {
    appStore.handleDeepLinkUrls(event.payload)
  })

  unlistenSingleInstance = await listen<string[]>('single-instance-triggered', (event) => {
    const argv = event.payload
    const urls = argv.filter(
      (a) =>
        !a.startsWith('-') &&
        (a.includes('://') || a.endsWith('.torrent') || a.endsWith('.metalink') || a.endsWith('.meta4')),
    )
    if (urls.length > 0) appStore.handleDeepLinkUrls(urls)
  })

  const appWindow = getCurrentWindow()
  if (isMac) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const state = await invoke<{ nativeTrafficLightsVisible: boolean }>('get_window_chrome_state')
      sessionUsesNativeTrafficLights.value = state.nativeTrafficLightsVisible
    } catch (e) {
      logger.debug('MainLayout.windowChromeState', e)
      sessionUsesNativeTrafficLights.value = !!preferenceStore.config.useNativeTrafficLights
    }
  }

  unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault()

    // When minimize-to-tray is enabled, hide the window instead of prompting
    // to exit. This covers all native close paths: taskbar close, Alt+F4,
    // GNOME Activities overview ×, and WM-level close signals on Wayland.
    if (preferenceStore.config.minimizeToTrayOnClose) {
      await appWindow.hide()
      return
    }

    if (!isExiting.value) {
      showExitDialog.value = true
    }
  })

  // Sync native menu labels with current locale
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('update_tray_menu_labels', {
      labels: {
        show: t('app.show'),
        'tray-new-task': t('app.tray-new-task'),
        'tray-resume-all': t('app.tray-resume-all'),
        'tray-pause-all': t('app.tray-pause-all'),
        'tray-quit': t('app.quit'),
      },
    })
    await invoke('update_menu_labels', {
      labels: {
        'new-task': t('app.menu-new-task'),
        'open-torrent': t('app.menu-open-torrent'),
        preferences: t('app.menu-preferences'),
        'release-notes': t('app.menu-release-notes'),
        'report-issue': t('app.menu-report-issue'),
      },
    })
  } catch (e) {
    logger.debug('MainLayout.trayMenu', e)
  }
})

onUnmounted(() => {
  stopGlobalPolling()
  if (unlistenDragDrop) unlistenDragDrop()
  if (unlistenMenuEvent) unlistenMenuEvent()
  if (unlistenCloseRequested) unlistenCloseRequested()
  if (unlistenDeepLink) unlistenDeepLink()
  if (unlistenSingleInstance) unlistenSingleInstance()
})
</script>

<template>
  <div
    id="container"
    :class="{
      'app-ready': appReady,
      'app-closing': isExiting,
      'native-window-chrome': isNativeWindowChrome,
      'custom-window-chrome': isCustomWindowChrome,
    }"
    :style="containerStyle"
  >
    <AsideBar @show-about="showAbout = true" />
    <div class="subnav-slot">
      <Transition name="fade" mode="out-in">
        <TaskSubnav v-if="isTaskPage" key="task-subnav" />
        <PreferenceSubnav v-else-if="isPreferencePage" key="pref-subnav" />
      </Transition>
    </div>
    <main class="content">
      <router-view v-slot="{ Component, route: viewRoute }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" :key="viewRoute.path" />
        </Transition>
      </router-view>
    </main>
    <WindowControls v-if="showCustomWindowControls" class="window-controls" />
    <Speedometer />
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask :show="appStore.addTaskVisible" @close="appStore.hideAddTaskDialog()" />
    <UpdateDialog ref="updateDialogRef" />

    <!-- Exit confirmation dialog with synchronized fade animation -->
    <NModal
      :show="showExitDialog"
      preset="card"
      :title="t('app.confirm-exit-title')"
      :bordered="false"
      :closable="true"
      :mask-closable="true"
      size="small"
      style="width: 400px"
      transform-origin="center"
      @update:show="
        (v: boolean) => {
          if (!v) handleExitCancel()
        }
      "
    >
      <div class="exit-dialog-body">
        <NIcon :size="22" color="var(--color-primary)" style="margin-right: 8px; flex-shrink: 0">
          <WarningOutline />
        </NIcon>
        <span>{{ t('app.confirm-exit-message') }}</span>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton class="exit-btn" @click="handleExitCancel">
            {{ t('app.no') }}
          </NButton>
          <NButton class="exit-btn" type="warning" @click="handleExitConfirm">
            {{ t('app.yes') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
#container {
  display: flex;
  height: 100vh;
  position: relative;
  background: var(--window-shell-background, transparent);
  border-radius: 12px;
  overflow: hidden;
  opacity: 0;
  transform: scale(0.96);
  transition:
    opacity 650ms cubic-bezier(0.05, 0.7, 0.1, 1),
    transform 650ms cubic-bezier(0.05, 0.7, 0.1, 1);
}
#container.native-window-chrome {
  border-radius: 0;
}
#container.app-ready {
  opacity: 1;
  transform: scale(1);
}
#container.app-closing {
  transition:
    opacity 200ms cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 200ms cubic-bezier(0.3, 0, 0.8, 0.15);
  opacity: 0;
  transform: scale(0.96);
}
.subnav-slot {
  width: var(--subnav-width);
  flex-shrink: 0;
  background-color: var(--subnav-bg);
}
.content {
  flex: 1;
  overflow-y: auto;
  background-color: var(--main-bg);
}
.window-controls {
  position: fixed;
  top: 6px;
  right: 12px;
  z-index: 100;
}
.exit-dialog-body {
  display: flex;
  align-items: center;
  font-size: 14px;
  line-height: 1.6;
  padding: 4px 0;
}
.exit-btn {
  min-width: 80px;
  padding: 0 24px;
}
</style>
