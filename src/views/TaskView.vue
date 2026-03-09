<script setup lang="ts">
/** @fileoverview Task list view with polling, task actions, and file delete confirmation. */
import { computed, watch, onMounted, onBeforeUnmount, ref, h, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTaskStore } from '@/stores/task'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'
import { getTaskUri, getTaskName } from '@shared/utils'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { isEngineReady } from '@/api/aria2'
import { deleteTaskFiles } from '@/composables/useFileDelete'
import type { Aria2Task } from '@shared/types'
import { TASK_STATUS } from '@shared/constants'
import { logger } from '@shared/logger'
import { useDialog, NCheckbox } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import { useAppNotification } from '@/composables/useAppNotification'
import TaskList from '@/components/task/TaskList.vue'
import TaskActions from '@/components/task/TaskActions.vue'
import TaskDetail from '@/components/task/TaskDetail.vue'

const props = withDefaults(defineProps<{ status?: string }>(), { status: 'active' })

const { t } = useI18n()
const taskStore = useTaskStore()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const { notifyError, notifyTaskError } = useAppNotification()

const stoppingGids = ref<string[]>([])
provide('stoppingGids', stoppingGids)

const subnavs = computed(() => [
  { key: 'active', title: t('task.active') || 'Active' },
  { key: 'stopped', title: t('task.stopped') || 'Completed' },
])

const title = computed(() => {
  const sub = subnavs.value.find((s) => s.key === props.status)
  return sub?.title ?? props.status
})

let refreshTimer: ReturnType<typeof setTimeout> | null = null

function startPolling() {
  stopPolling()
  function tick() {
    if (isEngineReady()) {
      taskStore.fetchList().catch((e) => logger.debug('TaskView.fetchList', e))
    }
    refreshTimer = setTimeout(tick, appStore.interval)
  }
  refreshTimer = setTimeout(tick, appStore.interval)
}

function stopPolling() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

async function changeCurrentList() {
  stopPolling()
  await taskStore.changeCurrentList(props.status)
  startPolling()
}

watch(() => props.status, changeCurrentList)
onMounted(() => {
  changeCurrentList()
  taskStore.setOnTaskError((task) => {
    if (preferenceStore.config?.taskNotification === false) return
    const taskName = getTaskName(task, { defaultName: 'Unknown' })
    notifyTaskError(task.errorCode, task.errorMessage, taskName)
  })
})
onBeforeUnmount(stopPolling)

// File deletion handled by @/composables/useFileDelete
function handlePauseTask(task: Aria2Task) {
  const taskName = getTaskName(task, { defaultName: 'Unknown' })
  taskStore
    .pauseTask(task)
    .then(() => message.success(t('task.pause-task-success', { taskName })))
    .catch((e) => notifyError(e, 'task'))
}
function handleResumeTask(task: Aria2Task) {
  const taskName = getTaskName(task, { defaultName: 'Unknown' })
  const { COMPLETE, ERROR, REMOVED } = TASK_STATUS
  if (task.status === ERROR || task.status === COMPLETE || task.status === REMOVED) {
    // Stopped tasks cannot be unpause'd — restart by re-adding the URI
    taskStore
      .restartTask(task)
      .then(() => message.success(t('task.resume-task-success', { taskName })))
      .catch((e) => notifyError(e, 'task'))
  } else {
    taskStore
      .resumeTask(task)
      .then(() => message.success(t('task.resume-task-success', { taskName })))
      .catch((e) => notifyError(e, 'task'))
  }
}
function handleDeleteTask(task: Aria2Task) {
  const noConfirm = preferenceStore.config?.noConfirmBeforeDeleteTask
  if (noConfirm) {
    taskStore.removeTask(task).catch((e) => notifyError(e, 'task'))
    return
  }
  const deleteFiles = ref(false)
  const name = getTaskName(task, { defaultName: 'Unknown' })
  const d = dialog.warning({
    title: t('task.delete-task'),
    content: () =>
      h('div', {}, [
        h('p', { style: 'margin: 0 0 12px; word-break: break-all;' }, name),
        h(
          NCheckbox,
          {
            checked: deleteFiles.value,
            'onUpdate:checked': (v: boolean) => {
              deleteFiles.value = v
            },
          },
          { default: () => t('task.delete-task-label') },
        ),
      ]),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      d.loading = true
      d.negativeButtonProps = { disabled: true }
      d.closable = false
      d.maskClosable = false
      // Yield to browser so the loading spinner renders before heavy IPC work
      await new Promise((r) => setTimeout(r, 50))
      try {
        await taskStore.removeTask(task)
        if (deleteFiles.value) {
          await deleteTaskFiles(task)
        }
        message.success(t('task.delete-task-success', { taskName: name }))
      } catch (e) {
        logger.error('TaskView.deleteTask', e)
        message.error(t('task.delete-task-fail', { taskName: name }))
      }
    },
  })
}
function handleDeleteRecord(task: Aria2Task) {
  const taskName = getTaskName(task, { defaultName: 'Unknown' })
  taskStore
    .removeTaskRecord(task)
    .then(() => message.success(t('task.remove-record-success', { taskName })))
    .catch((e) => notifyError(e, 'task'))
}
function handleCopyLink(task: Aria2Task) {
  navigator.clipboard.writeText(getTaskUri(task))
  message.success(t('task.copy-link-success'))
}
function handleShowInfo(task: Aria2Task) {
  taskStore.showTaskDetail(task)
}
async function handleShowInFolder(task: Aria2Task) {
  const files = task.files || []
  const filePath = files[0]?.path
  if (!filePath) return
  try {
    await revealItemInDir(filePath)
  } catch (e) {
    logger.debug('TaskView.openFile', e)
    message.warning(t('task.file-not-exist'))
  }
}
async function handleStopSeeding(task: Aria2Task) {
  if (stoppingGids.value.includes(task.gid)) return // prevent double-click
  stoppingGids.value = [...stoppingGids.value, task.gid]
  message.info(t('task.bt-stopping-seeding-tip'), { duration: 5000, closable: true })
  try {
    await taskStore.stopSeeding(task.gid)
    // Don't remove from stoppingGids — let the spinner run
    // until the task transitions to 'complete' and vanishes from the list
  } catch (e) {
    notifyError(e, 'task')
    // Only clear on error so user can retry
    stoppingGids.value = stoppingGids.value.filter((g) => g !== task.gid)
  }
}
</script>

<template>
  <div class="task-view">
    <header class="panel-header" data-tauri-drag-region>
      <h4 :key="status" class="task-title">{{ title }}</h4>
      <TaskActions />
    </header>
    <div class="panel-content">
      <TaskList
        :key="props.status"
        @pause="handlePauseTask"
        @resume="handleResumeTask"
        @delete="handleDeleteTask"
        @delete-record="handleDeleteRecord"
        @copy-link="handleCopyLink"
        @show-info="handleShowInfo"
        @folder="handleShowInFolder"
        @stop-seeding="handleStopSeeding"
      />
    </div>
    <TaskDetail
      :show="taskStore.taskDetailVisible"
      :task="taskStore.currentTaskItem"
      :files="taskStore.currentTaskFiles"
      @close="taskStore.hideTaskDetail()"
    />
  </div>
</template>

<style scoped>
.task-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.panel-header {
  position: relative;
  padding: 46px 0 12px;
  margin: 0 36px;
  border-bottom: 2px solid var(--panel-border);
  user-select: none;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}
.task-title {
  margin: 0;
  color: var(--panel-title);
  font-size: 16px;
  font-weight: normal;
  line-height: 24px;
}
.panel-content {
  position: relative;
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
