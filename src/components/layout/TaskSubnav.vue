<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { NIcon } from 'naive-ui'
import { PlayOutline, PauseOutline, StopOutline } from '@vicons/ionicons5'
import { type Component } from 'vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const items: { key: string; icon: Component; route: string }[] = [
  { key: 'active', icon: PlayOutline, route: '/task/active' },
  { key: 'waiting', icon: PauseOutline, route: '/task/waiting' },
  { key: 'stopped', icon: StopOutline, route: '/task/stopped' },
]

function nav(path: string) {
  router.push({ path }).catch(() => {})
}

function isActive(key: string) {
  return route.path.includes(key)
}
</script>

<template>
  <aside class="subnav" data-tauri-drag-region>
    <nav class="subnav-inner" data-tauri-drag-region>
      <h3>{{ t('subnav.task-list') || 'Tasks' }}</h3>
      <ul>
        <li
          v-for="item in items"
          :key="item.key"
          :class="{ active: isActive(item.key) }"
          @click="nav(item.route)"
        >
          <NIcon :size="16" class="subnav-icon">
            <component :is="item.icon" />
          </NIcon>
          <span>{{ t('task.' + item.key) || item.key }}</span>
        </li>
      </ul>
    </nav>
  </aside>
</template>

<style scoped>
.subnav {
  width: var(--subnav-width);
  height: 100%;
  background-color: var(--subnav-bg);
  color: var(--subnav-text);
  flex-shrink: 0;
  overflow-y: auto;
}
.subnav-inner {
  margin-top: 44px;
  padding: 0 16px;
  user-select: none;
}
.subnav-inner h3 {
  font-size: 16px;
  color: var(--subnav-title);
  font-weight: normal;
  line-height: 24px;
  margin: 0 0 28px;
}
.subnav-inner ul {
  list-style: none;
  padding: 0;
  margin: 0;
  cursor: default;
}
.subnav-inner li {
  margin-bottom: 8px;
  padding: 8px 10px;
  font-size: 14px;
  line-height: 20px;
  border-radius: 3px;
  cursor: pointer;
  transition: background-color 0.2s ease;
  display: flex;
  align-items: center;
}
.subnav-inner li:hover,
.subnav-inner li.active {
  background-color: var(--subnav-active-bg);
}
.subnav-inner li:hover span,
.subnav-inner li:hover .subnav-icon,
.subnav-inner li.active span,
.subnav-inner li.active .subnav-icon {
  color: var(--subnav-active-text);
}
.subnav-inner li span,
.subnav-inner li .subnav-icon {
  transition: color 0.2s ease;
}
.subnav-icon {
  margin-right: 12px;
}
</style>
