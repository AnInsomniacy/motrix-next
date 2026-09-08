<script setup lang="ts">
/** @fileoverview Individual task row in the task list with progress and controls. */
import { computed } from 'vue'
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
import TaskTextTransition from './TaskTextTransition.vue'
import type { Aria2Task } from '@shared/types'

const props = withDefaults(defineProps<{ task: Aria2Task; actionPending?: boolean }>(), { actionPending: false })
const emit = defineEmits<{
  pause: [task: Aria2Task]
  resume: [task: Aria2Task]
  retry: [task: Aria2Task]
  redownload: [task: Aria2Task]
  'finish-sharing': [task: Aria2Task]
  delete: [task: Aria2Task]
  'delete-record': [task: Aria2Task]
  'copy-link': [task: Aria2Task]
  'show-info': [task: Aria2Task]
  folder: [task: Aria2Task]
  'open-file': [task: Aria2Task]
  'select-files': [task: Aria2Task]
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
  transferSummary,
} = useTaskCardModel(taskRef)

const statusColorMap: Record<string, string> = {
  active: 'var(--m3-status-active)',
  waiting: 'var(--m3-status-waiting)',
  paused: 'var(--m3-status-paused)',
  error: 'var(--m3-status-error)',
  complete: 'var(--m3-status-success)',
  removed: 'var(--m3-status-paused)',
  sharing: 'var(--m3-status-success)',
}

const progressColor = computed(() => statusColorMap[taskStatus.value] || 'var(--m3-status-active)')
const hasStatusLine = computed(() => Boolean(statusBadge.value || fileMissing.value))
const displayErrorMessage = computed(() => props.task.errorMessage || props.task.bittorrent?.error?.message || '')

const statusBadgeStyle = computed(() => {
  switch (statusBadge.value?.tone) {
    case 'success':
      return { color: 'var(--m3-status-success)' }
    case 'error':
      return { color: 'var(--m3-status-error)' }
    case 'waiting':
      return { color: 'var(--m3-status-waiting)' }
    case 'muted':
      return { color: 'var(--m3-status-paused)' }
    default:
      return { color: 'var(--m3-status-paused)' }
  }
})

const statusBadgeIcon = computed(() => {
  switch (statusBadge.value?.key) {
    case TASK_STATUS.COMPLETE:
      return CheckmarkCircleOutline
    case TASK_STATUS.ERROR:
    case 'bt-error':
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

const { fileMissing } = useTaskFileMissing(taskRef)
</script>

<template>
  <div
    class="task-item"
    :class="{
      'is-sharing': isSharing,
    }"
  >
    <TaskDragHandle class="task-drag-rail" />
    <div class="task-body">
      <div class="task-header">
        <MTooltip placement="bottom-start">
          <template #trigger>
            <div class="task-name">
              <TaskTextTransition :value="taskFullName">
                <span class="technical-text-wrap">{{ taskFullName }}</span>
              </TaskTextTransition>
            </div>
          </template>
          {{ taskFullName }}
        </MTooltip>
        <TaskItemActions
          :task="task"
          :file-missing="fileMissing"
          :pending="actionPending"
          @pause="emit('pause', task)"
          @resume="emit('resume', task)"
          @retry="emit('retry', task)"
          @redownload="emit('redownload', task)"
          @finish-sharing="emit('finish-sharing', task)"
          @delete="emit('delete', task)"
          @delete-record="emit('delete-record', task)"
          @copy-link="emit('copy-link', task)"
          @show-info="emit('show-info', task)"
          @folder="emit('folder', task)"
          @open-file="emit('open-file', task)"
          @select-files="emit('select-files', task)"
        />
      </div>
      <div class="task-status-slot" :class="{ 'task-status-slot--visible': hasStatusLine }">
        <div class="task-status-slot__inner">
          <div class="task-tags" :class="{ 'task-tags--visible': hasStatusLine }">
            <TaskTextTransition v-show="statusBadge" :value="statusBadge?.key ?? ''">
              <span v-if="statusBadge" class="status-tag" :style="statusBadgeStyle">
                <NIcon :size="13"><component :is="statusBadgeIcon" /></NIcon>
                {{ statusBadge.label }}
              </span>
            </TaskTextTransition>
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
            <span>{{ percent }}% · {{ completedSize }} / {{ totalSize }}</span>
          </div>
          <div class="progress-right" :class="{ 'info-hidden': !isActive }">
            <span class="speed-text" :class="{ 'info-hidden': remaining <= 0 }">
              <span>{{ remainingText }}</span>
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
          <div class="error-message technical-text-wrap" :class="{ 'info-hidden': !displayErrorMessage }">
            {{ displayErrorMessage }}
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
  transition: opacity var(--task-motion-state) var(--task-motion-ease);
}
/* ── Seeding state (static) ────────────────────────────────────────── */
.task-item.is-sharing {
  border-left-color: var(--m3-success);
}
.task-item.is-sharing::before {
  opacity: 1;
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
.task-name > .task-text-transition {
  display: grid;
}
.task-name :deep(.task-text-transition-content) {
  font-size: 14px;
  line-height: 26px;
  display: -webkit-box;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
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
/* M3 progress-bar transition between semantic status colors. */
.task-progress :deep(.n-progress-graph-line-fill) {
  transition:
    max-width var(--task-motion-progress) var(--task-motion-ease),
    background-color var(--task-motion-state) var(--task-motion-ease);
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
  transition: opacity var(--task-motion-state) var(--task-motion-ease);
}
.progress-right {
  display: flex;
  gap: 8px;
  text-align: right;
  align-items: center;
  transition: opacity var(--task-motion-state) var(--task-motion-ease);
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
  font-size: 13px;
  line-height: 18px;
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
.task-tags > .task-text-transition {
  min-height: 18px;
}
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 13px;
  line-height: 18px;
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
