<script setup lang="ts">
/** @fileoverview Custom window control buttons (minimize, maximize/restore, close). */
import { computed } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { NIcon } from 'naive-ui'
import { RemoveOutline, CopyOutline, SquareOutline, CloseOutline } from '@vicons/ionicons5'
import { usePreferenceStore } from '@/stores/preference'

defineProps<{
  isMaximized: boolean
}>()

const emit = defineEmits<{
  close: []
  'maximize-toggled': []
}>()

const appWindow = getCurrentWindow()
const preferenceStore = usePreferenceStore()
const isMacOS = computed(() => {
  return navigator.userAgent.includes('Macintosh')
})

function minimize() {
  appWindow.minimize()
}

function toggleMaximize() {
  appWindow.toggleMaximize()
  emit('maximize-toggled')
}

async function close() {
  if (preferenceStore.config.minimizeToTrayOnClose) {
    // Signal Rust to hide the Dock icon if the user opted in.
    // The Rust command reads the preference from the persistent store.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_dock_visible', { visible: false })

    appWindow.hide()
  } else {
    // Emit to parent instead of triggering the native window close.
    // On macOS, the native close → onCloseRequested → preventDefault()
    // flow freezes the webview (known Tauri v2 bug).  The parent
    // (MainLayout) handles showing the exit confirmation dialog.
    emit('close')
  }
}
</script>

<template>
  <div class="window-controls" :class="{ macos: isMacOS }">
    <template v-if="isMacOS">
      <button class="ctrl-btn close" title="Close" @click="close">
        <span class="icon"></span>
      </button>
      <button class="ctrl-btn minimize" title="Minimize" @click="minimize">
        <span class="icon"></span>
      </button>
      <button class="ctrl-btn maximize" :title="isMaximized ? 'Restore' : 'Maximize'" @click="toggleMaximize">
        <span v-if="!isMaximized" class="icon">
          <svg
            t="1773827239597"
            class="svg-icon"
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="27516"
          >
            <path
              d="M805.142857 354.342857c7.028571 7.028571 10.514286 15.6 10.514286 25.885714V742.285714c0 10.228571-3.485714 18.857143-10.514286 25.885715-7.028571 7.028571-15.6 10.514286-25.885714 10.514285H417.257143c-10.228571 0-18.857143-3.485714-25.885714-10.514285-7.028571-7.028571-10.514286-15.6-10.514286-25.885715s3.485714-18.857143 10.514286-25.885714l362.057142-362.057143c7.028571-7.028571 15.6-10.514286 25.885715-10.514286s18.8 3.542857 25.828571 10.514286z m-155.142857-155.142857c7.028571 7.028571 10.514286 15.6 10.514286 25.885714 0 10.228571-3.485714 18.857143-10.514286 25.885715l-362.057143 362.057142c-7.028571 7.028571-15.6 10.514286-25.885714 10.514286-10.228571 0-18.857143-3.485714-25.885714-10.514286-7.028571-7.028571-10.514286-15.6-10.514286-25.885714V225.085714c0-10.228571 3.485714-18.857143 10.514286-25.885714s15.6-10.514286 25.885714-10.514286h362.057143c10.228571 0 18.857143 3.542857 25.885714 10.514286z"
              p-id="27517"
            ></path>
          </svg>
        </span>
        <span v-else class="icon">
          <svg
            t="1773827322468"
            class="svg-icon"
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="29377"
          >
            <path
              d="M960 512L512 960V640a128 128 0 0 1 128-128h320zM512 64V384a128 128 0 0 1-128 128H64L512 64z"
              p-id="29378"
            ></path>
          </svg>
        </span>
      </button>
    </template>
    <template v-else>
      <button class="ctrl-btn" title="Minimize" @click="minimize">
        <NIcon :size="14"><RemoveOutline /></NIcon>
      </button>
      <button class="ctrl-btn" :title="isMaximized ? 'Restore' : 'Maximize'" @click="toggleMaximize">
        <NIcon :size="14">
          <Transition name="icon-swap" mode="out-in">
            <CopyOutline v-if="isMaximized" key="restore" />
            <SquareOutline v-else key="maximize" />
          </Transition>
        </NIcon>
      </button>
      <button class="ctrl-btn close" title="Close" @click="close">
        <NIcon :size="14"><CloseOutline /></NIcon>
      </button>
    </template>
  </div>
