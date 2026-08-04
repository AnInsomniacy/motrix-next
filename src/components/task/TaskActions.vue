<script setup lang="ts">
/** @fileoverview Batch task action buttons: resume all, pause all, delete all, purge. */
import { ref, computed, h, inject, watch, onBeforeUnmount, type Ref, type WatchStopHandle } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'

import { isEngineReady } from '@/api/aria2'
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsSharing } from '@shared/utils/task'
import type { Aria2Task } from '@shared/types'
import { deleteTaskFiles } from '@/composables/useFileDelete'

import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { NButton, NIcon, NCheckbox, NPopover, useDialog } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { useAppMessage } from '@/composables/useAppMessage'
import { usePreferenceStore } from '@/stores/preference'
import {
  ACTIVE_SORT_FIELDS,
  STOPPED_SORT_FIELDS,
  ALL_SORT_FIELDS,
  DEFAULT_TASK_SORT,
  type ActiveSortField,
  type StoppedSortField,
  type AllSortField,
} from '@/composables/useTaskSort'
import {
  AddOutline,
  PlayOutline,
  PauseOutline,
  TrashOutline,
  RefreshOutline,
  CloseOutline,
  StopCircleOutline,
  SyncOutline,
  SwapVerticalOutline,
  ArrowUpOutline,
  ArrowDownOutline,
} from '@vicons/ionicons5'

const { t } = useI18n()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()

// ── Sort dropdown ─────────────────────────────────────────────────
const currentTab = computed(() => taskStore.currentList)

/** Map sort field key to its i18n label. */
const SORT_LABELS: Record<string, string> = {
  manual: 'task.sort-manual',
  'added-at': 'task.sort-added-at',
  'completed-at': 'task.sort-completed-at',
  name: 'task.sort-name',
  size: 'task.sort-size',
  progress: 'task.sort-progress',
  speed: 'task.sort-speed',
}

/** Active sort config for the current tab. */
const currentSort = computed(() => {
  const cfg = preferenceStore.config?.taskSort ?? DEFAULT_TASK_SORT
  switch (currentTab.value) {
    case 'stopped':
      return cfg.stopped
    case 'all':
      return cfg.all
    default:
      return cfg.active
  }
})

/** Sort field list for the current tab. */
const currentSortFields = computed(() => {
  switch (currentTab.value) {
    case 'stopped':
      return STOPPED_SORT_FIELDS
    case 'all':
      return ALL_SORT_FIELDS
    default:
      return ACTIVE_SORT_FIELDS
  }
})

const sortPopoverVisible = ref(false)

async function onSortSelect(key: ActiveSortField | StoppedSortField | AllSortField) {
  sortPopoverVisible.value = false
  await taskStore.changeCurrentSort(key)
}
const message = useAppMessage()
const dialog = useDialog()

const refreshing = ref(false)
const stoppingAllSharing = ref(false)
let stopSharingWatcher: WatchStopHandle | null = null
let stopSharingSafetyTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

const stoppingGids = inject<Ref<string[]>>('stoppingGids')
const currentList = computed(() => taskStore.currentList)
const allGids = computed(() => taskStore.taskList.map((t: { gid: string }) => t.gid))
const hasSharingTasks = computed(() => taskStore.taskList.some(checkTaskIsSharing))
const hasActiveTasks = computed(() =>
  taskStore.taskList.some(
    (t: Aria2Task) => (t.status === TASK_STATUS.ACTIVE && !checkTaskIsSharing(t)) || t.status === TASK_STATUS.WAITING,
  ),
)
const hasPausedTasks = computed(() =>
  taskStore.taskList.some((t: { status: string }) => t.status === TASK_STATUS.PAUSED),
)

/** active and all views show Resume/Pause/StopSharing/Delete buttons */
const showActiveActions = computed(() => currentList.value === 'active' || currentList.value === 'all')

/** stopped and all views show Purge Records button */
const showStoppedActions = computed(() => currentList.value === 'stopped' || currentList.value === 'all')

/** GIDs of live (aria2-managed) tasks only — used by Delete All in 'all' view */
const LIVE_STATUSES = new Set([TASK_STATUS.ACTIVE, TASK_STATUS.WAITING, TASK_STATUS.PAUSED])
const TERMINAL_STATUSES = new Set([TASK_STATUS.COMPLETE, TASK_STATUS.ERROR, TASK_STATUS.REMOVED])
const liveGids = computed(() =>
  taskStore.taskList.filter((t: { status: string }) => LIVE_STATUSES.has(t.status)).map((t: { gid: string }) => t.gid),
)
const terminalTasks = computed(() => taskStore.taskList.filter((t: Aria2Task) => TERMINAL_STATUSES.has(t.status)))

