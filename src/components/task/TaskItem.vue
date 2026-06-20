<script setup lang="ts">
/** @fileoverview Individual task row in the task list with progress and controls. */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { NProgress, NIcon } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import {
  ArrowUpOutline,
  ArrowDownOutline,
  GitNetworkOutline,
  MagnetOutline,
  AlertCircleOutline,
  CloudUploadOutline,
  CheckmarkCircleOutline,
  TrashOutline,
  RadioOutline,
  TimeOutline,
} from '@vicons/ionicons5'
import { useTaskCardModel } from '@/composables/useTaskCardModel'
import { useTaskFileMissing } from '@/composables/useTaskFileMissing'
import TaskDragHandle from './TaskDragHandle.vue'
import TaskItemActions from './TaskItemActions.vue'
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

/** Reads a CSS variable from :root, returning the fallback if unavailable. */
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
const hasStatusLine = computed(() => Boolean(statusBadge.value || fileMissing.value))

const statusBadgeStyle = computed(() => {
  switch (statusBadge.value?.tone) {
    case 'success':
      return { color: cssVar('--m3-status-success', '#67C23A') }
    case 'error':
      return { color: cssVar('--m3-status-error', '#F56C6C') }
    case 'waiting':
      return { color: cssVar('--m3-status-waiting', '') }
    case 'muted':
      return { color: cssVar('--m3-status-paused', '#909399') }
    default:
      return { color: cssVar('--m3-status-paused', '#909399') }
  }
})

