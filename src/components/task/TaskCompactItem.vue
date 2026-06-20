<script setup lang="ts">
/** @fileoverview Two-line compact task row with the same actions as the full card. */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { NIcon, NProgress } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { ArrowDownOutline, ArrowUpOutline, AlertCircleOutline, RadioOutline, TimeOutline } from '@vicons/ionicons5'
import { useTaskCardModel } from '@/composables/useTaskCardModel'
import { useTaskFileMissing } from '@/composables/useTaskFileMissing'
import TaskDragHandle from './TaskDragHandle.vue'
import TaskItemActions from './TaskItemActions.vue'
import type { Component } from 'vue'
import type { Aria2Task } from '@shared/types'

const props = defineProps<{ task: Aria2Task }>()
const emit = defineEmits<{
  pause: [task: Aria2Task]
  resume: [task: Aria2Task]
  delete: [task: Aria2Task]
  'delete-record': [task: Aria2Task]
  'copy-link': [task: Aria2Task]
  'show-info': [task: Aria2Task]
  folder: [task: Aria2Task]
  'open-file': [task: Aria2Task]
  'stop-sharing': [task: Aria2Task]
}>()

const { t } = useI18n()
const taskRef = computed(() => props.task)
const {
  taskFullName,
  isSharing,
  statusBadge,
  taskStatus,
  isActive,
  percent,
  completedSize,
  totalSize,
  hasSizeInfo,
  downloadSpeed,
  uploadSpeed,
  remaining,
  remainingText,
  elapsedText,
  transferSummary,
} = useTaskCardModel(taskRef)
const { fileMissing } = useTaskFileMissing(taskRef)

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

const statusColorMap = computed<Record<string, string>>(() => ({
  active: cssVar('--m3-status-active', ''),
  waiting: cssVar('--m3-status-waiting', ''),
  paused: cssVar('--m3-status-paused', '#909399'),
  error: cssVar('--m3-status-error', '#F56C6C'),
  complete: cssVar('--m3-status-success', '#67C23A'),
  removed: cssVar('--m3-status-paused', '#909399'),
  sharing: cssVar('--m3-status-success', '#67C23A'),
}))

const progressColor = computed(() => statusColorMap.value[taskStatus.value] || cssVar('--m3-status-active', ''))

const compactStatus = computed<{ label: string; tone: string; icon: Component } | null>(() => {
  if (fileMissing.value) {
    return {
      label: t('task.file-missing') || 'File missing',
      tone: 'error',
      icon: AlertCircleOutline,
    }
  }
  if (!statusBadge.value) return null

  switch (statusBadge.value.key) {
    case TASK_STATUS.ERROR:
      return { label: statusBadge.value.label, tone: 'error', icon: AlertCircleOutline }
    case TASK_STATUS.WAITING:
      return { label: statusBadge.value.label, tone: statusBadge.value.tone, icon: TimeOutline }
    case 'bt-metadata-fetching':
      return { label: statusBadge.value.label, tone: statusBadge.value.tone, icon: RadioOutline }
    default:
      return { label: statusBadge.value.label, tone: statusBadge.value.tone, icon: RadioOutline }
  }
})

function onDblClick() {
  if (isSharing.value) return
  const s = props.task.status
  if (s === TASK_STATUS.COMPLETE) {
    emit('open-file', props.task)
    return
  }
  if (s === TASK_STATUS.ACTIVE || s === TASK_STATUS.WAITING) emit('pause', props.task)
  else if (s === TASK_STATUS.PAUSED) emit('resume', props.task)
}

const sharingEnter = ref(false)
watch(isSharing, (now, was) => {
  if (now && !was) sharingEnter.value = true
})

const CARD_PRESS_MS = 180
let cardPressStart = 0
let cardPressTimer: ReturnType<typeof setTimeout> | null = null
const cardRef = ref<HTMLElement | null>(null)

function onCardPress() {
  if (cardPressTimer) clearTimeout(cardPressTimer)
  cardPressStart = Date.now()
  cardRef.value?.classList.add('pressed')
}

function onCardRelease() {
  const elapsed = Date.now() - cardPressStart
  const remainingMs = Math.max(0, CARD_PRESS_MS - elapsed)
  cardPressTimer = setTimeout(() => {
    cardRef.value?.classList.remove('pressed')
    cardPressTimer = null
  }, remainingMs)
}

onBeforeUnmount(() => {
  if (cardPressTimer) {
    clearTimeout(cardPressTimer)
    cardPressTimer = null
  }
})
</script>

