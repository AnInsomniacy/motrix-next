<script setup lang="ts">
/** @fileoverview Sidebar navigation component. */
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'

import { NIcon } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { ListOutline, AddOutline, SettingsOutline, HelpCircleOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const emit = defineEmits<{ 'show-about': [] }>()

function nav(path: string) {
  router.push({ path }).catch(() => {
    /* duplicate navigation */
  })
}

function showAddTask() {
  appStore.showAddTaskDialog()
}
</script>

<template>
  <aside class="aside" data-tauri-drag-region>
    <div class="aside-inner" data-tauri-drag-region>
      <h1 class="logo-mini">
        <a target="_blank" href="https://github.com/AnInsomniacy/motrix-next/">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="18" viewBox="0 0 40 18">
            <rect
              x="0.5"
              y="0.5"
              width="39"
              height="17"
              rx="4"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            />
            <text
              x="20"
              y="13"
              fill="currentColor"
              font-family="Arial, Helvetica, sans-serif"
              font-weight="900"
              font-size="10"
              text-anchor="middle"
              letter-spacing="1"
            >
              NEXT
            </text>
          </svg>
        </a>
      </h1>
      <ul class="menu top-menu" data-tauri-drag-region>
        <li class="non-draggable" @click="nav('/task/active')">
          <MTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><ListOutline /></NIcon>
            </template>
            {{ t('app.task-list') }}
          </MTooltip>
        </li>
        <li class="non-draggable" @click="showAddTask">
          <MTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><AddOutline /></NIcon>
            </template>
            {{ t('app.add-task') }}
          </MTooltip>
        </li>
      </ul>
      <ul class="menu bottom-menu">
        <li class="non-draggable" @click="emit('show-about')">
          <MTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><HelpCircleOutline /></NIcon>
            </template>
            {{ t('app.about') }}
          </MTooltip>
        </li>
        <li class="non-draggable" @click="nav('/preference/basic')">
          <MTooltip placement="right">
            <template #trigger>
              <NIcon :size="20"><SettingsOutline /></NIcon>
            </template>
            {{ t('app.preferences') }}
          </MTooltip>
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
  margin-top: 50px;
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
  transition: background-color 0.2s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aside-icon-color);
}
.menu > li:hover {
  background-color: var(--aside-icon-hover-bg);
  color: var(--aside-text);
}
.top-menu {
  flex: 1;
}
.bottom-menu {
  margin-bottom: 24px;
}
</style>
