<script setup lang="ts">
/** @fileoverview Task list view with polling, task actions, and file delete confirmation. */
import { computed, watch, onMounted, onBeforeUnmount, ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTaskStore } from '@/stores/task'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'
import { useHistoryStore } from '@/stores/history'
import { isEngineReady } from '@/api/aria2'
import { useTaskActions } from '@/composables/useTaskActions'
import {
  parseFilesForSelection,
  buildSelectFileOption,
  buildStatusAwareConfirmAction,
} from '@/composables/useMagnetFlow'
import { buildHistoryRecord, isMetadataTask } from '@/composables/useTaskLifecycle'
import { shouldDeleteTorrent, trashTorrentFile, cleanupTorrentMetadataFiles } from '@/composables/useDownloadCleanup'
import type { MagnetFileItem } from '@/composables/useMagnetFlow'
import { getTaskDisplayName } from '@shared/utils'
import { ARIA2_ERROR_CODES } from '@shared/aria2ErrorCodes'
import { logger } from '@shared/logger'
import { useDialog } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import TaskList from '@/components/task/TaskList.vue'
import TaskActions from '@/components/task/TaskActions.vue'
import TaskDetail from '@/components/task/TaskDetail.vue'
import MagnetFileSelect from '@/components/task/MagnetFileSelect.vue'

const props = withDefaults(defineProps<{ status?: string }>(), { status: 'active' })

const { t } = useI18n()
const taskStore = useTaskStore()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const historyStore = useHistoryStore()
const dialog = useDialog()
const message = useAppMessage()

const stoppingGids = ref<string[]>([])
provide('stoppingGids', stoppingGids)

const {
  handlePauseTask,
  handleResumeTask,
  handleDeleteTask,
  handleDeleteRecord,
  handleCopyLink,
  handleShowInfo,
  handleShowInFolder,
  handleOpenFile,
  handleStopSeeding,
} = useTaskActions({
  taskStore,
  preferenceConfig: () => preferenceStore.config,
  t,
  dialog,
  message,
  stoppingGids,
})

// ── Magnet file selection state ──────────────────────────────────────
const magnetSelectVisible = ref(false)
const magnetSelectFiles = ref<MagnetFileItem[]>([])
const magnetSelectGid = ref('')
const magnetSelectName = ref('')
let magnetPollTimer: ReturnType<typeof setTimeout> | null = null

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
    // Skip BT metadata-only downloads — they are intermediate steps
    if (isMetadataTask(task)) return
    // Persist error record to history DB (fire-and-forget)
    const record = buildHistoryRecord(task)
    historyStore.addRecord(record).catch((e) => logger.debug('TaskView.historyRecord.error', e))
    // Show error toast notification
    if (preferenceStore.config?.taskNotification === false) return
    const i18nKey = task.errorCode ? ARIA2_ERROR_CODES[task.errorCode] : undefined
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const errorText = i18nKey ? t(i18nKey) : task.errorMessage || t('task.error-unknown')
    message.error(`${taskName}: ${errorText}`, { duration: 8000, closable: true })
  })
  // Wire task completion lifecycle: history recording
  taskStore.setOnTaskComplete((task) => {
    // Skip BT metadata-only downloads — they are intermediate steps
    if (isMetadataTask(task)) return
    // Record to history DB (fire-and-forget)
    const record = buildHistoryRecord(task)
    historyStore.addRecord(record).catch((e) => logger.debug('TaskView.historyRecord', e))
  })
  // Wire BT completion lifecycle: trash original .torrent source file + clean aria2 metadata.
  taskStore.setOnBtComplete(async (task) => {
    if (!shouldDeleteTorrent(preferenceStore.config)) return
    // Trash the original .torrent file the user added (keyed by infoHash to avoid race)
    const sourcePath = task.infoHash ? taskStore.consumeTorrentSource(task.infoHash) : undefined
    if (sourcePath) {
      const ok = await trashTorrentFile(sourcePath)
      if (ok) {
        const taskName = getTaskDisplayName(task)
        message.success(t('task.torrent-trashed', { taskName }))
      }
    }
    // Clean up aria2's auto-saved metadata copy in the download dir
    if (task.dir && task.infoHash) {
      cleanupTorrentMetadataFiles(task.dir, task.infoHash).catch((e) => logger.debug('TaskView.metadataCleanup', e))
    }
  })
})
onBeforeUnmount(stopPolling)
onBeforeUnmount(() => {
  if (magnetPollTimer) {
    clearTimeout(magnetPollTimer)
    magnetPollTimer = null
  }
  // If file selection dialog is still open when navigating away,
  // close it cleanly. The task stays paused — user can resume/delete
  // it from the task list.
  if (magnetSelectVisible.value) {
    magnetSelectVisible.value = false
  }
})

