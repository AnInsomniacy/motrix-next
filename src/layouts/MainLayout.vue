<script setup lang="ts">
/** @fileoverview Main application layout with sidebar, subnav, and IPC event handling. */
import { computed, ref, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { logger } from '@shared/logger'
import { throttledResizeHandler, cancelPendingResize } from '@/layouts/resizeThrottle'
import AsideBar from '@/components/layout/AsideBar.vue'
import TaskSubnav from '@/components/layout/TaskSubnav.vue'
import PreferenceSubnav from '@/components/layout/PreferenceSubnav.vue'
import Speedometer from '@/components/layout/Speedometer.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import EngineOverlay from '@/components/layout/EngineOverlay.vue'
import AboutPanel from '@/components/about/AboutPanel.vue'
import AddTask from '@/components/task/AddTask.vue'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { NModal, NButton, NSpace, NIcon, NCheckbox, useDialog } from 'naive-ui'
import { WarningOutline } from '@vicons/ionicons5'
import { useAppEvents } from '@/composables/useAppEvents'

const { t } = useI18n()
const route = useRoute()
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
const isMaximized = ref(false)
const showEngineOverlay = ref(false)

const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

let unlistenDragDrop: (() => void) | null = null
let unlistenMenuEvent: (() => void) | null = null
let unlistenCloseRequested: (() => void) | null = null
let unlistenDeepLink: (() => void) | null = null
let unlistenSingleInstance: (() => void) | null = null
let unlistenTrayMenu: (() => void) | null = null
let unlistenResize: (() => void) | null = null
let unlistenExitDialog: (() => void) | null = null
let unlistenRestoreExitDialog: (() => void) | null = null
let globalStatTimer: ReturnType<typeof setTimeout> | null = null

import aria2Api, { isEngineReady } from '@/api/aria2'

const { setupListeners } = useAppEvents({
  t,
  appStore,
  taskStore,
  preferenceStore,
  message,
  navDialog,
  showEngineOverlay,
  isExiting,
  handleExitConfirm,
  onAbout: () => {
    showAbout.value = true
  },
})

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

/**
 * Handle the maximize-toggled event from WindowControls.
 * Query isMaximized() after a delay to let the native animation settle.
 * This is safe on all platforms — the bug only triggers inside onResized.
 */
async function onMaximizeToggled() {
  setTimeout(async () => {
    const appWindow = getCurrentWindow()
    isMaximized.value = await appWindow.isMaximized()
  }, 300)
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
  // exit(0) sends an IPC call to Rust — if we destroy() first,
  // the webview is gone and the IPC silently fails.
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

    // Signal Rust to hide the Dock icon if the user opted in.
    // The Rust command reads the preference from the persistent store.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_dock_visible', { visible: false })

    await appWindow.hide()
  }
}

function handleExitCancel() {
  showExitDialog.value = false
  rememberChoice.value = false
}

