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
import { openUrl } from '@tauri-apps/plugin-opener'
import aria2Api, { isEngineReady } from '@/api/aria2'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { NModal, NButton, NSpace, NIcon, NCheckbox, useDialog } from 'naive-ui'
import { WarningOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const navDialog = useDialog()
const message = useAppMessage()

const isTaskPage = computed(() => route.path.startsWith('/task'))
const isPreferencePage = computed(() => route.path.startsWith('/preference'))
const showAbout = ref(false)
const appReady = ref(false)
const showExitDialog = ref(false)
const isExiting = ref(false)
const rememberChoice = ref(false)
const pendingTrayHide = ref(false)

const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

let unlistenDragDrop: (() => void) | null = null
let unlistenMenuEvent: (() => void) | null = null
let unlistenCloseRequested: (() => void) | null = null
let unlistenDeepLink: (() => void) | null = null
let unlistenSingleInstance: (() => void) | null = null
let unlistenTrayMenu: (() => void) | null = null
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
  // Checkbox means "always minimize to tray from now on" —
  // save the setting even when quitting this time.
  if (rememberChoice.value) {
    preferenceStore.config.minimizeToTrayOnClose = true
    await preferenceStore.savePreference()
  }
  isExiting.value = true
  showExitDialog.value = false
  rememberChoice.value = false
  appReady.value = false
  await new Promise((r) => setTimeout(r, 250))
  const appWindow = getCurrentWindow()
  await appWindow.destroy()
  // Terminate the Tauri process. destroy() only closes the webview;
  // without exit(), the tray icon and aria2 sidecar stay alive.
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

async function handleMinimizeToTray() {
  if (rememberChoice.value) {
    preferenceStore.config.minimizeToTrayOnClose = true
    await preferenceStore.savePreference()
  }
  // Defer window hide until NModal exit animation completes.
  // If we hide immediately, the GPU compositor caches the frame with
  // the dialog still visible, causing a flash when the window re-shows.
  pendingTrayHide.value = true
  showExitDialog.value = false
  rememberChoice.value = false
}

async function onExitDialogAfterLeave() {
  if (pendingTrayHide.value) {
    pendingTrayHide.value = false
    const appWindow = getCurrentWindow()
    await appWindow.hide()
    if (preferenceStore.config.hideDockOnMinimize) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_dock_visible', { visible: false })
    }
  }
}

function handleExitCancel() {
  showExitDialog.value = false
  rememberChoice.value = false
}