const deleteFilesLabel = computed(() =>
  t(
    preferenceStore.config.fileDeletionMode === 'permanent'
      ? 'task.delete-local-files-permanent-label'
      : 'task.delete-local-files-trash-label',
  ),
)

/** Queue clear disabled state: in 'all' view, check live tasks; otherwise check all tasks */
const deleteAllDisabled = computed(() =>
  currentList.value === 'all' ? liveGids.value.length === 0 : allGids.value.length === 0,
)

function showAddTask() {
  appStore.showAddTaskDialog()
}

function onRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshing.value = true
  refreshTimer = setTimeout(() => {
    refreshing.value = false
  }, 500)
  taskStore
    .fetchList()
    .then(() => message.success(t('task.refresh-list-success') || 'List refreshed'))
    .catch((e: unknown) => logger.warn('TaskActions.onRefresh', getErrorMessage(e)))
}

function onDeleteAll() {
  // In 'all' view, clear only live aria2 tasks, not DB-only history items.
  const targetGids = currentList.value === 'all' ? [...liveGids.value] : [...allGids.value]
  if (targetGids.length === 0) return
  const gids = targetGids
  const deleteFiles = ref(false)
  const d = dialog.error({
    title: t('task.delete-task-queue'),
    content: () =>
      h('div', {}, [
        h('p', { style: 'margin: 0 0 12px;' }, t('task.batch-delete-task-confirm', { count: gids.length })),
        h(
          NCheckbox,
          {
            checked: deleteFiles.value,
            'onUpdate:checked': (v: boolean) => {
              deleteFiles.value = v
            },
          },
          { default: () => deleteFilesLabel.value },
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
      // Capture task references BEFORE removal — the store list mutates after
      // batchRemoveTask, so we'd lose the dir/path info needed for file deletion.
      const targetTasks = taskStore.taskList.filter((t) => gids.includes(t.gid))
      const tasksToDelete = deleteFiles.value ? targetTasks : []
      // Remove task records FIRST, then delete files.
      // This matches the safer order used in single-task delete (TaskView.vue).
      // If file deletion fails, tasks are already cleaned up from aria2;
      // the reverse order would leave orphaned tasks with missing files.
      try {
        await taskStore.batchRemoveTask(gids)
      } catch (error) {
        logger.warn('TaskActions.onDeleteAll', getErrorMessage(error))
        message.error(t('task.batch-delete-task-fail'))
        return
      }

      let fileDeletionFailed = false
      for (const task of tasksToDelete) {
        try {
          await deleteTaskFiles(task, preferenceStore.config.fileDeletionMode, taskStore.taskList)
        } catch (error) {
          fileDeletionFailed = true
          logger.warn('TaskActions.onDeleteAllFiles', getErrorMessage(error))
        }
      }
      message[fileDeletionFailed ? 'error' : 'success'](
        t(fileDeletionFailed ? 'task.remove-task-file-fail' : 'task.batch-delete-task-success'),
      )
    },
  })
}

function resumeAll() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  dialog.info({
    title: t('task.resume-all-task'),
    content: t('task.resume-all-task-confirm') || 'Resume all tasks?',
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: () => {
      taskStore
        .resumeAllTask()
        .then((result) => {
          if (result.resumed > 0) message.success(t('task.resume-all-task-success'))
        })
        .catch((e) => {
          logger.warn('TaskActions.resumeAll', getErrorMessage(e))
          message.error(t('task.resume-all-task-fail'))
        })
    },
  })
}

function pauseAll() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  const d = dialog.info({
    title: t('task.pause-all-task'),
    content: t('task.pause-all-task-confirm') || 'Pause all tasks?',
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: () => {
      d.loading = true
      d.negativeButtonProps = { disabled: true }
      d.closable = false
      d.maskClosable = false
      taskStore
        .pauseAllTask()
        .then(async () => {
          // aria2 accepts the pause instantly but processes asynchronously —
          // wait briefly then re-fetch so the task list reflects the real state
          await new Promise((r) => setTimeout(r, 500))
          await taskStore.fetchList()
          message.success(t('task.pause-all-task-success'))
          d.destroy()
        })
        .catch((e) => {
          logger.warn('TaskActions.pauseAll', getErrorMessage(e))
          message.error(t('task.pause-all-task-fail'))
          d.destroy()
        })
      return false
    },
  })
}

