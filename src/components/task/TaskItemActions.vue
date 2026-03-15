<script setup lang="ts">
/** @fileoverview Action buttons for individual task items. */
import { computed, inject, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { NIcon } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import {
  PauseOutline,
  PlayOutline,
  StopOutline,
  RefreshOutline,
  CloseOutline,
  TrashOutline,
  LinkOutline,
  InformationCircleOutline,
  FolderOpenOutline,
  SyncOutline,
} from '@vicons/ionicons5'
import { type Component } from 'vue'
import type { Aria2Task } from '@shared/types'

const props = defineProps<{ task: Aria2Task; status: string }>()
const stoppingGids = inject<Ref<string[]>>('stoppingGids')
const isStopping = computed(() => stoppingGids?.value.includes(props.task.gid) ?? false)
const emit = defineEmits<{
  pause: []
  resume: []
  delete: []
  'delete-record': []
  'copy-link': []
  'show-info': []
  folder: []
  'stop-seeding': []
}>()

const { t } = useI18n()

const actionsMap = computed<
  Record<string, { key: string; icon: Component; label: string; event: string; tooltip?: string; cls?: string }[]>
>(() => ({
  [TASK_STATUS.ACTIVE]: [
    { key: 'toggle', icon: PauseOutline, label: t('task.pause-task'), event: 'pause' },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
  [TASK_STATUS.PAUSED]: [
    { key: 'toggle', icon: PlayOutline, label: t('task.resume-task'), event: 'resume' },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
  [TASK_STATUS.WAITING]: [
    { key: 'toggle', icon: PlayOutline, label: t('task.resume-task'), event: 'resume' },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
  [TASK_STATUS.ERROR]: [
    { key: 'restart', icon: RefreshOutline, label: t('task.resume-task'), event: 'resume' },
    { key: 'trash', icon: TrashOutline, label: t('task.remove-record'), event: 'delete-record' },
  ],
  [TASK_STATUS.COMPLETE]: [
    { key: 'restart', icon: RefreshOutline, label: t('task.resume-task'), event: 'resume' },
    { key: 'trash', icon: TrashOutline, label: t('task.remove-record'), event: 'delete-record' },
  ],
  [TASK_STATUS.REMOVED]: [
    { key: 'restart', icon: RefreshOutline, label: t('task.resume-task'), event: 'resume' },
    { key: 'trash', icon: TrashOutline, label: t('task.remove-record'), event: 'delete-record' },
  ],
  [TASK_STATUS.SEEDING]: [
    {
      key: 'stop',
      icon: StopOutline,
      label: t('task.stop-seeding') || 'Stop Seeding',
      event: 'stop-seeding',
      tooltip:
        t('task.stop-seeding-tip') ||
        'Download complete. You are sharing this file with others via BT. Click to stop seeding.',
      cls: 'stop-seeding',
    },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
}))

const actions = computed(() => {
  const primary = actionsMap.value[props.status] || []
  const common: { key: string; icon: Component; label: string; event: string; tooltip?: string; cls?: string }[] = [
    { key: 'folder', icon: FolderOpenOutline, label: t('task.show-in-folder'), event: 'folder' },
    { key: 'link', icon: LinkOutline, label: t('task.copy-link'), event: 'copy-link' },
    { key: 'info', icon: InformationCircleOutline, label: t('task.task-detail-title'), event: 'show-info' },
  ]
  return [...primary, ...common].reverse()
})

function onAction(event: string) {
  switch (event) {
    case 'pause':
      emit('pause')
      break
    case 'resume':
      emit('resume')
      break
    case 'delete':
      emit('delete')
      break
    case 'delete-record':
      emit('delete-record')
      break
    case 'copy-link':
      emit('copy-link')
      break
    case 'show-info':
      emit('show-info')
      break
    case 'folder':
      emit('folder')
      break
    case 'stop-seeding':
      emit('stop-seeding')
      break
  }
}

/** Minimum press visual duration (ms) so quick clicks still show the animation. */
const MIN_PRESS_MS = 200
const pressTimers = new WeakMap<HTMLElement, { start: number; timer: ReturnType<typeof setTimeout> | null }>()

function onPress(ev: PointerEvent) {
  const el = ev.currentTarget as HTMLElement
  const prev = pressTimers.get(el)
  if (prev?.timer) clearTimeout(prev.timer)
  el.classList.add('pressed')
  pressTimers.set(el, { start: Date.now(), timer: null })
}

function onRelease(ev: PointerEvent) {
  const el = ev.currentTarget as HTMLElement
  const state = pressTimers.get(el)
  if (!state) {
    el.classList.remove('pressed')
    return
  }
  const elapsed = Date.now() - state.start
  const remaining = Math.max(0, MIN_PRESS_MS - elapsed)
  state.timer = setTimeout(() => {
    el.classList.remove('pressed')
    pressTimers.delete(el)
  }, remaining)
}
</script>

<template>
  <ul class="task-item-actions" @dblclick.stop>
    <li
      v-for="action in actions"
      :key="action.key"
      class="task-item-action"
      :class="[action.cls, { 'is-stopping': action.event === 'stop-seeding' && isStopping }]"
      @pointerdown="onPress"
      @pointerup="onRelease"
      @pointerleave="onRelease"
      @click.stop="onAction(action.event)"
    >
      <MTooltip :style="action.tooltip ? 'max-width: 220px' : ''">
        <template #trigger>
          <span v-if="action.event === 'stop-seeding'" class="stop-icon-wrapper">
            <span class="stop-icon-static" :class="{ 'fade-out': isStopping }">
              <NIcon :size="20"><StopOutline /></NIcon>
            </span>
            <span class="stop-icon-spin" :class="{ 'fade-in': isStopping }">
              <NIcon :size="20"><SyncOutline /></NIcon>
            </span>
          </span>
          <Transition v-else name="icon-swap" mode="out-in">
            <NIcon :key="action.event" :size="20"><component :is="action.icon" /></NIcon>
          </Transition>
        </template>
        <template v-if="action.event === 'stop-seeding' && isStopping">
          {{ t('task.stopping-seeding') || 'Stopping…' }}
        </template>
        <template v-else>
          {{ action.tooltip || action.label }}
        </template>
      </MTooltip>
    </li>
  </ul>
</template>

<style scoped>
.task-item-actions {
  position: absolute;
  top: 14px;
  right: 12px;
  height: 32px;
  padding: 0 12px;
  margin: 0;
  overflow: hidden;
  user-select: none;
  cursor: default;
  text-align: right;
  direction: rtl;
  border: 1px solid var(--task-action-border);
  color: var(--task-action-color);
  background-color: var(--task-action-bg);
  border-radius: 18px;
  transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
  list-style: none;
}
.task-item-actions:hover {
  border-color: var(--task-action-hover-border);
  background-color: var(--task-action-hover-bg);
  width: auto;
}
.task-item-action {
  display: inline-block;
  padding: 6px;
  margin: 0 3px;
  font-size: 0;
  cursor: pointer;
  line-height: 20px;
  direction: ltr;
  border-radius: 50%;
  transition:
    color 0.15s,
    background-color 0.15s,
    transform 0.25s cubic-bezier(0.05, 0.7, 0.1, 1);
  transform-origin: center;
}
.task-item-action:hover {
  color: var(--primary-color, #e0a422);
}
.task-item-action.pressed {
  transform: scale(0.85);
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.task-item-action.stop-seeding {
  color: var(--m3-success);
}
.task-item-action.stop-seeding:hover {
  color: var(--m3-success);
}
.task-item-action.is-stopping {
  color: var(--m3-warning);
  pointer-events: none;
}

/* Icon crossfade wrapper */
.stop-icon-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}
.stop-icon-static,
.stop-icon-spin {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.5s ease;
}
.stop-icon-static {
  opacity: 1;
}
.stop-icon-static.fade-out {
  opacity: 0;
}
.stop-icon-spin {
  opacity: 0;
}
.stop-icon-spin.fade-in {
  opacity: 1;
  animation: spin-stop 0.9s linear infinite;
  will-change: transform;
  contain: layout style paint;
}
@keyframes spin-stop {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* M3 icon crossfade for play ↔ pause toggle */
.icon-swap-enter-active {
  transition:
    opacity 0.2s cubic-bezier(0.05, 0.7, 0.1, 1),
    transform 0.2s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.icon-swap-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.icon-swap-enter-from {
  opacity: 0;
  transform: scale(0.6);
}
.icon-swap-leave-to {
  opacity: 0;
  transform: scale(0.6);
}
</style>