onMounted(async () => {
  setTimeout(() => {
    appReady.value = true
  }, 120)
  startGlobalPolling()

  // Show feedback when the engine finishes initializing (or re-initializing
  // after a hot-reload restart triggered from Advanced preferences).
  // Persistent watcher — must survive multiple restart cycles.
  watch(
    () => appStore.engineInitializing,
    (initializing) => {
      if (!initializing) {
        if (appStore.engineReady) {
          message.success(t('app.engine-ready'))
        } else {
          message.error(t('app.engine-failed'), { duration: 8000, closable: true })
        }
      }
    },
  )

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
              console.error('Save before leave failed:', e)
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
        taskStore.resumeAllTask().catch(console.error)
        break
      case 'pause-all':
        taskStore.pauseAllTask().catch(console.error)
        break
      case 'release-notes':
        openUrl('https://github.com/AnInsomniacy/motrix-next/releases').catch(console.error)
        break
      case 'report-issue':
        openUrl('https://github.com/AnInsomniacy/motrix-next/issues').catch(console.error)
        break
    }
  })

  // Bridge custom tray popup actions (Windows) to main window.
  // The tray-menu window emits 'tray-menu-action' with the item id as payload.
  unlistenTrayMenu = await listen<string>('tray-menu-action', async (event) => {
    const action = event.payload
    const mainWindow = getCurrentWindow()
    switch (action) {
      case 'show':
        await mainWindow.show()
        await mainWindow.setFocus()
        break
      case 'new-task':
        await mainWindow.show()
        await mainWindow.setFocus()
        appStore.showAddTaskDialog()
        break
      case 'resume-all':
        taskStore.resumeAllTask().catch(console.error)
        break
      case 'pause-all':
        taskStore.pauseAllTask().catch(console.error)
        break
      case 'quit': {
        const window = getCurrentWindow()
        await window.destroy()
        break
      }
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
  unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault()

    // When minimize-to-tray is enabled, hide the window instead of prompting
    // to exit. This covers all native close paths: taskbar close, Alt+F4,
    // GNOME Activities overview ×, and WM-level close signals on Wayland.
    if (preferenceStore.config.minimizeToTrayOnClose) {
      await appWindow.hide()
      if (preferenceStore.config.hideDockOnMinimize) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('set_dock_visible', { visible: false })
      }
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
  if (unlistenTrayMenu) unlistenTrayMenu()
})
</script>

<template>
  <div id="container" :class="{ 'app-ready': appReady, 'app-closing': isExiting }">
    <!-- Minimal progress bar during engine initialization / restart -->
    <Transition name="init-slide">
      <div v-if="appStore.engineInitializing" class="init-banner">
        <div class="init-progress" />
      </div>
    </Transition>
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
    <WindowControls class="window-controls" />
    <Speedometer />
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask :show="appStore.addTaskVisible" @close="appStore.hideAddTaskDialog()" />
    <UpdateDialog ref="updateDialogRef" />

    <!-- Close action dialog: minimize-to-tray / quit / cancel -->
    <NModal
      :show="showExitDialog"
      preset="card"
      :title="t('app.close-action-title')"
      :bordered="false"
      :closable="true"
      :mask-closable="true"
      size="small"
      style="width: 480px"
      transform-origin="center"
      @after-leave="onExitDialogAfterLeave"
      @update:show="
        (v: boolean) => {
          if (!v) handleExitCancel()
        }
      "
    >
      <div class="exit-dialog-body">
        <NIcon :size="20" color="var(--color-primary)" style="flex-shrink: 0">
          <WarningOutline />
        </NIcon>
        <span>{{ t('app.close-action-message') }}</span>
      </div>
      <div class="remember-choice">
        <NCheckbox v-model:checked="rememberChoice">
          {{ t('app.remember-close-choice') }}
        </NCheckbox>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton class="exit-btn" @click="handleExitCancel">
            {{ t('app.cancel') }}
          </NButton>
          <NButton class="exit-btn" @click="handleMinimizeToTray">
            {{ t('app.minimize-to-tray') }}
          </NButton>
          <NButton class="exit-btn" type="warning" @click="handleExitConfirm">
            {{ t('app.quit-app') }}
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
  border-radius: 12px;
  overflow: hidden;
  opacity: 0;
  transform: scale(0.96);
  transition:
    opacity 650ms cubic-bezier(0.05, 0.7, 0.1, 1),
    transform 650ms cubic-bezier(0.05, 0.7, 0.1, 1);
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
  justify-content: center;
  gap: 10px;
  font-size: 14px;
  line-height: 1.6;
  padding: 8px 0 4px;
}
.exit-btn {
  min-width: 88px;
  padding: 0 20px;
}
.remember-choice {
  margin-top: 16px;
  margin-bottom: 8px;
  display: flex;
  justify-content: center;
  font-size: 13px;
  opacity: 0.85;
}

/* Minimal progress bar during engine initialization / restart */
.init-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 200;
  overflow: hidden;
  pointer-events: none;
}
.init-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  width: 30%;
  background: linear-gradient(90deg, transparent, var(--color-primary), transparent);
  animation: init-indeterminate 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
@keyframes init-indeterminate {
  0% {
    left: -30%;
  }
  100% {
    left: 100%;
  }
}
.init-slide-enter-active {
  transition:
    transform 0.25s cubic-bezier(0, 0, 0, 1),
    opacity 0.2s linear;
}
.init-slide-leave-active {
  transition:
    transform 0.2s cubic-bezier(0.3, 0, 1, 1),
    opacity 0.15s linear;
}
.init-slide-enter-from,
.init-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
