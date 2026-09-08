<script setup lang="ts">
/** @fileoverview Native-backed task toolbar actions and confirmations. */
import { ref, computed, h, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'

import { isEngineReady } from '@/api/aria2'
import { TASK_STATUS } from '@shared/constants'
import type { Aria2Task } from '@shared/types'
import type { I18nKey } from '@shared/i18nTypes'
import { getTaskSharingState } from '@shared/utils/task'
import { deleteTaskFiles } from '@/composables/useFileDelete'

import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { NButton, NIcon, NCheckbox, NPopover, useDialog } from 'naive-ui'
import MTooltip from '@/components/common/MTooltip.vue'
import { useAppMessage } from '@/composables/useAppMessage'
import { usePreferenceStore } from '@/stores/preference'
import {
  PROGRESS_SORT_FIELDS,
  TERMINAL_SORT_FIELDS,
  ALL_SORT_FIELDS,
  DEFAULT_TASK_SORT,
  type ProgressSortField,
  type TerminalSortField,
  type AllSortField,
} from '@/composables/useTaskSort'
import {
  AddOutline,
  PlayOutline,
  PauseOutline,
  StopCircleOutline,
  TrashOutline,
  RefreshOutline,
  CloseOutline,
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
const SORT_LABELS: Record<ProgressSortField | TerminalSortField | AllSortField, I18nKey> = {
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
    case 'failed':
    case 'completed':
      return cfg[currentTab.value]
    case 'all':
      return cfg.all
    default:
      return cfg.progress
  }
})

/** Sort field list for the current tab. */
const currentSortFields = computed(() => {
  switch (currentTab.value) {
    case 'failed':
    case 'completed':
      return TERMINAL_SORT_FIELDS
    case 'all':
      return ALL_SORT_FIELDS
    default:
      return PROGRESS_SORT_FIELDS
  }
})

const sortPopoverVisible = ref(false)

async function onSortSelect(key: ProgressSortField | TerminalSortField | AllSortField) {
  sortPopoverVisible.value = false
  await taskStore.changeCurrentSort(key)
}
const message = useAppMessage()
const dialog = useDialog()

const refreshing = ref(false)

async function lockDialog(d: ReturnType<typeof dialog.info>) {
  d.loading = true
  d.negativeButtonProps = { disabled: true }
  d.closable = false
  d.maskClosable = false
  await nextTick()
}

const currentList = computed(() => taskStore.currentList)
const allGids = computed(() => taskStore.taskList.map((t: { gid: string }) => t.gid))
const hasActiveTasks = computed(() =>
  taskStore.taskList.some((t: Aria2Task) => t.status === TASK_STATUS.ACTIVE || t.status === TASK_STATUS.WAITING),
)
const hasPausedTasks = computed(() =>
  taskStore.taskList.some((t: { status: string }) => t.status === TASK_STATUS.PAUSED),
)
const sharingGids = computed(() =>
  taskStore.taskList.filter((task) => getTaskSharingState(task) !== null).map((task) => task.gid),
)

/** Active and all views show resume, pause, and delete actions. */
const showActiveActions = computed(() => currentList.value === 'progress' || currentList.value === 'all')

/** Terminal and All scopes expose history purge. */
const showStoppedActions = computed(
  () => currentList.value === 'failed' || currentList.value === 'completed' || currentList.value === 'all',
)

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

async function onRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await taskStore.fetchList()
    message.success(t('task.refresh-list-success') || 'List refreshed')
  } catch (error) {
    logger.warn('TaskActions.onRefresh', getErrorMessage(error))
  } finally {
    refreshing.value = false
  }
}

function onDeleteAll() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
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
      await lockDialog(d)
      // Capture task references BEFORE removal — the store list mutates after
      // batchRemoveTask, so we'd lose the dir/path info needed for file deletion.
      const targetTasks = taskStore.taskList.filter((t) => gids.includes(t.gid))
      const tasksToDelete = deleteFiles.value ? targetTasks : []
      // Remove task records FIRST, then delete files.
      // This matches the safer order used in single-task delete (TaskView.vue).
      // If file deletion fails, tasks are already cleaned up from aria2;
      // the reverse order would leave orphaned tasks with missing files.
      try {
        const result = await taskStore.batchRemoveTask(gids)
        const succeeded = new Set(result.succeeded)
        const deletedTasks = tasksToDelete.filter((task) => succeeded.has(task.gid))

        let fileDeletionFailed = false
        for (const task of deletedTasks) {
          try {
            await deleteTaskFiles(task, preferenceStore.config.fileDeletionMode)
          } catch (error) {
            fileDeletionFailed = true
            logger.warn('TaskActions.onDeleteAllFiles', getErrorMessage(error))
          }
        }

        if (result.failed.length > 0) {
          const key = result.succeeded.length > 0 ? 'task.batch-delete-task-partial' : 'task.batch-delete-task-fail'
          message[result.succeeded.length > 0 ? 'warning' : 'error'](
            t(key, { removed: result.succeeded.length, failed: result.failed.length }),
          )
        } else if (!fileDeletionFailed) {
          message.success(t('task.batch-delete-task-success'))
        }
        if (fileDeletionFailed) message.error(t('task.remove-task-file-fail'))
      } catch (error) {
        logger.warn('TaskActions.onDeleteAll', getErrorMessage(error))
        message.error(t('task.batch-delete-task-fail'))
      } finally {
        d.destroy()
      }
      return false
    },
  })
}

