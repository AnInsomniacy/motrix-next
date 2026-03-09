<script setup lang="ts">
/** @fileoverview Custom window control buttons (minimize, maximize, close). */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { NIcon } from 'naive-ui'
import { RemoveOutline, CopyOutline, CloseOutline } from '@vicons/ionicons5'

const appWindow = getCurrentWindow()

function minimize() {
  appWindow.minimize()
}

function toggleMaximize() {
  appWindow.toggleMaximize()
}

function close() {
  appWindow.close()
}
</script>

<template>
  <div class="window-controls">
    <button class="ctrl-btn" title="Minimize" @click="minimize">
      <NIcon :size="14"><RemoveOutline /></NIcon>
    </button>
    <button class="ctrl-btn" title="Maximize" @click="toggleMaximize">
      <NIcon :size="14"><CopyOutline /></NIcon>
    </button>
    <button class="ctrl-btn close" title="Close" @click="close">
      <NIcon :size="14"><CloseOutline /></NIcon>
    </button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
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
</style>