function stopAllSharing() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  if (!hasSharingTasks.value) {
    message.info(t('task.stop-all-sharing-none'))
    return
  }
  dialog.info({
    title: t('task.stop-all-sharing'),
    content: t('task.stop-all-sharing-confirm'),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      // 1. Snapshot sharing task gids at click time — only these are tracked
      const targetGids = new Set(taskStore.taskList.filter(checkTaskIsSharing).map((t) => t.gid))

      // 2. Push into shared stoppingGids → triggers card spin animations
      if (stoppingGids) {
        stoppingGids.value = [...stoppingGids.value, ...targetGids]
      }

      // 3. Set toolbar button spinning
      stoppingAllSharing.value = true

      // 4. Fire RPC (don't tie spin to this promise — it resolves instantly)
      taskStore
        .stopAllSharing()
        .then(() => message.success(t('task.stop-all-sharing-success')))
        .catch((e) => {
          logger.warn('TaskActions.stopAllSharing', getErrorMessage(e))
          message.error(t('task.stop-all-sharing-fail'))
        })

      // 5. Watch taskList — spin stops when ALL target gids exit sharing
      cleanupStopSharingWatcher()
      stopSharingWatcher = watch(
        () => taskStore.taskList,
        (list) => {
          const stillSharing = list.some((task) => targetGids.has(task.gid) && checkTaskIsSharing(task))
          if (!stillSharing) {
            stoppingAllSharing.value = false
            cleanupStopSharingWatcher()
          }
        },
        { deep: true },
      )

      // 6. Safety timeout — 10s fallback
      stopSharingSafetyTimer = setTimeout(() => {
        stoppingAllSharing.value = false
        cleanupStopSharingWatcher()
      }, 10_000)
    },
  })
}

function cleanupStopSharingWatcher() {
  if (stopSharingWatcher) {
    stopSharingWatcher()
    stopSharingWatcher = null
  }
  if (stopSharingSafetyTimer) {
    clearTimeout(stopSharingSafetyTimer)
    stopSharingSafetyTimer = null
  }
}

onBeforeUnmount(() => cleanupStopSharingWatcher())

function purgeRecord() {
  const deleteFiles = ref(false)
  const d = dialog.error({
    title: t('task.purge-record'),
    content: () =>
      h('div', {}, [
        h('p', { style: 'margin: 0 0 12px;' }, t('task.purge-record-confirm') || 'Clear all finished records?'),
        h(
          NCheckbox,
          {
            checked: deleteFiles.value,
            'onUpdate:checked': (v: boolean) => {
              deleteFiles.value = v
            },
          },
          { default: () => deleteFilesLabel.value },
        ),
      ]),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      d.loading = true
      d.negativeButtonProps = { disabled: true }
      d.closable = false
      d.maskClosable = false
      await new Promise((r) => setTimeout(r, 50))

      // Capture task refs BEFORE purge — the store list mutates after purgeTaskRecord
      const tasksToClean = deleteFiles.value ? [...terminalTasks.value] : []

      try {
        await taskStore.purgeTaskRecord()
      } catch (error) {
        logger.warn('TaskActions.purgeRecord', getErrorMessage(error))
        message.error(t('task.purge-record-fail'))
        return
      }

      let fileDeletionFailed = false
      for (const task of tasksToClean) {
        try {
          await deleteTaskFiles(task, preferenceStore.config.fileDeletionMode, taskStore.taskList)
        } catch (error) {
          fileDeletionFailed = true
          logger.warn('TaskActions.purgeRecordFiles', getErrorMessage(error))
        }
      }
      message[fileDeletionFailed ? 'error' : 'success'](
        t(fileDeletionFailed ? 'task.remove-task-file-fail' : 'task.purge-record-success'),
      )
    },
  })
}

/** M3 press/release animation for toolbar buttons */
const MIN_PRESS_MS = 200
const pressTimers = new WeakMap<HTMLElement, { start: number; timer: ReturnType<typeof setTimeout> | null }>()

function onBtnPress(ev: PointerEvent) {
  const el = ev.currentTarget as HTMLElement
  const prev = pressTimers.get(el)
  if (prev?.timer) clearTimeout(prev.timer)
  el.classList.add('pressed')
  pressTimers.set(el, { start: Date.now(), timer: null })
}

function onBtnRelease(ev: PointerEvent) {
  const el = ev.currentTarget as HTMLElement
  const state = pressTimers.get(el)
  if (!state) {
    el.classList.remove('pressed')
    return
  }
  const elapsed = Date.now() - state.start
  const remaining = Math.max(0, MIN_PRESS_MS - elapsed)
  state.timer = setTimeout(() => {
    el.classList.remove('pressed')
    pressTimers.delete(el)
  }, remaining)
}
</script>

