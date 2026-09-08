<script setup lang="ts">
/** @fileoverview Two-line compact task row with the same actions as the full card. */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { NIcon, NProgress } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { ArrowDownOutline, ArrowUpOutline, AlertCircleOutline, RadioOutline, TimeOutline } from '@vicons/ionicons5'
import { useTaskCardModel } from '@/composables/useTaskCardModel'
import { useTaskFileMissing } from '@/composables/useTaskFileMissing'
import TaskDragHandle from './TaskDragHandle.vue'
import TaskItemActions from './TaskItemActions.vue'
import TaskTextTransition from './TaskTextTransition.vue'
import type { Component } from 'vue'
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
const { fileMissing } = useTaskFileMissing(taskRef)

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
</script>

<template>
  <div
    class="task-compact-item"
    :class="{
      'is-sharing': isSharing,
    }"
  >
    <TaskDragHandle class="compact-drag-rail" />
    <div class="compact-body">
      <div class="compact-header">
        <MTooltip placement="bottom-start">
          <template #trigger>
            <div class="compact-name">
              <TaskTextTransition :value="taskFullName">{{ taskFullName }}</TaskTextTransition>
            </div>
          </template>
          {{ taskFullName }}
        </MTooltip>
        <TaskItemActions
          :task="task"
          :file-missing="fileMissing"
          :pending="actionPending"
          density="compact"
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
          <TaskTextTransition v-show="compactStatus" :value="fileMissing ? 'file-missing' : (statusBadge?.key ?? '')">
            <span v-if="compactStatus" class="compact-status" :class="{ error: compactStatus.tone === 'error' }">
              <NIcon :size="12"><component :is="compactStatus.icon" /></NIcon>
              {{ compactStatus.label }}
            </span>
          </TaskTextTransition>
          <span class="compact-speed">
            <NIcon :size="10"><ArrowDownOutline /></NIcon>
            {{ downloadSpeed }}/s
          </span>
          <span v-if="transferSummary.showUploadMetrics" class="compact-speed">
            <NIcon :size="10"><ArrowUpOutline /></NIcon>
            {{ uploadSpeed }}/s
          </span>
          <span v-if="remaining > 0">{{ remainingText }}</span>
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
  transition: opacity var(--task-motion-state) var(--task-motion-ease);
}
.task-compact-item.is-sharing {
  border-left-color: var(--m3-success);
}
.task-compact-item.is-sharing::before {
  opacity: 1;
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
  transition:
    max-width var(--task-motion-progress) var(--task-motion-ease),
    background-color var(--task-motion-state) var(--task-motion-ease);
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
.compact-name > .task-text-transition {
  display: grid;
}
.compact-name :deep(.task-text-transition-content) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
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
