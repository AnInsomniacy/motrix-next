<script setup lang="ts">
/** @fileoverview Task list view with polling, task actions, and file delete confirmation. */
import { computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTaskStore } from '@/stores/task'
import { useTaskSelectionStore } from '@/stores/taskSelection'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'

import { isEngineReady } from '@/api/aria2'
import { useTaskActions } from '@/composables/useTaskActions'

import { logger } from '@shared/logger'
import { useDialog } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import TaskList from '@/components/task/TaskList.vue'
import TaskActions from '@/components/task/TaskActions.vue'
import TaskDetail from '@/components/task/TaskDetail.vue'
import TaskEmptyBrand from '@/components/task/TaskEmptyBrand.vue'

const props = withDefaults(defineProps<{ status?: string }>(), { status: 'all' })

const { t } = useI18n()
const taskStore = useTaskStore()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const showEmptyBrand = computed(() => preferenceStore.config.showLogoWhenEmpty && taskStore.isCurrentListEmpty)
const dialog = useDialog()
const message = useAppMessage()

const {
  handlePauseTask,
  handleResumeTask,
  handleRetryTask,
  handleRedownloadTask,
  handleFinishSharing,
  handleFinishMedia,
  handleDeleteTask,
  handleDeleteRecord,
  handleCopyLink,
  handleShowInfo,
  handleShowInFolder,
  handleOpenFile,
  handleSelectFiles,
} = useTaskActions({
  taskStore,
  preferenceConfig: () => preferenceStore.config,
  t,
  dialog,
  message,
  requestMagnetSelection: (gid) => useTaskSelectionStore().request({ kind: 'bt', gid }),
})

const subnavs = computed(() => [
  { key: 'all', title: t('task.scope-all') || 'All' },
  { key: 'progress', title: t('task.scope-progress') || 'In Progress' },
  { key: 'failed', title: t('task.scope-failed') || 'Failed' },
  { key: 'completed', title: t('task.scope-completed') || 'Completed' },
])

const title = computed(() => {
  const sub = subnavs.value.find((s) => s.key === props.status)
  return sub?.title ?? props.status
})

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let pollStopped = true
let isUnmounted = false
let changeRequestId = 0

function startPolling() {
  if (isUnmounted) return
  stopPolling()
  pollStopped = false
  async function tick() {
    if (pollStopped) return
    if (isEngineReady()) {
      await taskStore.fetchList().catch((e) => logger.debug('TaskView.fetchList', e))
    }
    if (pollStopped) return
    refreshTimer = setTimeout(tick, appStore.interval)
  }
  refreshTimer = setTimeout(tick, appStore.interval)
}

function stopPolling() {
  pollStopped = true
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

async function changeCurrentList() {
  stopPolling()
  const requestId = ++changeRequestId
  await taskStore.changeCurrentList(props.status)
  if (isUnmounted || requestId !== changeRequestId) return
  startPolling()
}

watch(
  () => props.status,
  () => {
    void changeCurrentList()
  },
)
onMounted(() => {
  isUnmounted = false
  void changeCurrentList()
})
onBeforeUnmount(() => {
  isUnmounted = true
  changeRequestId += 1
  stopPolling()
})
</script>

<template>
  <div class="task-view">
    <header class="panel-header" data-tauri-drag-region>
      <h4 :key="status" class="task-title">{{ title }}</h4>
      <TaskActions />
    </header>
    <div class="panel-body">
      <TaskEmptyBrand :show="showEmptyBrand" />
      <div class="panel-content">
        <TaskList
          @pause="handlePauseTask"
          @resume="handleResumeTask"
          @retry="handleRetryTask"
          @redownload="handleRedownloadTask"
          @finish-sharing="handleFinishSharing"
          @finish-media="handleFinishMedia"
          @delete="handleDeleteTask"
          @delete-record="handleDeleteRecord"
          @copy-link="handleCopyLink"
          @show-info="handleShowInfo"
          @folder="handleShowInFolder"
          @open-file="handleOpenFile"
          @select-files="handleSelectFiles"
        />
      </div>
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
  padding: var(--header-top-offset) 0 12px;
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
  align-self: flex-start;
}
.panel-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.panel-content {
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
