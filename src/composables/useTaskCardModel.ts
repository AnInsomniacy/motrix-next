/** @fileoverview Shared task-card display model for full and compact task rows. */
import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import {
  bytesToSize,
  calcProgress,
  checkTaskIsSharing,
  getTaskCompletedLength,
  getTaskDisplayName,
  getTaskSharingKind,
  isBtMetadataTask,
  timeFormat,
  timeRemaining,
} from '@shared/utils'
import { buildTaskTransferSummary } from '@/composables/useTaskDetailSummary'
import { useTaskElapsed } from '@/composables/useTaskElapsed'
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
  elapsedText: ComputedRef<string>
  transferSummary: ComputedRef<ReturnType<typeof buildTaskTransferSummary>>
}

export function useTaskCardModel(task: ComputedRef<Aria2Task>): TaskCardModel {
  const { t } = useI18n()

  const taskFullName = computed(() =>
    getTaskDisplayName(task.value, { defaultName: t('task.get-task-name') || 'Unknown' }),
  )
  const sharingKind = computed(() => getTaskSharingKind(task.value))
  const isSharing = computed(() => checkTaskIsSharing(task.value))
  const sharingLabel = computed(() => {
    if (sharingKind.value === 'bt') return t('task.seeding') || 'Seeding'
    if (sharingKind.value === 'ed2k') return t('task.sharing') || 'Sharing'
    return ''
  })
  const isMetadataFetching = computed(() => isBtMetadataTask(task.value))
  const taskStatus = computed(() => (isSharing.value ? TASK_STATUS.SHARING : task.value.status))
  const statusBadge = computed<TaskCardStatusBadge | null>(() => {
    if (isSharing.value) return { key: 'sharing', label: sharingLabel.value, tone: 'success' }
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
  const completedLengthValue = computed(() => getTaskCompletedLength(task.value))
  const percent = computed(() => calcProgress(task.value.totalLength, completedLengthValue.value))
  const completedSize = computed(() => bytesToSize(completedLengthValue.value, 2))
  const totalSize = computed(() => bytesToSize(task.value.totalLength, 2))
  const hasSizeInfo = computed(() => completedLengthValue.value > 0 || Number(task.value.totalLength) > 0)
  const downloadSpeed = computed(() => bytesToSize(task.value.downloadSpeed))
  const uploadSpeed = computed(() => bytesToSize(task.value.uploadSpeed))
  const transferSummary = computed(() => buildTaskTransferSummary(task.value))
  const { elapsedText } = useTaskElapsed(task, t)
  const remaining = computed(() => {
    if (!isActive.value) return 0
    return timeRemaining(Number(task.value.totalLength), completedLengthValue.value, Number(task.value.downloadSpeed))
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
    elapsedText,
    transferSummary,
  }
}