<template>
  <div class="task-actions">
    <MTooltip>
      <template #trigger>
        <NButton
          type="primary"
          circle
          size="small"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="showAddTask"
        >
          <template #icon>
            <NIcon><AddOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.new-task') || 'New Task' }}
    </MTooltip>
    <NPopover
      v-model:show="sortPopoverVisible"
      trigger="click"
      placement="bottom-start"
      :show-arrow="false"
      raw
      style="padding: 0"
    >
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
        >
          <template #icon>
            <NIcon><SwapVerticalOutline /></NIcon>
          </template>
        </NButton>
      </template>
      <div class="sort-panel">
        <div class="sort-panel-header">{{ t('task.sort-by') }}</div>
        <button
          v-for="field in currentSortFields"
          :key="field"
          class="sort-item"
          :class="{ active: field === currentSort.field }"
          @click="onSortSelect(field)"
        >
          <span class="sort-item-label">{{ t(SORT_LABELS[field]) }}</span>
          <span v-if="field === currentSort.field" class="sort-item-dir">
            <NIcon :size="14">
              <SwapVerticalOutline v-if="field === 'manual'" />
              <ArrowUpOutline v-else-if="currentSort.direction === 'asc'" />
              <ArrowDownOutline v-else />
            </NIcon>
          </span>
        </button>
      </div>
    </NPopover>
    <MTooltip>
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="onRefresh"
        >
          <template #icon>
            <NIcon :class="{ spinning: refreshing }"><RefreshOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.refresh-list') || 'Refresh' }}
    </MTooltip>
    <MTooltip v-if="showActiveActions">
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          :disabled="!hasPausedTasks"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="resumeAll"
        >
          <template #icon>
            <NIcon><PlayOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.resume-all-task') || 'Resume All' }}
    </MTooltip>
    <MTooltip v-if="showActiveActions">
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          :disabled="!hasActiveTasks"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="pauseAll"
        >
          <template #icon>
            <NIcon><PauseOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.pause-all-task') || 'Pause All' }}
    </MTooltip>
    <MTooltip v-if="showActiveActions">
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          :disabled="!hasSharingTasks || stoppingAllSharing"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="stopAllSharing"
        >
          <template #icon>
            <NIcon :class="{ 'stop-all-spinning': stoppingAllSharing }">
              <SyncOutline v-if="stoppingAllSharing" />
              <StopCircleOutline v-else />
            </NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.stop-all-sharing') }}
    </MTooltip>
    <MTooltip v-if="showActiveActions">
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          :disabled="deleteAllDisabled"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="onDeleteAll"
        >
          <template #icon>
            <NIcon><CloseOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.delete-all-task') }}
    </MTooltip>
    <MTooltip v-if="showStoppedActions">
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          @pointerdown="onBtnPress"
          @pointerup="onBtnRelease"
          @pointerleave="onBtnRelease"
          @click="purgeRecord"
        >
          <template #icon>
            <NIcon><TrashOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.purge-record') || 'Purge Records' }}
    </MTooltip>
  </div>
</template>

<style scoped>
.task-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}
.task-actions :deep(.n-button) {
  transition:
    transform 0.25s cubic-bezier(0.05, 0.7, 0.1, 1),
    opacity 0.3s ease;
  transform-origin: center;
}
.task-actions :deep(.n-button.pressed) {
  transform: scale(0.85);
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.spinning {
  animation: spin 0.6s cubic-bezier(0.2, 0, 0, 1);
  display: inline-block;
  transform-origin: center;
}
.stop-all-spinning {
  animation: spin 0.9s linear infinite;
  display: inline-block;
  transform-origin: center;
  will-change: transform;
  contain: layout style paint;
}
</style>

<!-- Sort panel renders in teleported popover — must be unscoped -->
<style>
.sort-panel {
  min-width: 160px;
  padding: 6px;
  background: var(--m3-surface-container-highest);
  border: 1px solid var(--m3-outline-variant);
  border-radius: 12px;
  box-shadow: 0 4px 16px var(--m3-shadow);
}

.sort-panel-header {
  padding: 6px 10px 4px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.02em;
}

.sort-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--m3-on-surface);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s cubic-bezier(0.2, 0, 0, 1),
    color 0.15s cubic-bezier(0.2, 0, 0, 1);
}

.sort-item:hover {
  background: var(--m3-surface-container-highest);
}

.sort-item:active {
  background: var(--m3-outline-variant);
  transition: background-color 0.05s ease;
}

.sort-item.active {
  background: color-mix(in srgb, var(--m3-primary) 10%, transparent);
  color: var(--m3-on-surface);
  font-weight: 500;
}

.sort-item.active:hover {
  background: color-mix(in srgb, var(--m3-primary) 14%, transparent);
  color: var(--m3-on-surface);
}

.sort-item-label {
  flex: 1;
}

.sort-item-dir {
  display: flex;
  align-items: center;
  margin-left: 8px;
  color: var(--m3-on-surface);
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}
</style>
