<script setup lang="ts">
/** @fileoverview Individual task row in the task list with progress and controls. */
import { computed, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import {
  checkTaskIsSeeder,
  getTaskDisplayName,
  calcProgress,
  bytesToSize,
  timeRemaining,
  timeFormat,
  checkTaskIsBT,
} from '@shared/utils'
import { exists } from '@tauri-apps/plugin-fs'
import { logger } from '@shared/logger'
import { NProgress, NIcon } from 'naive-ui'
import {
  ArrowUpOutline,
  ArrowDownOutline,
  GitNetworkOutline,
  MagnetOutline,
  AlertCircleOutline,
  CloudUploadOutline,
  CheckmarkCircleOutline,
  TrashOutline,
} from '@vicons/ionicons5'
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
  'stop-seeding': [task: Aria2Task]
}>()

const { t } = useI18n()

const taskFullName = computed(() =>
  getTaskDisplayName(props.task, { defaultName: t('task.get-task-name') || 'Unknown' }),
)

const isSeeder = computed(() => checkTaskIsSeeder(props.task))
const isBT = computed(() => checkTaskIsBT(props.task))
const taskStatus = computed(() => (isSeeder.value ? TASK_STATUS.SEEDING : props.task.status))
const isActive = computed(() => props.task.status === TASK_STATUS.ACTIVE)

const percent = computed(() => calcProgress(props.task.totalLength, props.task.completedLength))
const completedSize = computed(() => bytesToSize(props.task.completedLength, 2))
const totalSize = computed(() => bytesToSize(props.task.totalLength, 2))
const downloadSpeed = computed(() => bytesToSize(props.task.downloadSpeed))
const uploadSpeed = computed(() => bytesToSize(props.task.uploadSpeed))

const remaining = computed(() => {
  if (!isActive.value) return 0
  return timeRemaining(
    Number(props.task.totalLength),
    Number(props.task.completedLength),
    Number(props.task.downloadSpeed),
  )
})

const remainingText = computed(() => {
  if (remaining.value <= 0) return ''
  return timeFormat(remaining.value, {
    prefix: t('task.remaining-prefix') || '',
    i18n: {
      gt1d: t('app.gt1d') || '>1d',
      hour: t('app.hour') || 'h',
      minute: t('app.minute') || 'm',
      second: t('app.second') || 's',
    },
  })
})

/** Reads a CSS variable from :root, returning the fallback if unavailable. */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

const statusColorMap = computed<Record<string, string>>(() => ({
  active: cssVar('--m3-status-active', '#E0A422'),
  waiting: cssVar('--m3-status-waiting', '#E6A23C'),
  paused: cssVar('--m3-status-paused', '#909399'),
  error: cssVar('--m3-status-error', '#F56C6C'),
  complete: cssVar('--m3-status-success', '#67C23A'),
  removed: cssVar('--m3-status-paused', '#909399'),
  seeding: cssVar('--m3-status-success', '#67C23A'),
}))

const progressColor = computed(() => statusColorMap.value[taskStatus.value] || cssVar('--m3-status-active', '#E0A422'))

const finishedTag = computed(() => {
  const s = props.task.status
  if (s === TASK_STATUS.COMPLETE)
    return {
      label: t('task.task-complete') || 'Completed',
      color: cssVar('--m3-status-success', '#67C23A'),
      icon: CheckmarkCircleOutline,
    }
  if (s === TASK_STATUS.ERROR)
    return {
      label: t('task.task-error') || 'Error',
      color: cssVar('--m3-status-error', '#F56C6C'),
      icon: AlertCircleOutline,
    }
  if (s === TASK_STATUS.REMOVED)
    return {
      label: t('task.task-removed') || 'Removed',
      color: cssVar('--m3-status-paused', '#909399'),
      icon: TrashOutline,
    }
  return null
})

function onDblClick() {
  const s = props.task.status
  if (s === TASK_STATUS.COMPLETE) {
    emit('open-file', props.task)
    return
  }
  if (s === TASK_STATUS.ACTIVE) emit('pause', props.task)
  else if (s === TASK_STATUS.WAITING || s === TASK_STATUS.PAUSED) emit('resume', props.task)
}

// File missing detection for completed/stopped tasks
const fileMissing = ref(false)

async function checkFileExists() {
  const status = props.task.status
  if (status === TASK_STATUS.ACTIVE || status === TASK_STATUS.WAITING || status === TASK_STATUS.PAUSED) {
    fileMissing.value = false
    return
  }
  const dir = props.task.dir
  const files = props.task.files
  if (!files || files.length === 0 || !dir) {
    fileMissing.value = false
    return
  }
  try {
    // Only check files the user actually selected for download.
    // For BT tasks with partial file selection, unselected files
    // (selected === 'false') won't exist on disk — that is expected,
    // not "missing". Fall back to files[0] for non-BT single-file tasks.
    const selected = files.filter((f) => f.selected === 'true')
    const target = (selected.length > 0 ? selected[0] : files[0])?.path
    if (target) {
      fileMissing.value = !(await exists(target))
    }
  } catch (e) {
    logger.debug('TaskItem.fileCheck', e)
    fileMissing.value = false
  }
}

onMounted(checkFileExists)
watch(() => props.task.status, checkFileExists)

// ── M3 seeding state entrance animation ───────────────────────────
// CSS transitions fail here because the store's polling cycle replaces
// task objects entirely — even though Vue reuses the DOM element (same
// gid key), NProgress internally rebuilds its fill node, losing the
// transition starting point. @keyframes animations do not depend on
// property value continuity — they always play from→to.
const seedingEnter = ref(false)

