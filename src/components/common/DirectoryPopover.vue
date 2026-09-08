<script setup lang="ts">
/** @fileoverview Shared directory quick-pick popover backed by preference directory history. */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { NPopover, NButton, NIcon, NEllipsis, NEmpty } from 'naive-ui'
import { TimeOutline, StarOutline, Star, TrashOutline } from '@vicons/ionicons5'
import { vMotionAutoAnimate } from '@/directives/motionAutoAnimate'

const emit = defineEmits<{ select: [dir: string] }>()

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const popoverVisible = ref(false)

const favorites = computed(() => preferenceStore.config.favoriteDirectories ?? [])
const recents = computed(() => preferenceStore.config.historyDirectories ?? [])
const hasItems = computed(() => favorites.value.length + recents.value.length > 0)

function onSelect(dir: string) {
  emit('select', dir)
  popoverVisible.value = false
}

function onToggleFavorite(dir: string, isFavorite: boolean) {
  if (isFavorite) {
    preferenceStore.cancelFavoriteDirectory(dir)
  } else {
    preferenceStore.favoriteDirectory(dir)
  }
}

function onRemove(dir: string) {
  preferenceStore.removeDirectory(dir)
}

function shortLabel(dir: string): string {
  const segments = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return segments.length >= 2 ? segments.slice(-2).join('/') : segments[segments.length - 1] || dir
}
</script>

<template>
  <NPopover
    v-model:show="popoverVisible"
    trigger="click"
    placement="bottom-end"
    :width="340"
    content-class="dir-popover-content"
  >
    <template #trigger>
      <NButton>
        <template #icon>
          <NIcon><TimeOutline /></NIcon>
        </template>
      </NButton>
    </template>

    <template v-if="hasItems">
      <div v-motion-auto-animate="{ duration: 200, easing: 'ease-out' }">
        <div v-if="favorites.length > 0" class="dir-popover-heading">{{ t('task.favorite-folders') }}</div>
        <div v-for="dir in favorites" :key="'fav-' + dir" class="dir-popover-item" :title="dir" @click="onSelect(dir)">
          <NEllipsis class="dir-popover-label" :tooltip="false">
            {{ shortLabel(dir) }}
          </NEllipsis>
          <div class="dir-popover-actions">
            <NButton text size="tiny" class="dir-popover-action" @click.stop="onToggleFavorite(dir, true)">
              <template #icon>
                <NIcon color="var(--m3-primary)"><Star /></NIcon>
              </template>
            </NButton>
            <NButton text size="tiny" class="dir-popover-action" @click.stop="onRemove(dir)">
              <template #icon>
                <NIcon><TrashOutline /></NIcon>
              </template>
            </NButton>
          </div>
        </div>
      </div>

      <div v-motion-auto-animate="{ duration: 200, easing: 'ease-out' }">
        <div
          v-if="recents.length > 0"
          class="dir-popover-heading"
          :class="{ 'dir-popover-heading--spaced': favorites.length > 0 }"
        >
          {{ t('task.recent-folders') }}
        </div>
        <div v-for="dir in recents" :key="'rec-' + dir" class="dir-popover-item" :title="dir" @click="onSelect(dir)">
          <NEllipsis class="dir-popover-label" :tooltip="false">
            {{ shortLabel(dir) }}
          </NEllipsis>
          <div class="dir-popover-actions">
            <NButton text size="tiny" class="dir-popover-action" @click.stop="onToggleFavorite(dir, false)">
              <template #icon>
                <NIcon><StarOutline /></NIcon>
              </template>
            </NButton>
            <NButton text size="tiny" class="dir-popover-action" @click.stop="onRemove(dir)">
              <template #icon>
                <NIcon><TrashOutline /></NIcon>
              </template>
            </NButton>
          </div>
        </div>
      </div>
    </template>
    <NEmpty v-else class="dir-popover-empty" size="small" :description="t('task.dir-no-saved')" />
  </NPopover>
</template>

<style scoped>
.dir-popover-heading {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--n-text-color-3);
  padding: 4px 8px 2px;
  user-select: none;
}
.dir-popover-heading--spaced {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--m3-outline-variant);
}

.dir-popover-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 5px 8px;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: background-color 0.15s;
}
.dir-popover-item:hover {
  background: var(--m3-surface-container-high);
}

.dir-popover-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.dir-popover-actions {
  display: flex;
  align-items: center;
  gap: 0;
  flex-shrink: 0;
  opacity: 0.5;
  transition: opacity 0.15s;
}
.dir-popover-item:hover .dir-popover-actions {
  opacity: 1;
}

.dir-popover-action {
  padding: 2px !important;
}
</style>
