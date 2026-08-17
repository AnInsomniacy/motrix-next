<script setup lang="ts">
/** @fileoverview Preference settings view with preference sub-routes. */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { usePlatform } from '@/composables/usePlatform'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { isMobile } = usePlatform()

const tabKey = computed(() => {
  const path = route.path
  if (path.includes('downloads')) return 'downloads'
  if (path.includes('bt')) return 'bt'
  if (path.includes('ed2k')) return 'ed2k'
  if (path.includes('network')) return 'network'
  if (path.includes('advanced')) return 'advanced'
  return 'general'
})

const tabs = computed(() => [
  { key: 'general', title: t('preferences.general') || 'General', path: '/preference/general' },
  { key: 'downloads', title: t('preferences.downloads') || 'Downloads', path: '/preference/downloads' },
  { key: 'bt', title: t('preferences.bt') || 'BitTorrent', path: '/preference/bt' },
  { key: 'ed2k', title: t('preferences.ed2k') || 'ED2K', path: '/preference/ed2k' },
  { key: 'network', title: t('preferences.network') || 'Network', path: '/preference/network' },
  { key: 'advanced', title: t('preferences.advanced') || 'Advanced', path: '/preference/advanced' },
])

function switchTab(path: string) {
  router.push({ path }).catch(() => {
    /* duplicate navigation */
  })
}
</script>

<template>
  <div class="preference-view">
    <header class="panel-header" data-tauri-drag-region>
      <h4>{{ t('preferences.' + tabKey) || 'Settings' }}</h4>
    </header>
    <!-- Mobile: preference tabs (subnav is hidden on phones) -->
    <nav v-if="isMobile" class="mobile-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="mobile-tab"
        :class="{ active: tab.key === tabKey }"
        @click="switchTab(tab.path)"
      >
        {{ tab.title }}
      </button>
    </nav>
    <div class="panel-body">
      <router-view v-slot="{ Component, route: innerRoute }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" :key="innerRoute.path" />
        </Transition>
      </router-view>
    </div>
  </div>
</template>

<style scoped>
.preference-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-header {
  padding: var(--header-top-offset) 0 12px;
  margin: 0 36px;
  border-bottom: 2px solid var(--panel-border);
  user-select: none;
}
.panel-header h4 {
  margin: 0;
  color: var(--panel-title);
  font-size: 16px;
  font-weight: normal;
  line-height: 24px;
}
.panel-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* ── Mobile preference tabs (Android) ────────────────────────────────── */
.mobile-tabs {
  display: flex;
  gap: 8px;
  margin: 0 16px;
  padding: 8px 0;
  overflow-x: auto;
  flex-shrink: 0;
}
.mobile-tab {
  padding: 6px 16px;
  border-radius: 100px;
  font-size: 13px;
  color: var(--m3-on-surface-variant);
  background: var(--m3-surface-container);
  border: 1px solid var(--m3-outline-variant);
  white-space: nowrap;
  transition:
    background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.mobile-tab.active {
  color: var(--m3-on-primary);
  background: var(--m3-primary);
  border-color: var(--m3-primary);
}
@media (min-width: 601px) {
  .mobile-tabs {
    display: none;
  }
}
</style>
