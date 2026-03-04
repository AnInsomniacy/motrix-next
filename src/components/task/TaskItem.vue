<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsSeeder, getTaskName, calcProgress, bytesToSize, timeRemaining, timeFormat, checkTaskIsBT } from '@shared/utils'
import { NProgress, NIcon } from 'naive-ui'
import { ArrowUpOutline, ArrowDownOutline, GitNetworkOutline, MagnetOutline } from '@vicons/ionicons5'
import TaskItemActions from './TaskItemActions.vue'

const props = defineProps<{ task: Record<string, unknown> }>()
const emit = defineEmits<{
  pause: [task: Record<string, unknown>]
  resume: [task: Record<string, unknown>]
  delete: [task: Record<string, unknown>]
  'delete-record': [task: Record<string, unknown>]
  'copy-link': [task: Record<string, unknown>]
  'show-info': [task: Record<string, unknown>]
  folder: [task: Record<string, unknown>]
}>()

const { t } = useI18n()

const taskFullName = computed(() =>
  getTaskName(props.task as never, { defaultName: t('task.get-task-name') || 'Unknown', maxLen: -1 })
)

const isSeeder = computed(() => checkTaskIsSeeder(props.task as never))
const isBT = computed(() => checkTaskIsBT(props.task as never))
const taskStatus = computed(() => isSeeder.value ? TASK_STATUS.SEEDING : (props.task.status as string))
const isActive = computed(() => props.task.status === TASK_STATUS.ACTIVE)

const percent = computed(() => calcProgress(props.task.totalLength as number, props.task.completedLength as number))
const completedSize = computed(() => bytesToSize(props.task.completedLength as string, 2))
const totalSize = computed(() => bytesToSize(props.task.totalLength as string, 2))
const downloadSpeed = computed(() => bytesToSize(props.task.downloadSpeed as string))
const uploadSpeed = computed(() => bytesToSize(props.task.uploadSpeed as string))

const remaining = computed(() => {
  if (!isActive.value) return 0
  return timeRemaining(Number(props.task.totalLength), Number(props.task.completedLength), Number(props.task.downloadSpeed))
})

const remainingText = computed(() => {
  if (remaining.value <= 0) return ''
  return timeFormat(remaining.value, {
    prefix: t('task.remaining-prefix') || '',
    i18n: { gt1d: t('app.gt1d') || '>1d', hour: t('app.hour') || 'h', minute: t('app.minute') || 'm', second: t('app.second') || 's' },
  })
})

const statusColorMap: Record<string, string> = {
  active: '#E0A422',
  waiting: '#E6A23C',
  paused: '#909399',
  error: '#F56C6C',
  complete: '#67C23A',
  removed: '#909399',
  seeding: '#67C23A',
}

const progressColor = computed(() => statusColorMap[taskStatus.value] || '#E0A422')

function onDblClick() {
  const s = props.task.status as string
  if (s === TASK_STATUS.COMPLETE) return
  if (s === TASK_STATUS.ACTIVE) emit('pause', props.task)
  else if (s === TASK_STATUS.WAITING || s === TASK_STATUS.PAUSED) emit('resume', props.task)
}
</script>

<template>
  <div class="task-item" @dblclick="onDblClick">
    <div class="task-name" :title="taskFullName">
      <span>{{ taskFullName }}</span>
    </div>
    <TaskItemActions
      :task="task"
      :status="taskStatus"
      @pause="emit('pause', task)"
      @resume="emit('resume', task)"
      @delete="emit('delete', task)"
      @delete-record="emit('delete-record', task)"
      @copy-link="emit('copy-link', task)"
      @show-info="emit('show-info', task)"
      @folder="emit('folder', task)"
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
  border-radius: 6px;
  transition: border-color .25s cubic-bezier(.645, .045, .355, 1);
}
.task-item:hover {
  border-color: var(--task-item-hover-border);
}
.task-name {
  color: var(--task-item-text);
  margin-bottom: 1.5rem;
  margin-right: 200px;
  word-break: break-all;
  min-height: 26px;
}
.task-name > span {
  font-size: 14px;
  line-height: 26px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.task-progress-info {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  line-height: 14px;
  min-height: 14px;
  color: #9B9B9B;
  margin-top: 8px;
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
</style>