const statusBadgeIcon = computed(() => {
  switch (statusBadge.value?.key) {
    case TASK_STATUS.COMPLETE:
      return CheckmarkCircleOutline
    case TASK_STATUS.ERROR:
      return AlertCircleOutline
    case TASK_STATUS.REMOVED:
      return TrashOutline
    case TASK_STATUS.WAITING:
      return TimeOutline
    case 'bt-metadata-fetching':
      return RadioOutline
    default:
      return CloudUploadOutline
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

const { fileMissing } = useTaskFileMissing(taskRef)

// ── M3 sharing state entrance animation ───────────────────────────
// CSS transitions fail here because the store's polling cycle replaces
// task objects entirely — even though Vue reuses the DOM element (same
// gid key), NProgress internally rebuilds its fill node, losing the
// transition starting point. @keyframes animations do not depend on
// property value continuity — they always play from→to.
const sharingEnter = ref(false)

watch(isSharing, (now, was) => {
  if (now && !was) {
    sharingEnter.value = true
  }
})

// ── Card press-hold interaction ─────────────────────────────────────
// Mirrors the pointerdown/pointerup pattern from TaskItemActions.
// Card stays pressed (scale down) while pointer is held, then springs
// back on release with a minimum visual duration for quick clicks.
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
  const remaining = Math.max(0, CARD_PRESS_MS - elapsed)
  cardPressTimer = setTimeout(() => {
    cardRef.value?.classList.remove('pressed')
    cardPressTimer = null
  }, remaining)
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
    class="task-item"
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
    <TaskDragHandle class="task-drag-rail" />
    <div class="task-body">
      <div class="task-header">
        <MTooltip placement="bottom-start">
          <template #trigger>
            <div class="task-name">
              <!-- Crossfade: old name fades out, then new name fades in.
                   :key ensures transition only fires when the text actually changes.
                   Polling-safe: computed returns the same string each cycle → no key change. -->
              <Transition name="name-crossfade" mode="out-in">
                <span :key="taskFullName" class="technical-text-wrap">{{ taskFullName }}</span>
              </Transition>
            </div>
          </template>
          {{ taskFullName }}
        </MTooltip>
        <TaskItemActions
          :task="task"
          :status="taskStatus"
          :file-missing="fileMissing"
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
      <div class="task-status-slot" :class="{ 'task-status-slot--visible': hasStatusLine }">
        <div class="task-status-slot__inner">
          <div class="task-tags" :class="{ 'task-tags--visible': hasStatusLine }">
            <span v-show="statusBadge" class="status-tag" :style="statusBadgeStyle">
              <NIcon :size="13"><component :is="statusBadgeIcon" /></NIcon>
              {{ statusBadge?.label }}
            </span>
            <span v-show="fileMissing" class="file-missing-tag">
              <NIcon :size="13"><AlertCircleOutline /></NIcon>
              {{ t('task.file-missing') || 'File missing' }}
            </span>
          </div>
        </div>
      </div>
      <div class="task-progress">
        <NProgress
          type="line"
          :percentage="percent"
          :color="progressColor"
          :rail-color="undefined"
          :height="6"
          :border-radius="3"
          :show-indicator="false"
          :processing="isActive"
        />
        <div class="task-progress-info">
          <div class="progress-left" :class="{ 'info-hidden': !hasSizeInfo }">
            <span>
              {{ completedSize }}
              <span v-if="Number(task.totalLength) > 0"> / {{ totalSize }}</span>
            </span>
          </div>
          <div class="progress-right" :class="{ 'info-hidden': !isActive }">
            <span class="speed-text" :class="{ 'info-hidden': remaining <= 0 }">
              <span>{{ remainingText }}</span>
            </span>
            <span v-if="elapsedText" class="speed-text elapsed-text">
              <span>{{ elapsedText }}</span>
            </span>
            <span v-if="transferSummary.showUploadMetrics" class="speed-text">
              <NIcon :size="10"><ArrowUpOutline /></NIcon>
              <span>{{ uploadSpeed }}/s</span>
            </span>
            <span class="speed-text">
              <NIcon :size="10"><ArrowDownOutline /></NIcon>
              <span>{{ downloadSpeed }}/s</span>
            </span>
            <span v-if="transferSummary.showSeeders" class="speed-text">
              <NIcon :size="10"><MagnetOutline /></NIcon>
              <span>{{ task.numSeeders }}</span>
            </span>
            <span class="speed-text">
              <NIcon :size="10"><GitNetworkOutline /></NIcon>
              <span>{{ task.connections }}</span>
            </span>
          </div>
          <div class="error-message technical-text-wrap" :class="{ 'info-hidden': !task.errorMessage }">
            {{ task.errorMessage }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-item {
  position: relative;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  min-height: 78px;
  background-color: var(--task-item-bg);
  border: 1px solid var(--m3-outline-variant);
  /* Reserve 3px left border at base color so sharing only animates color */
  border-left: 3px solid var(--m3-outline-variant);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
/* Gradient overlay — always present, hidden by default */
.task-item::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--m3-success) 6%, transparent) 0%, transparent 40%);
  opacity: 0;
  pointer-events: none;
}
/* ── Seeding state (static) ────────────────────────────────────────── */
.task-item.is-sharing {
  border-left-color: var(--m3-success);
}
.task-item.is-sharing::before {
  opacity: 1;
}
/* ── Seeding entrance animation (triggered by Vue watch) ───────────── */
/* @keyframes always plays from→to regardless of prior DOM state,       */
/* unlike CSS transitions which break when the element is re-rendered.  */
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
.task-item.sharing-enter {
  animation: sharing-border-enter 1s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-item.sharing-enter::before {
  animation: sharing-overlay-enter 1.2s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-item:hover {
  border-color: var(--task-item-hover-border);
}
.task-item:hover .task-drag-rail {
  opacity: 0.64;
}
.task-drag-rail {
  grid-row: 1;
  align-self: stretch;
  min-height: 0;
}
.task-body {
  display: grid;
  grid-template-rows: auto auto auto;
  min-width: 0;
  padding: 16px 12px;
}
/* ── Card press-hold state ──────────────────────────────────────────── */
/* Asymmetric timing: fast press-in (0.15s), springy release (0.35s).   */
/* The release uses M3 emphasized-decelerate for organic overshoot.     */
.task-item.pressed {
  transform: scale(0.98);
  border-color: var(--color-primary);
  transition:
    transform 0.15s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.15s;
}
/* Spring-back on release — overshoots slightly via emphasized easing */
.task-item:not(.pressed) {
  transition:
    transform 0.35s cubic-bezier(0.05, 0.7, 0.1, 1),
    border-color 0.3s;
}
.task-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 20px;
  align-items: start;
}
.task-header :deep(.n-tooltip-trigger) {
  min-width: 0;
  max-width: 100%;
}
.task-name {
  color: var(--m3-on-surface-variant);
  overflow: hidden;
  min-height: 26px;
  min-width: 0;
  max-width: 100%;
}
.task-name > span {
  font-size: 14px;
  line-height: 26px;
  display: -webkit-box;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
/* ── Filename resolution crossfade (Vue <Transition mode="out-in">) ── */
/* Old text fades out → new text fades in. No flash because Vue applies  */
/* enter-from (opacity:0) BEFORE inserting the new element.              */
/* Polling-safe: :key is the string value — same string = no transition. */
.name-crossfade-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.05, 0.7, 0.1, 1),
    transform 0.25s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.name-crossfade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.2, 0, 0, 1);
}
.name-crossfade-enter-from {
  opacity: 0;
  transform: translateY(3px);
}
.name-crossfade-leave-to {
  opacity: 0;
}
.file-missing-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  color: var(--m3-error);
  opacity: 0.85;
  vertical-align: middle;
  animation: m3-tag-enter 0.35s cubic-bezier(0.05, 0.7, 0.1, 1);
}
/* M3 emphasized-decelerate tag entrance — shared by all status tags */
@keyframes m3-tag-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 0.9;
    transform: translateY(0);
  }
}
.task-item.file-missing {
  border-color: var(--m3-error-container-bg);
}
/* M3 progress-bar color transition (amber → green on status change) */
.task-progress :deep(.n-progress-graph-line-fill) {
  transition: background-color 0.5s cubic-bezier(0.2, 0, 0, 1);
}
.task-progress {
  margin-top: 10px;
}
.task-progress-info {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  font-size: 12px;
  line-height: 14px;
  min-height: 14px;
  color: var(--m3-on-surface-variant);
  margin-top: 8px;
  font-variant-numeric: tabular-nums;
}
.progress-left {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  transition: opacity 0.4s cubic-bezier(0.2, 0, 0, 1);
}
.progress-right {
  display: flex;
  gap: 8px;
  text-align: right;
  align-items: center;
  transition: opacity 0.4s cubic-bezier(0.2, 0, 0, 1);
}
.speed-text {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  line-height: 14px;
  white-space: nowrap;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
/* ── Pure CSS show/hide (polling-safe) ────────────────────────────── */
/* Bypasses Vue <Transition> to avoid leave-animation loss when       */
/* reactive polling updates child content in the same render tick.    */
.info-hidden {
  opacity: 0;
  pointer-events: none;
}
.task-status-slot {
  height: 0;
  overflow: hidden;
  transition:
    height 0.42s cubic-bezier(0.05, 0.7, 0.1, 1),
    opacity 0.28s cubic-bezier(0.2, 0, 0, 1);
  opacity: 0;
}
.task-status-slot--visible {
  height: 18px;
  opacity: 1;
}
.task-status-slot__inner {
  min-height: 18px;
}
.task-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 18px;
  opacity: 0;
  transform: translateY(-3px);
  transition:
    opacity 0.3s cubic-bezier(0.2, 0, 0, 1),
    transform 0.3s cubic-bezier(0.05, 0.7, 0.1, 1);
  pointer-events: none;
}
.task-tags--visible {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  opacity: 0.9;
  vertical-align: middle;
}
.error-message {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--m3-error);
  margin-top: 4px;
  opacity: 0.85;
  line-height: 1.4;
}
</style>
