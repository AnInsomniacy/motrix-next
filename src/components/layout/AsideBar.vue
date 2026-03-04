<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { ADD_TASK_TYPE } from '@shared/constants'
import { NIcon, NTooltip } from 'naive-ui'
import { ListOutline, AddOutline, SettingsOutline, HelpCircleOutline } from '@vicons/ionicons5'

const router = useRouter()
const appStore = useAppStore()
const emit = defineEmits<{ 'show-about': [] }>()

function nav(path: string) {
  router.push({ path }).catch(() => {})
}

function showAddTask() {
  appStore.showAddTaskDialog(ADD_TASK_TYPE.URI)
}
</script>

<template>
  <aside class="aside" data-tauri-drag-region>
    <div class="aside-inner" data-tauri-drag-region>
      <h1 class="logo-mini">
        <a target="_blank" href="https://github.com/AnInsomniacy/motrix-next/">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="18" viewBox="0 0 40 18">
            <rect x="0.5" y="0.5" width="39" height="17" rx="4" fill="none" stroke="#888" stroke-width="1"/>
            <text x="20" y="13" fill="#FFF" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="10" text-anchor="middle" letter-spacing="1">NEXT</text>
          </svg>
        </a>
      </h1>
      <ul class="menu top-menu" data-tauri-drag-region>
        <li class="non-draggable" @click="nav('/task/active')">
          <NTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><ListOutline /></NIcon>
            </template>
            Tasks
          </NTooltip>
        </li>
        <li class="non-draggable" @click="showAddTask">
          <NTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><AddOutline /></NIcon>
            </template>
            New Task
          </NTooltip>
        </li>
      </ul>
      <ul class="menu bottom-menu">
        <li class="non-draggable" @click="emit('show-about')">
          <NTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><HelpCircleOutline /></NIcon>
            </template>
            About
          </NTooltip>
        </li>
        <li class="non-draggable" @click="nav('/preference/basic')">
          <NTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><SettingsOutline /></NIcon>
            </template>
            Preferences
          </NTooltip>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.aside {
  width: var(--aside-width);
  height: 100%;
  background-color: var(--aside-bg);
  color: var(--aside-text);
  flex-shrink: 0;
  z-index: 10;
}
.aside-inner {
  display: flex;
  height: 100%;
  flex-flow: column;
}
.logo-mini {
  margin: 0;
  padding: 0;
  width: 100%;
  margin-top: 58px;
}
.logo-mini > a {
  display: block;
  width: 40px;
  height: 18px;
  text-align: center;
  font-size: 0;
  outline: none;
  padding: 2px;
  margin: 0 auto;
}
.menu {
  list-style: none;
  padding: 0;
  margin: 0 auto;
  user-select: none;
  cursor: default;
}
.menu > li {
  width: 32px;
  height: 32px;
  margin-top: 24px;
  cursor: pointer;
  border-radius: 16px;
  transition: background-color 0.25s;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.7);
}
.menu > li:hover {
  background-color: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.top-menu {
  flex: 1;
}
.bottom-menu {
  margin-bottom: 24px;
}
</style>
