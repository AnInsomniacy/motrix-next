<script setup lang="ts">
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
    <button class="ctrl-btn" @click="minimize" title="Minimize">
      <NIcon :size="14"><RemoveOutline /></NIcon>
    </button>
    <button class="ctrl-btn" @click="toggleMaximize" title="Maximize">
      <NIcon :size="14"><CopyOutline /></NIcon>
    </button>
    <button class="ctrl-btn close" @click="close" title="Close">
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
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  outline: none;
  padding: 0;
}
.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.9);
}
.ctrl-btn.close:hover {
  background: rgba(255, 59, 48, 0.75);
  border-color: rgba(255, 59, 48, 0.9);
  color: #fff;
}
</style>
