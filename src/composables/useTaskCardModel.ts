/** @fileoverview Shared task-card display model for full and compact task rows. */
import { computed, ref, watch, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import {
  bytesToSize,
  calcProgress,
  checkTaskIsSharing,
  getTaskCompletedLength,
  getTaskDisplayName,
  getSharingStatusLabelKey,
  getTaskSharingState,
  isBtMetadataTask,
  timeFormat,
  timeRemaining,
} from '@shared/utils'
import { buildTaskTransferSummary } from '@/composables/useTaskDetailSummary'
import { getBtLifecycleState } from '@/composables/useBtLifecycle'
import type { Aria2Task } from '@shared/types'

export interface TaskCardStatusBadge {
  key: string
  label: string
  tone: 'success' | 'error' | 'muted' | 'waiting'
}

interface TaskCardModel {
  taskFullName: ComputedRef<string>
  sharingKind: ComputedRef<'bt' | 'ed2k' | null>
  isSharing: ComputedRef<boolean>
  sharingLabel: ComputedRef<string>
  isMetadataFetching: ComputedRef<boolean>
  statusBadge: ComputedRef<TaskCardStatusBadge | null>
  taskStatus: ComputedRef<string>
  isActive: ComputedRef<boolean>
  completedLengthValue: ComputedRef<number>
  percent: ComputedRef<number>
  completedSize: ComputedRef<string>
  totalSize: ComputedRef<string>
  hasSizeInfo: ComputedRef<boolean>
  downloadSpeed: ComputedRef<string>
  uploadSpeed: ComputedRef<string>
  remaining: ComputedRef<number>
  remainingText: ComputedRef<string>
  transferSummary: ComputedRef<ReturnType<typeof buildTaskTransferSummary>>
}

export function useTaskCardModel(task: ComputedRef<Aria2Task>): TaskCardModel {
  const { t } = useI18n()

  const taskFullName = computed(() =>
    getTaskDisplayName(task.value, { defaultName: t('task.get-task-name') || 'Unknown' }),
  )
  const btLifecycle = computed(() => getBtLifecycleState(task.value))
  const stableProgress = ref({
    gid: task.value.gid,
    total: Number(task.value.totalLength) || 0,
    completed: getTaskCompletedLength(task.value),
  })
  watch(
    () => [task.value.gid, task.value.totalLength, task.value.completedLength, btLifecycle.value] as const,
    ([gid, totalLength, _completedLength, lifecycle]) => {
      const total = Number(totalLength) || 0
      const completed = getTaskCompletedLength(task.value)
      if (gid !== stableProgress.value.gid) {
        stableProgress.value = { gid, total, completed }
        return
      }
      if ((lifecycle === 'checking' || lifecycle === 'recovering') && stableProgress.value.total > 0) return
      stableProgress.value = { gid, total, completed }
    },
    { immediate: true },
  )
  const sharingState = computed(() => getTaskSharingState(task.value))
  const sharingKind = computed(() => sharingState.value?.kind ?? null)
  const isSharing = computed(() => checkTaskIsSharing(task.value))
  const sharingLabel = computed(() => (sharingState.value ? t(getSharingStatusLabelKey(sharingState.value)) : ''))
  const isMetadataFetching = computed(() => isBtMetadataTask(task.value))
  const taskStatus = computed(() => (isSharing.value ? TASK_STATUS.SHARING : task.value.status))
  const statusBadge = computed<TaskCardStatusBadge | null>(() => {
    if (btLifecycle.value === 'selection') {
      return {
        key: 'bt-file-selection',
        label: t('task.awaiting-file-selection'),
        tone: 'waiting',
      }
    }
    if (btLifecycle.value === 'recovering') {
      return {
        key: 'bt-recovering',
        label: t('task.bt-recovering'),
        tone: 'waiting',
      }
    }
    if (btLifecycle.value === 'error') {
      return {
        key: 'bt-error',
        label: t('task.task-error'),
        tone: 'error',
      }
    }
    if (sharingState.value?.phase === 'paused') {
      return {
        key: 'sharing-paused',
        label: sharingLabel.value,
        tone: 'muted',
      }
    }
    if (isSharing.value) {
      return {
        key: 'sharing',
        label: sharingLabel.value,
        tone: 'success',
      }
    }
    if (isMetadataFetching.value)
      return {
        key: 'bt-metadata-fetching',
        label: t('task.bt-metadata-fetching') || 'Fetching torrent',
        tone: 'waiting',
      }

    switch (task.value.status) {
      case TASK_STATUS.WAITING:
        return { key: TASK_STATUS.WAITING, label: t('task.status-waiting') || 'Queued', tone: 'waiting' }
      case TASK_STATUS.COMPLETE:
        return { key: TASK_STATUS.COMPLETE, label: t('task.task-complete') || 'Completed', tone: 'success' }
      case TASK_STATUS.ERROR:
        return { key: TASK_STATUS.ERROR, label: t('task.task-error') || 'Error', tone: 'error' }
      case TASK_STATUS.REMOVED:
        return { key: TASK_STATUS.REMOVED, label: t('task.task-removed') || 'Removed', tone: 'muted' }
      default:
        return null
    }
  })
  const isActive = computed(() => task.value.status === TASK_STATUS.ACTIVE)
  const displayedTotalLength = computed(() => stableProgress.value.total)
  const completedLengthValue = computed(() => stableProgress.value.completed)
  const percent = computed(() => calcProgress(displayedTotalLength.value, completedLengthValue.value))
  const completedSize = computed(() => bytesToSize(completedLengthValue.value, 2))
  const totalSize = computed(() => bytesToSize(displayedTotalLength.value, 2))
  const hasSizeInfo = computed(() => completedLengthValue.value > 0 || displayedTotalLength.value > 0)
  const downloadSpeed = computed(() => bytesToSize(task.value.downloadSpeed))
  const uploadSpeed = computed(() => bytesToSize(task.value.uploadSpeed))
  const transferSummary = computed(() => buildTaskTransferSummary(task.value))
  const remaining = computed(() => {
    if (!isActive.value) return 0
    return timeRemaining(displayedTotalLength.value, completedLengthValue.value, Number(task.value.downloadSpeed))
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

  return {
    taskFullName,
    sharingKind,
    isSharing,
    sharingLabel,
    isMetadataFetching,
    statusBadge,
    taskStatus,
    isActive,
    completedLengthValue,
    percent,
    completedSize,
    totalSize,
    hasSizeInfo,
    downloadSpeed,
    uploadSpeed,
    remaining,
    remainingText,
    transferSummary,
  }
}