function resumeAll() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  const d = dialog.info({
    title: t('task.resume-all-task'),
    content: t('task.resume-all-task-confirm') || 'Resume all tasks?',
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      await lockDialog(d)
      try {
        const result = await taskStore.resumeAllTask()
        if (result.resumed > 0) message.success(t('task.resume-all-task-success'))
      } catch (error) {
        logger.warn('TaskActions.resumeAll', getErrorMessage(error))
        message.error(t('task.resume-all-task-fail'))
      } finally {
        d.destroy()
      }
      return false
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
    onPositiveClick: async () => {
      await lockDialog(d)
      try {
        await taskStore.pauseAllTask()
        message.success(t('task.pause-all-task-success'))
      } catch (error) {
        logger.warn('TaskActions.pauseAll', getErrorMessage(error))
        message.error(t('task.pause-all-task-fail'))
      } finally {
        d.destroy()
      }
      return false
    },
  })
}

function finishAllSharing() {
  if (!isEngineReady()) {
    message.warning(t('app.engine-not-ready'))
    return
  }
  const gids = [...sharingGids.value]
  if (gids.length === 0) return
  const d = dialog.warning({
    title: t('task.finish-all-sharing'),
    content: t('task.finish-all-sharing-confirm', { count: gids.length }),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      await lockDialog(d)
      try {
        const result = await taskStore.finishSharingTasks(gids)
        if (result.failed.length === 0) {
          message.success(t('task.finish-all-sharing-success', { count: result.succeeded.length }))
        } else if (result.succeeded.length > 0) {
          message.warning(
            t('task.finish-all-sharing-partial', {
              finished: result.succeeded.length,
              failed: result.failed.length,
            }),
          )
        } else {
          message.error(t('task.finish-all-sharing-fail'))
        }
      } catch (error) {
        logger.warn('TaskActions.finishAllSharing', getErrorMessage(error))
        message.error(t('task.finish-all-sharing-fail'))
      } finally {
        d.destroy()
      }
      return false
    },
  })
}

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
      await lockDialog(d)

      // Capture task refs BEFORE purge — the store list mutates after purgeTaskRecord
      const tasksToClean = deleteFiles.value ? [...terminalTasks.value] : []

      try {
        await taskStore.purgeTaskRecord()
      } catch (error) {
        logger.warn('TaskActions.purgeRecord', getErrorMessage(error))
        message.error(t('task.purge-record-fail'))
        d.destroy()
        return false
      }

      let fileDeletionFailed = false
      for (const task of tasksToClean) {
        try {
          await deleteTaskFiles(task, preferenceStore.config.fileDeletionMode)
        } catch (error) {
          fileDeletionFailed = true
          logger.warn('TaskActions.purgeRecordFiles', getErrorMessage(error))
        }
      }
      message[fileDeletionFailed ? 'error' : 'success'](
        t(fileDeletionFailed ? 'task.remove-task-file-fail' : 'task.purge-record-success'),
      )
      d.destroy()
      return false
    },
  })
}
</script>

<template>
  <div class="task-actions">
    <MTooltip>
      <template #trigger>
        <NButton type="primary" circle size="small" :aria-label="t('task.new-task')" @click="showAddTask">
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
        <NButton quaternary circle size="small" :aria-label="t('task.sort-by')">
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
          :aria-label="t('task.refresh-list')"
          :loading="refreshing"
          :disabled="refreshing"
          @click="onRefresh"
        >
          <template #icon>
            <NIcon><RefreshOutline /></NIcon>
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
          :aria-label="t('task.resume-all-task')"
          :disabled="!hasPausedTasks"
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
          :aria-label="t('task.pause-all-task')"
          :disabled="!hasActiveTasks"
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
          :aria-label="t('task.finish-all-sharing')"
          :disabled="sharingGids.length === 0"
          @click="finishAllSharing"
        >
          <template #icon>
            <NIcon><StopCircleOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.finish-all-sharing') }}
    </MTooltip>
    <MTooltip v-if="showActiveActions">
      <template #trigger>
        <NButton
          quaternary
          circle
          size="small"
          :aria-label="t('task.delete-all-task')"
          :disabled="deleteAllDisabled"
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
          :aria-label="t('task.purge-record')"
          :disabled="terminalTasks.length === 0"
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
