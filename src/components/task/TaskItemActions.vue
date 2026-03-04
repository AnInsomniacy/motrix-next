<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import { NIcon, NTooltip } from 'naive-ui'
import {
  PauseOutline, PlayOutline, StopOutline, RefreshOutline,
  CloseOutline, TrashOutline, LinkOutline, InformationCircleOutline,
  FolderOpenOutline
} from '@vicons/ionicons5'
import { type Component } from 'vue'

const props = defineProps<{ task: Record<string, unknown>; status: string }>()
const emit = defineEmits<{
  pause: []; resume: []; delete: []; 'delete-record': [];
  'copy-link': []; 'show-info': []; folder: []
}>()

const { t } = useI18n()

const actionsMap = computed<Record<string, { key: string; icon: Component; label: string; event: string }[]>>(() => ({
  [TASK_STATUS.ACTIVE]: [
    { key: 'pause', icon: PauseOutline, label: t('task.pause-task'), event: 'pause' },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
  [TASK_STATUS.PAUSED]: [
    { key: 'resume', icon: PlayOutline, label: t('task.resume-task'), event: 'resume' },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
  [TASK_STATUS.WAITING]: [
    { key: 'resume', icon: PlayOutline, label: t('task.resume-task'), event: 'resume' },
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
    { key: 'stop', icon: StopOutline, label: t('task.pause-task'), event: 'pause' },
    { key: 'delete', icon: CloseOutline, label: t('task.delete-task'), event: 'delete' },
  ],
}))

const actions = computed(() => {
  const primary = actionsMap.value[props.status] || []
  const common = [
    { key: 'folder', icon: FolderOpenOutline, label: t('task.show-in-folder'), event: 'folder' },
    { key: 'link', icon: LinkOutline, label: t('task.copy-link'), event: 'copy-link' },
    { key: 'info', icon: InformationCircleOutline, label: t('task.task-detail-title'), event: 'show-info' },
  ]
  return [...primary, ...common].reverse()
})

function onAction(event: string) {
  switch (event) {
    case 'pause': emit('pause'); break
    case 'resume': emit('resume'); break
    case 'delete': emit('delete'); break
    case 'delete-record': emit('delete-record'); break
    case 'copy-link': emit('copy-link'); break
    case 'show-info': emit('show-info'); break
    case 'folder': emit('folder'); break
  }
}
</script>

<template>
  <ul class="task-item-actions" @dblclick.stop>
    <li
      v-for="action in actions"
      :key="action.key"
      class="task-item-action"
      @click.stop="onAction(action.event)"
    >
      <NTooltip :delay="500">
        <template #trigger>
          <NIcon :size="20"><component :is="action.icon" /></NIcon>
        </template>
        {{ action.label }}
      </NTooltip>
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
  transition: all .25s cubic-bezier(.645, .045, .355, 1);
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
  transition: color .15s, background-color .15s;
}
.task-item-action:hover {
  color: var(--primary-color, #E0A422);
}
</style>
