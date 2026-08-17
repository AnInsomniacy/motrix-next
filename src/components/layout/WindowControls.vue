<script setup lang="ts">
/**
 * @fileoverview Platform-aware window control buttons.
 *
 * On macOS, native traffic lights are provided by the OS via
 * `titleBarStyle: "Overlay"` in tauri.macos.conf.json — this component
 * renders nothing.
 *
 * On Windows/Linux, renders caption-style buttons matching the Windows 11
 * Fluent Design specification: 46×32px borderless rectangles with inline
 * SVG symbols, transparent by default, with hover/unfocused states.
 * The close button uses the official Windows 11 red (#C42B1C) on hover.
 *
 * On Android there is no desktop window — renders nothing.
 *
 * Colors derive from --m3-on-surface so they automatically adapt to the
 * active color scheme (10 presets) and light/dark mode without hardcoding.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from 'vue-i18n'
import MTooltip from '@/components/common/MTooltip.vue'
import { usePreferenceStore } from '@/stores/preference'

const props = defineProps<{
  isMaximized: boolean
  /** Current OS platform identifier (e.g. 'macos', 'windows', 'linux', 'android'). */
  platform: string
}>()

const emit = defineEmits<{
  close: []
  'maximize-toggled': []
}>()

const { t } = useI18n()
const appWindow = getCurrentWindow()
const preferenceStore = usePreferenceStore()

/** macOS uses native traffic lights — hide custom controls entirely. */
const isMac = computed(() => props.platform === 'macos')
/** Android has no desktop window chrome — hide custom controls entirely. */
const isMobile = computed(() => props.platform === 'android')

// ── Window focus state ──────────────────────────────────────────────
const isFocused = ref(true)
let unlistenFocus: (() => void) | null = null

onMounted(async () => {
  if (!isMac.value) {
    unlistenFocus = await appWindow.onFocusChanged(({ payload }) => {
      isFocused.value = payload
    })
  }
})

onUnmounted(() => {
  unlistenFocus?.()
})

// ── Window actions ──────────────────────────────────────────────────

function minimize() {
  appWindow.minimize()
}

function toggleMaximize() {
  appWindow.toggleMaximize()
  emit('maximize-toggled')
}

async function close() {
  if (preferenceStore.config.minimizeToTrayOnClose) {
    // Trigger native CloseRequested → Rust on_window_event handles
    // hide/destroy via handle_minimize_to_tray() + Dock visibility.
    appWindow.close()
  } else {
    emit('close')
  }
}
</script>

<template>
  <!-- macOS: native traffic lights provided by OS; Android: no desktop chrome — render nothing -->
  <div v-if="!isMac && !isMobile" class="caption-bar" :class="{ unfocused: !isFocused }">
    <MTooltip placement="bottom">
      <template #trigger>
        <button class="caption-btn" :aria-label="t('app.menu-minimize')" @click="minimize">
          <!-- Minimize: horizontal line -->
          <svg width="10" height="1" viewBox="0 0 10 1" fill="none" aria-hidden="true">
            <path d="M0 .5h10" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
      </template>
      {{ t('app.menu-minimize') }}
    </MTooltip>

    <MTooltip placement="bottom">
      <template #trigger>
        <button
          class="caption-btn"
          :aria-label="isMaximized ? t('app.window-restore') : t('app.window-maximize')"
          @click="toggleMaximize"
        >
          <Transition name="icon-swap" mode="out-in">
            <!-- Restore: two overlapping rectangles -->
            <svg
              v-if="isMaximized"
              key="restore"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden="true"
            >
              <path d="M3.5 0.5h6v6M0.5 3.5h6v6h-6z" stroke="currentColor" stroke-width="1" />
            </svg>
            <!-- Maximize: single rectangle -->
            <svg v-else key="maximize" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" />
            </svg>
          </Transition>
        </button>
      </template>
      {{ isMaximized ? t('app.window-restore') : t('app.window-maximize') }}
    </MTooltip>

    <MTooltip placement="bottom-end">
      <template #trigger>
        <button class="caption-btn caption-close" :aria-label="t('app.menu-close-window')" @click="close">
          <!-- Close: X -->
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </template>
      {{ t('app.menu-close-window') }}
    </MTooltip>
  </div>
</template>

<style scoped>
/* ── Windows 11 Fluent Design caption buttons ──────────────────────── */
/* Spec: 46×32px, borderless, transparent bg, hover reveals surface.   */
/* Close hover: #C42B1C (Windows 11 official red).                     */
/* Colors use --m3-on-surface for automatic color scheme adaptation.   */

.caption-bar {
  position: fixed;
  top: 0;
  right: 0;
  display: flex;
  height: 32px;
  z-index: 9999;
}

.caption-btn {
  width: 46px;
  height: 32px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--m3-on-surface);
  opacity: 0.7;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.2s ease,
    opacity 0.2s ease;
  outline: none;
  padding: 0;
}

.caption-btn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--m3-on-surface) 8%, transparent);
}

.caption-btn:active {
  background: color-mix(in srgb, var(--m3-on-surface) 12%, transparent);
}

.caption-close:hover {
  background: #c42b1c;
  color: #fff;
  opacity: 1;
}

.caption-close:active {
  background: #b22a1b;
  color: #fff;
}

/* Diminish button visibility when the window loses focus (Win11 behavior) */
.unfocused .caption-btn {
  opacity: 0.4;
}

.unfocused .caption-btn:hover {
  opacity: 1;
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