onMounted(async () => {
  // Show the main window now that the frontend has mounted and the
  // webview has renderable content.  This prevents the transparent-frame
  // flash on Windows where DWM renders a native shadow before WebView2
  // finishes initializing.  Follows Tauri official recommendation:
  // visible:false in config → show() from frontend when content is ready.
  //
  // Skip show when the app was launched by OS autostart AND the user has
  // opted into "minimize to tray on autostart" — the window stays hidden.
  {
    const { invoke } = await import('@tauri-apps/api/core')
    const isAutostart: boolean = await invoke('is_autostart_launch')
    const shouldHide = isAutostart && !!preferenceStore.config.autoHideWindow
    if (!shouldHide) {
      const appWindow = getCurrentWindow()
      await appWindow.show()
      await appWindow.setFocus()
    }
  }

  setTimeout(() => {
    appReady.value = true
  }, 120)
  startGlobalPolling()

  // Track maximize state to remove border-radius when maximized.
  // Windows and Linux need this: transparent + decorations:false windows
  // leak transparent pixels through CSS border-radius corners when maximized.
  //
  // macOS: Native window handles rounding; isMaximized() inside onResized
  // triggers an infinite loop (tauri-apps/tauri#5812).
  //
  // Linux + WEBKIT_DISABLE_DMABUF_RENDERER=1 (typically NVIDIA):
  // WebKitGTK software compositing loses the alpha channel after a
  // maximize → restore cycle, breaking border-radius corners.
  // WORKAROUND: keep border-radius at all times on affected systems.
  // See: https://bugs.webkit.org/show_bug.cgi?id=262607 (RESOLVED WONTFIX)
  {
    const appWindow = getCurrentWindow()
    const isWindows = navigator.userAgent.includes('Windows')
    const isLinux = navigator.userAgent.includes('Linux')

    let shouldTrackMaximize = isWindows

    if (isLinux) {
      const { invoke } = await import('@tauri-apps/api/core')
      const dmabufDisabled = await invoke<boolean>('is_dmabuf_renderer_disabled')
      shouldTrackMaximize = !dmabufDisabled
    }

    if (shouldTrackMaximize) {
      isMaximized.value = await appWindow.isMaximized()
      unlistenResize = await appWindow.onResized(() => {
        throttledResizeHandler(async () => {
          isMaximized.value = await appWindow.isMaximized()
        })
      })
    }
  }

  // Engine-init feedback, navigation guards, IPC listeners, and crash recovery
  // are encapsulated in the useAppEvents composable.
  const listeners = await setupListeners()
  unlistenDragDrop = listeners.unlistenDragDrop
  unlistenMenuEvent = listeners.unlistenMenuEvent
  unlistenTrayMenu = listeners.unlistenTrayMenu
  unlistenDeepLink = listeners.unlistenDeepLink
  unlistenSingleInstance = listeners.unlistenSingleInstance

  const appWindow = getCurrentWindow()
  // Close prevention is handled by Rust Builder::on_window_event() — the
  // FIRST hook in Tauri's event lifecycle, which reliably calls
  // api.prevent_close() before the compositor can destroy the window.
  // This JS handler fires SECOND (async IPC) and acts as a redundant
  // fallback for the custom close button in WindowControls.vue.
  //
  // Do NOT call event.preventDefault() here — it is redundant with the
  // Rust hook and causes a webview freeze on macOS (Tauri v2 bug).
  unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
    void event
    if (preferenceStore.config.minimizeToTrayOnClose) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_dock_visible', { visible: false })
      await appWindow.hide()
      return
    }
    if (!isExiting.value) {
      rememberChoice.value = !!preferenceStore.config.minimizeToTrayOnClose
      showExitDialog.value = true
    }
  })

  // Rust emits "show-exit-dialog" when the native close is intercepted
  // and minimize-to-tray is NOT enabled. This is more reliable than the
  // JS onCloseRequested listener on Linux/Wayland with decorations:false,
  // where certain close paths (taskbar close, GNOME overview ×) do not
  // trigger the webview callback.
  unlistenExitDialog = await listen('show-exit-dialog', () => {
    if (!isExiting.value) {
      showExitDialog.value = true
    }
  })

  // Linux/Wayland + decorations:false: Rust hides the window BEFORE emitting
  // this event to prevent the Wayland compositor from destroying it.  We must
  // re-show the window and set focus before displaying the exit dialog.
  //
  // Industry reference: Clash Verge Rev unconditionally hides on all
  // CloseRequested events; we only do this on Linux to avoid flicker on
  // macOS/Windows where prevent_close() is reliable.
  unlistenRestoreExitDialog = await listen('restore-and-show-exit-dialog', async () => {
    if (!isExiting.value) {
      await appWindow.show()
      await appWindow.setFocus()
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
        // Custom menu items (matched by ID)
        about: t('app.menu-about'),
        'new-task': t('app.menu-new-task'),
        'open-torrent': t('app.menu-open-torrent'),
        preferences: t('app.menu-preferences'),
        'release-notes': t('app.menu-release-notes'),
        'report-issue': t('app.menu-report-issue'),
        'minimize-window': t('app.menu-minimize'),
        'zoom-window': t('app.menu-zoom'),
        'close-window': t('app.menu-close-window'),
        // Submenu titles (matched by ID)
        'file-menu': t('app.menu-file'),
        'edit-menu': t('app.menu-edit'),
        'window-menu': t('app.menu-window'),
        'help-menu': t('app.menu-help'),
        // PredefinedMenuItems — keyed by English default text because
        // their IDs are auto-generated UUIDs that cannot be predicted.
        Undo: t('app.menu-undo'),
        Redo: t('app.menu-redo'),
        Cut: t('app.menu-cut'),
        Copy: t('app.menu-copy'),
        Paste: t('app.menu-paste'),
        'Select All': t('app.menu-select-all'),
        'Hide MotrixNext': t('app.hide'),
        'Hide Others': t('app.hide-others'),
        'Show All': t('app.unhide'),
        'Quit MotrixNext': t('app.quit'),
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
  if (unlistenResize) unlistenResize()
  if (unlistenExitDialog) unlistenExitDialog()
  if (unlistenRestoreExitDialog) unlistenRestoreExitDialog()
  cancelPendingResize()
})
</script>

<template>
  <div id="container" :class="{ 'app-ready': appReady, 'app-closing': isExiting, maximized: isMaximized }">
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
        <Transition name="fade" mode="out-in" appear>
          <component :is="Component" :key="viewRoute.path" />
        </Transition>
      </router-view>
    </main>
    <WindowControls
      class="window-controls"
      :is-maximized="isMaximized"
      @close="showExitDialog = true"
      @maximize-toggled="onMaximizeToggled"
    />
    <Speedometer />
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask :show="appStore.addTaskVisible" @close="appStore.hideAddTaskDialog()" />
    <UpdateDialog ref="updateDialogRef" />
    <EngineOverlay
      :show="showEngineOverlay"
      @recovered="showEngineOverlay = false"
      @close="showEngineOverlay = false"
    />

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
    transform 650ms cubic-bezier(0.05, 0.7, 0.1, 1),
    border-radius 0.2s cubic-bezier(0.2, 0, 0, 1);
}
#container.maximized {
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
  will-change: transform;
  contain: layout style paint;
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