</template>

<style scoped>
.window-controls.macos {
  right: auto;
  left: 12px;
}
.window-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Non-macOS styles */
.ctrl-btn {
  width: 32px;
  height: 32px;
  border: 1px solid var(--window-ctrl-border);
  border-radius: 8px;
  background: var(--window-ctrl-bg);
  color: var(--window-ctrl-color);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  outline: none;
  padding: 0;
}
.ctrl-btn:hover {
  background: var(--window-ctrl-hover-bg);
  border-color: var(--window-ctrl-hover-border);
  color: var(--window-ctrl-hover-color);
}
.ctrl-btn.close:hover {
  background: rgba(255, 59, 48, 0.75);
  border-color: rgba(255, 59, 48, 0.9);
  color: #fff;
}

/* macOS styles */
.window-controls.macos {
  gap: 8px;
}
.window-controls.macos .ctrl-btn {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: none;
  padding: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}
.window-controls.macos .ctrl-btn.close {
  background-color: #ff5f56;
}
.window-controls.macos .ctrl-btn.minimize {
  background-color: #ffbd2e;
}
.window-controls.macos .ctrl-btn.maximize {
  background-color: #27ca3f;
}

/* macOS icon styles - show all icons when hovering over the container */
.window-controls.macos .ctrl-btn .icon {
  width: 10px;
  height: 10px;
  opacity: 0;
  transition: opacity 0.2s ease;
  position: relative;
}

.window-controls.macos:hover .ctrl-btn .icon {
  opacity: 1;
}

/* SVG icon styles */
.window-controls.macos .ctrl-btn .svg-icon {
  width: 10px;
  height: 10px;
  fill: rgba(0, 0, 0, 0.9);
}

/* Close button icon */
.window-controls.macos .ctrl-btn.close .icon {
  width: 10px;
  height: 10px;
  position: relative;
}

.window-controls.macos .ctrl-btn.close .icon::before,
.window-controls.macos .ctrl-btn.close .icon::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 7px;
  height: 1px;
  background-color: rgba(0, 0, 0, 0.9);
  transform: translate(-50%, -50%) rotate(45deg);
}

.window-controls.macos .ctrl-btn.close .icon::after {
  transform: translate(-50%, -50%) rotate(-45deg);
}

/* Minimize button icon */
.window-controls.macos .ctrl-btn.minimize .icon {
  width: 7px;
  height: 1px;
  background-color: rgba(0, 0, 0, 0.9);
  margin-top: -0.5px;
}

/* Maximize button icon */
.window-controls.macos .ctrl-btn.maximize .icon svg {
  width: 10px;
  height: 10px;
  position: absolute;
  top: 0;
  left: 0;
}

/* Restore button icon */
.window-controls.macos .ctrl-btn.maximize .icon.restore svg {
  width: 10px;
  height: 10px;
  position: absolute;
  top: 0;
  left: 0;
}

/* Hover effects */
.window-controls.macos .ctrl-btn:hover {
  opacity: 0.8;
}

.window-controls.macos .ctrl-btn.close:hover {
  background-color: #ff453a;
}

.window-controls.macos .ctrl-btn.minimize:hover {
  background-color: #ffaa00;
}

.window-controls.macos .ctrl-btn.maximize:hover {
  background-color: #30d158;
}

/* Icon cross-fade animation for maximize ↔ restore toggle */
.icon-swap-enter-active,
.icon-swap-leave-active {
  transition:
    opacity 150ms ease,
    transform 150ms ease;
}
.icon-swap-enter-from {
  opacity: 0;
  transform: scale(0.75);
}
.icon-swap-leave-to {
  opacity: 0;
  transform: scale(0.75);
}
</style>
