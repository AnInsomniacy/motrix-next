<script setup lang="ts">
const brandLogo = '/logo.svg'
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
        <span class="logo-mark" aria-label="Rayburst">
          <img :src="brandLogo" width="34" height="34" alt="" />
        </span>
      </h1>
      <ul class="menu top-menu" data-tauri-drag-region>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.task-list')"
                @click="nav('/task/all')"
              >
                <NIcon :size="20"><ListOutline /></NIcon>
              </button>
            </template>
            {{ t('app.task-list') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.add-task')"
                @click="showAddTask"
              >
                <NIcon :size="20"><AddOutline /></NIcon>
              </button>
            </template>
            {{ t('app.add-task') }}
          </MTooltip>
        </li>
      </ul>
      <ul class="menu bottom-menu">
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.about')"
                @click="emit('show-about')"
              >
                <NIcon :size="20"><HelpCircleOutline /></NIcon>
              </button>
            </template>
            {{ t('app.about') }}
          </MTooltip>
        </li>
        <li>
          <MTooltip placement="right">
            <template #trigger>
              <button
                type="button"
                class="menu-button non-draggable"
                :aria-label="t('app.preferences')"
                @click="nav('/preference/general')"
              >
                <NIcon :size="20"><SettingsOutline /></NIcon>
              </button>
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
  color: var(--m3-on-surface);
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
  margin-top: var(--header-top-offset);
}
.logo-mark {
  display: block;
  width: 40px;
  height: 18px;
  text-align: center;
  font-size: 0;
  color: var(--m3-primary);
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
  margin-top: 24px;
}
.menu-button {
  width: 32px;
  height: 32px;
  cursor: pointer;
  border-radius: 16px;
  transition: background-color 0.2s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--m3-on-surface-variant);
  background: transparent;
  border: none;
  padding: 0;
}
.menu-button:hover,
.menu-button:focus-visible {
  background-color: var(--aside-icon-hover-bg);
  color: var(--m3-on-surface);
  outline: none;
}
.top-menu {
  flex: 1;
}
.bottom-menu {
  margin-bottom: 24px;
}
</style>