// ── Magnet metadata monitoring ───────────────────────────────────────

/**
 * Poll pending magnet tasks for metadata completion.
 *
 * aria2 creates a NEW GID (via followedBy) for the actual download after
 * magnet metadata resolves. With pause-metadata=true, this follow-up task
 * starts paused. We poll the metadata GID for followedBy, then call getFiles
 * on the follow-up GID to show the file selection dialog.
 *
 * When multiple magnets are added concurrently, only one dialog is shown at
 * a time. The poll pauses while a dialog is open and resumes after the user
 * confirms or cancels — preventing dialog state from being overwritten.
 */
function startMagnetPoll() {
  if (magnetPollTimer) clearTimeout(magnetPollTimer)

  async function tick() {
    const gids = appStore.pendingMagnetGids

    // Don't overwrite an open dialog — pause polling and let
    // confirm/cancel handler restart it for remaining GIDs.
    if (magnetSelectVisible.value) {
      magnetPollTimer = null
      return
    }

    if (gids.length === 0) {
      magnetPollTimer = null
      return
    }

    for (const gid of [...gids]) {
      try {
        const task = await taskStore.fetchTaskStatus(gid)

        // Use followedBy GID if available (magnet follow-up), else same GID
        const targetGid = task.followedBy?.[0] ?? gid

        const files = await taskStore.getFiles(targetGid)
        // Filter real content files (length > 0) and skip [METADATA] entries
        const realFiles = files.filter((f) => Number(f.length) > 0 && !f.path.startsWith('[METADATA]'))
        if (realFiles.length === 0) continue

        // Metadata resolved — show file selection dialog
        appStore.pendingMagnetGids = gids.filter((g) => g !== gid)
        const parsed = parseFilesForSelection(realFiles)
        magnetSelectFiles.value = parsed
        magnetSelectGid.value = targetGid
        magnetSelectName.value = task.bittorrent?.info?.name || parsed[0]?.name || 'Magnet Download'
        magnetSelectVisible.value = true
        return // Process one magnet at a time
      } catch {
        // Task may have been removed or metadata still downloading — skip
      }
    }

    magnetPollTimer = setTimeout(tick, 2000)
  }

  void tick()
}

watch(
  () => appStore.pendingMagnetGids,
  (gids) => {
    if (gids.length > 0) startMagnetPoll()
  },
  { immediate: true },
)

async function handleMagnetConfirm(selectedIndices: number[]) {
  magnetSelectVisible.value = false
  const gid = magnetSelectGid.value
  if (!gid) return

  try {
    const selectFile = buildSelectFileOption(selectedIndices)
    const task = taskStore.taskList.find((t) => t.gid === gid)
    const action = buildStatusAwareConfirmAction(task?.status)

    // aria2 requires task to be paused before changing select-file on active tasks
    if (action.needsPause && task) {
      await taskStore.pauseTask(task)
    }

    await taskStore.changeTaskOption({ gid, options: { 'select-file': selectFile } })

    if (action.needsResume && task) {
      await taskStore.resumeTask(task)
    }
    message.success(t('task.magnet-files-selected') || 'Files selected, download starting')
  } catch (e) {
    logger.error('TaskView.magnetConfirm', e)
    message.error(t('task.magnet-select-fail') || 'Failed to configure download')
  }

  // Resume polling for any remaining pending magnet GIDs.
  // Delay to let the modal close animation finish before showing the next dialog.
  if (appStore.pendingMagnetGids.length > 0) {
    setTimeout(startMagnetPoll, 350)
  }
}

async function handleMagnetCancel() {
  magnetSelectVisible.value = false
  const gid = magnetSelectGid.value
  if (!gid) return

  try {
    const task = taskStore.taskList.find((t) => t.gid === gid)
    if (task) {
      await taskStore.removeTask(task)
    }
    message.info(t('task.magnet-download-cancelled') || 'Download cancelled')
  } catch (e) {
    logger.error('TaskView.magnetCancel', e)
  }

  // Resume polling for any remaining pending magnet GIDs.
  // Delay to let the modal close animation finish before showing the next dialog.
  if (appStore.pendingMagnetGids.length > 0) {
    setTimeout(startMagnetPoll, 350)
  }
}

// Task action handlers are now provided by useTaskActions composable above.
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
        @open-file="handleOpenFile"
        @stop-seeding="handleStopSeeding"
      />
    </div>
    <TaskDetail
      :show="taskStore.taskDetailVisible"
      :task="taskStore.currentTaskItem"
      :files="taskStore.currentTaskFiles"
      @close="taskStore.hideTaskDetail()"
    />
    <MagnetFileSelect
      :show="magnetSelectVisible"
      :files="magnetSelectFiles"
      :task-name="magnetSelectName"
      @confirm="handleMagnetConfirm"
      @cancel="handleMagnetCancel"
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