watch(isSeeder, (now, was) => {
  if (now && !was) {
    seedingEnter.value = true
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
</script>

<template>
  <div
    ref="cardRef"
    class="task-item"
    :class="{
      'file-missing': fileMissing,
      'is-seeding': isSeeder,
      'seeding-enter': seedingEnter,
    }"
    @dblclick="onDblClick"
    @pointerdown="onCardPress"
    @pointerup="onCardRelease"
    @pointerleave="onCardRelease"
    @animationend="seedingEnter = false"
  >
    <div class="task-name" :title="taskFullName">
      <span>{{ taskFullName }}</span>
      <div class="tags-wrapper" :class="{ 'has-tags': isSeeder || finishedTag || fileMissing }">
        <div class="tags-inner">
          <div v-if="isSeeder || finishedTag || fileMissing" class="task-tags">
            <span v-if="isSeeder" class="seeding-tag">
              <NIcon :size="13"><CloudUploadOutline /></NIcon>
              {{ t('task.seeding') || 'Seeding' }}
            </span>
            <span v-else-if="finishedTag" class="status-tag" :style="{ color: finishedTag.color }">
              <NIcon :size="13"><component :is="finishedTag.icon" /></NIcon>
              {{ finishedTag.label }}
            </span>
            <span v-if="fileMissing" class="file-missing-tag">
              <NIcon :size="13"><AlertCircleOutline /></NIcon>
              {{ t('task.file-missing') || 'File missing' }}
            </span>
          </div>
        </div>
      </div>
    </div>
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
      @stop-seeding="emit('stop-seeding', task)"
    />
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
        <div class="progress-left">
          <span v-if="Number(task.completedLength) > 0 || Number(task.totalLength) > 0">
            {{ completedSize }}
            <span v-if="Number(task.totalLength) > 0"> / {{ totalSize }}</span>
          </span>
        </div>
        <div v-if="isActive" class="progress-right">
          <span v-if="isBT" class="speed-text">
            <NIcon :size="10"><ArrowUpOutline /></NIcon>
            <span>{{ uploadSpeed }}/s</span>
          </span>
          <span class="speed-text">
            <NIcon :size="10"><ArrowDownOutline /></NIcon>
            <span>{{ downloadSpeed }}/s</span>
          </span>
          <span v-if="remaining > 0" class="speed-text">
            <span>{{ remainingText }}</span>
          </span>
          <span v-if="isBT" class="speed-text">
            <NIcon :size="10"><MagnetOutline /></NIcon>
            <span>{{ task.numSeeders }}</span>
          </span>
          <span class="speed-text">
            <NIcon :size="10"><GitNetworkOutline /></NIcon>
            <span>{{ task.connections }}</span>
          </span>
        </div>
        <div v-if="task.errorMessage" class="error-message">{{ task.errorMessage }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-item {
  position: relative;
  min-height: 78px;
  padding: 16px 12px;
  background-color: var(--task-item-bg);
  border: 1px solid var(--task-item-border);
  /* Reserve 3px left border at base color so seeding only animates color */
  border-left: 3px solid var(--task-item-border);
  border-radius: 6px;
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
.task-item.is-seeding {
  border-left-color: var(--m3-success);
}
.task-item.is-seeding::before {
  opacity: 1;
}
/* ── Seeding entrance animation (triggered by Vue watch) ───────────── */
/* @keyframes always plays from→to regardless of prior DOM state,       */
/* unlike CSS transitions which break when the element is re-rendered.  */
@keyframes seeding-border-enter {
  from {
    border-left-color: var(--task-item-border);
  }
  to {
    border-left-color: var(--m3-success);
  }
}
@keyframes seeding-overlay-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.task-item.seeding-enter {
  animation: seeding-border-enter 1s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-item.seeding-enter::before {
  animation: seeding-overlay-enter 1.2s cubic-bezier(0.05, 0.7, 0.1, 1) forwards;
}
.task-item:hover {
  border-color: var(--task-item-hover-border);
}
/* ── Card press-hold state ──────────────────────────────────────────── */
/* Asymmetric timing: fast press-in (0.15s), springy release (0.35s).   */
/* The release uses M3 emphasized-decelerate for organic overshoot.     */
.task-item.pressed {
  transform: scale(0.98);
  border-color: var(--primary-color, #e0a422);
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
.task-name {
  color: var(--task-item-text);
  margin-bottom: 1.5rem;
  margin-right: 250px;
  overflow: hidden;
  min-height: 26px;
}
.task-name > span {
  font-size: 14px;
  line-height: 26px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
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
.task-progress-info {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  font-size: 12px;
  line-height: 14px;
  min-height: 14px;
  color: var(--m3-on-surface-variant);
  margin-top: 8px;
}
.progress-left {
  white-space: nowrap;
}
.progress-right {
  display: flex;
  gap: 8px;
  text-align: right;
  align-items: center;
}
.speed-text {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  line-height: 14px;
  white-space: nowrap;
}
.task-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* ── Tag height transition (CSS Grid 0fr→1fr) ────────────────────── */
/* Wrapper is always in the DOM. grid-template-rows transitions from    */
/* 0fr (collapsed, zero height) to 1fr (natural height). The inner      */
/* element uses overflow:hidden + min-height:0 to clip during collapse.  */
/* Works for all tags: seeding, completed, removed, file-missing.       */
.tags-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.4s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.tags-wrapper.has-tags {
  grid-template-rows: 1fr;
}
.tags-inner {
  overflow: hidden;
  min-height: 0;
}
.seeding-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  color: var(--m3-success);
  opacity: 0.9;
  vertical-align: middle;
  animation: m3-tag-enter 0.35s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  opacity: 0.9;
  vertical-align: middle;
  animation: m3-tag-enter 0.35s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.error-message {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--m3-error);
  margin-top: 4px;
  opacity: 0.85;
  word-break: break-all;
  line-height: 1.4;
}
</style>