<template>
  <div
    ref="cardRef"
    class="task-compact-item"
    :class="{
      'file-missing': fileMissing,
      'is-sharing': isSharing,
      'sharing-enter': sharingEnter,
    }"
    @dblclick="onDblClick"
    @pointerdown="onCardPress"
    @pointerup="onCardRelease"
    @pointerleave="onCardRelease"
    @animationend="sharingEnter = false"
  >
    <TaskDragHandle class="compact-drag-rail" />
    <div class="compact-body">
      <div class="compact-header">
        <MTooltip placement="bottom-start">
          <template #trigger>
            <div class="compact-name">{{ taskFullName }}</div>
          </template>
          {{ taskFullName }}
        </MTooltip>
        <TaskItemActions
          :task="task"
          :status="taskStatus"
          :file-missing="fileMissing"
          density="compact"
          @pause="emit('pause', task)"
          @resume="emit('resume', task)"
          @delete="emit('delete', task)"
          @delete-record="emit('delete-record', task)"
          @copy-link="emit('copy-link', task)"
          @show-info="emit('show-info', task)"
          @folder="emit('folder', task)"
          @open-file="emit('open-file', task)"
          @stop-sharing="emit('stop-sharing', task)"
        />
      </div>
      <div class="compact-progress-row">
        <NProgress
          class="compact-progress"
          type="line"
          :percentage="percent"
          :color="progressColor"
          :rail-color="undefined"
          :height="5"
          :border-radius="3"
          :show-indicator="false"
          :processing="isActive"
        />
        <div class="compact-meta">
          <span>{{ percent }}%</span>
          <span v-if="hasSizeInfo">{{ completedSize }} / {{ totalSize }}</span>
          <span v-if="compactStatus" class="compact-status" :class="{ error: compactStatus.tone === 'error' }">
            <NIcon :size="12"><component :is="compactStatus.icon" /></NIcon>
            {{ compactStatus.label }}
          </span>
          <span class="compact-speed">
            <NIcon :size="10"><ArrowDownOutline /></NIcon>
            {{ downloadSpeed }}/s
          </span>
          <span v-if="transferSummary.showUploadMetrics" class="compact-speed">
            <NIcon :size="10"><ArrowUpOutline /></NIcon>
            {{ uploadSpeed }}/s
          </span>
          <span v-if="remaining > 0">{{ remainingText }}</span>
          <span v-if="elapsedText" class="compact-speed">{{ elapsedText }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-compact-item {
  position: relative;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  min-height: 42px;
  background-color: var(--task-item-bg);
  border: 1px solid var(--m3-outline-variant);
  border-left: 3px solid var(--m3-outline-variant);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.task-compact-item::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--m3-success) 6%, transparent) 0%, transparent 40%);
  opacity: 0;
  pointer-events: none;
}
.task-compact-item.is-sharing {
  border-left-color: var(--m3-success);
}
.task-compact-item.is-sharing::before {
  opacity: 1;
}
.task-compact-item.file-missing {
  border-color: var(--m3-error-container-bg);
}
.task-compact-item:hover {
  border-color: var(--task-item-hover-border);
}
.task-compact-item:hover .compact-drag-rail {
  opacity: 0.64;
}
.compact-drag-rail {
  grid-row: 1;
}
.compact-body {
  min-width: 0;
  padding: 8px 12px;
}
.task-compact-item.pressed {
  transform: scale(0.98);
  border-color: var(--color-primary);
  transition:
    transform 0.15s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.15s;
}
.task-compact-item:not(.pressed) {
  transition:
    transform 0.35s cubic-bezier(0.05, 0.7, 0.1, 1),
    border-color 0.3s;
}
@keyframes sharing-border-enter {
  from {
    border-left-color: var(--m3-outline-variant);
  }
  to {
    border-left-color: var(--m3-success);
  }
}
@keyframes sharing-overlay-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.task-compact-item.sharing-enter {
  animation: sharing-border-enter 1s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-compact-item.sharing-enter::before {
  animation: sharing-overlay-enter 1.2s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.compact-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 12px;
  align-items: start;
  height: 26px;
  overflow: hidden;
}
.compact-header :deep(.n-tooltip-trigger) {
  min-width: 0;
  max-width: 100%;
}
.compact-name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--m3-on-surface-variant);
  font-size: 14px;
  line-height: 24px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.compact-progress-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(0, auto);
  align-items: center;
  column-gap: 10px;
  height: 16px;
  margin-top: 4px;
  overflow: hidden;
}
.compact-progress :deep(.n-progress-graph-line-fill) {
  transition: background-color 0.5s cubic-bezier(0.2, 0, 0, 1);
}
.compact-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.compact-meta > span {
  flex: 0 0 auto;
  min-width: 0;
}
.compact-status,
.compact-speed {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.compact-status.error {
  color: var(--m3-error);
}
</style>
