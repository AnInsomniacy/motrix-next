/**
 * @fileoverview Composable for Advanced preference page actions.
 *
 * Extracted from Advanced.vue to reduce component script size.
 * Contains dialog-heavy operations: session reset, restore defaults,
 * factory reset, DB integrity check, DB browse, DB reset, export logs,
 * and manual engine restart.
 */
import { ref, h, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { downloadDir, appDataDir } from '@tauri-apps/api/path'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { exists } from '@tauri-apps/plugin-fs'
import { NTag, useDialog, type DataTableColumns } from 'naive-ui'
import { logger } from '@shared/logger'
import { bytesToSize } from '@shared/utils/format'
import { useIpc } from '@/composables/useIpc'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { ENGINE_RPC_PORT } from '@shared/constants'
import type { HistoryRecord } from '@shared/types'

interface AdvancedActionsDeps {
  t: (key: string, params?: Record<string, unknown>) => string
  message: {
    success: (msg: string) => void
    error: (msg: string) => void
    warning: (msg: string) => void
    info: (msg: string, opts?: Record<string, unknown>) => void
  }
  taskStore: {
    batchRemoveTask: (gids: string[]) => Promise<unknown>
    purgeTaskRecord: () => Promise<unknown>
  }
  historyStore: {
    checkIntegrity: () => Promise<string>
    getRecords: () => Promise<HistoryRecord[]>
    clearRecords: () => Promise<void>
  }
  preferenceStore: {
    resetToDefaults: () => Promise<boolean>
  }
  form: { value: Record<string, unknown> }
  buildForm: () => Record<string, unknown>
  resetSnapshot: () => void
}

const STATUS_I18N_MAP: Record<string, string> = {
  complete: 'task.task-complete',
  error: 'task.task-error',
  removed: 'task.task-removed',
}

export function useAdvancedActions(deps: AdvancedActionsDeps) {
  const { t, message, taskStore, historyStore, preferenceStore, form, buildForm, resetSnapshot } = deps

  const dialog = useDialog()
  const { restartEngine } = useEngineRestart()

  // ── DB Browse state ──────────────────────────────────────────────────
  const showDbBrowse = ref(false)
  const dbRecords = ref<HistoryRecord[]>([])
  const dbRecordsLoading = ref(false)

  const dbBrowseColumns = computed<DataTableColumns<HistoryRecord>>(() => [
    { title: t('task.task-name'), key: 'name', ellipsis: { tooltip: true }, minWidth: 200 },
    {
      title: t('task.task-status'),
      key: 'status',
      width: 100,
      render: (row) =>
        h(
          NTag,
          { type: row.status === 'complete' ? 'success' : row.status === 'error' ? 'error' : 'warning', size: 'small' },
          () => t(STATUS_I18N_MAP[row.status] ?? 'task.task-removed'),
        ),
    },
    {
      title: t('task.task-file-size'),
      key: 'total_length',
      width: 100,
      render: (row) => (row.total_length ? bytesToSize(row.total_length) : '—'),
    },
    { title: t('task.task-type'), key: 'task_type', width: 90 },
    {
      title: t('task.task-completed-at'),
      key: 'completed_at',
      width: 170,
      render: (row) => (row.completed_at ? new Date(row.completed_at).toLocaleString() : '—'),
    },
  ])

  // ── Export logs state ────────────────────────────────────────────────
  const exportingLogs = ref(false)

  // ── Handlers ─────────────────────────────────────────────────────────

  function handleManualRestart(rpcListenPort: number, rpcSecret: string) {
    const port = rpcListenPort || ENGINE_RPC_PORT
    const secret = rpcSecret || ''
    const d = dialog.warning({
      title: t('preferences.engine-restart-title'),
      content: t('preferences.engine-restart-manual-confirm'),
      positiveText: t('preferences.engine-restart-now'),
      negativeText: t('preferences.engine-restart-later'),
      maskClosable: false,
      onPositiveClick: async () => {
        d.loading = true
        d.negativeText = ''
        d.closable = false
        message.info(t('preferences.engine-restarting'), { duration: 2000 })
        await new Promise((r) => requestAnimationFrame(r))
        await restartEngine({ port, secret })
      },
    })
  }

  function handleSessionReset() {
    dialog.warning({
      title: t('preferences.clear-all-tasks'),
      content: t('preferences.clear-all-tasks-confirm'),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        try {
          const { fetchTaskList } = await import('@/api/aria2')
          const [activeTasks, stoppedTasks] = await Promise.all([
            fetchTaskList({ type: 'active' }),
            fetchTaskList({ type: 'stopped' }),
          ])
          const allGids = [...activeTasks, ...stoppedTasks].map((t) => t.gid)
          if (allGids.length > 0) {
            await taskStore.batchRemoveTask(allGids)
          }
          await taskStore.purgeTaskRecord()
          await invoke('clear_session_file')
          message.success(t('preferences.clear-all-tasks-success'))
        } catch (e) {
          logger.error('Advanced.sessionReset', e)
        }
      },
    })
  }

  function handleRestoreDefaults() {
    dialog.warning({
      title: t('preferences.restore-defaults'),
      content: t('preferences.restore-defaults-confirm'),
      positiveText: t('preferences.restore-defaults'),
      negativeText: t('app.cancel'),
      onPositiveClick: async () => {
        const ok = await preferenceStore.resetToDefaults()
        if (ok) {
          Object.assign(form.value, buildForm())
          resetSnapshot()
          message.success(t('preferences.restore-defaults-success'))
          dialog.info({
            title: t('preferences.restore-defaults'),
            content: t('preferences.restart-required'),
            positiveText: t('preferences.restart-now'),
            negativeText: t('app.cancel'),
            onPositiveClick: async () => {
              const { stopEngine } = useIpc()
              await stopEngine()
              relaunch()
            },
          })
        }
      },
    })
  }

  function handleFactoryReset() {
    dialog.error({
      title: t('preferences.factory-reset'),
      content: t('preferences.factory-reset-confirm'),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        try {
          await invoke('factory_reset')
          const { stopEngine } = useIpc()
          await stopEngine()
          relaunch()
        } catch (e) {
          logger.error('Advanced.factoryReset', e)
        }
      },
    })
  }

  async function handleDbIntegrityCheck() {
    message.info(t('preferences.db-integrity-check-running'))
    try {
      const result = await historyStore.checkIntegrity()
      if (result === 'ok') {
        message.success(t('preferences.db-integrity-check-ok'))
      } else {
        message.warning(`${t('preferences.db-integrity-check-fail')}: ${result}`)
      }
    } catch (e) {
      message.error(`${t('preferences.db-integrity-check-fail')}: ${(e as Error).message}`)
      logger.error('Advanced.dbIntegrityCheck', e)
    }
  }

  async function handleDbBrowse() {
    showDbBrowse.value = true
    dbRecordsLoading.value = true
    try {
      dbRecords.value = await historyStore.getRecords()
    } catch (e) {
      logger.error('Advanced.dbBrowse', e)
      message.error((e as Error).message)
    } finally {
      dbRecordsLoading.value = false
    }
  }

  function handleDbReset() {
    dialog.error({
      title: t('preferences.db-reset'),
      content: t('preferences.db-reset-confirm'),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        try {
          await historyStore.clearRecords()
          message.success(t('preferences.db-reset-success'))
        } catch (e) {
          message.error(`${t('preferences.db-reset')}: ${(e as Error).message}`)
          logger.error('Advanced.dbReset', e)
        }
      },
    })
  }

  async function handleExportLogs() {
    try {
      const defaultDir = await downloadDir()
      const savePath = await saveDialog({
        title: t('preferences.export-diagnostic-logs'),
        defaultPath: `${defaultDir}/motrix-next-logs.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (!savePath) return

      const MIN_LOADING_MS = 400
      const start = Date.now()
      exportingLogs.value = true
      const zipPath = await invoke<string>('export_diagnostic_logs', { savePath })

      // Guarantee minimum loading duration so NButton's spinner-to-icon
      // transition completes cleanly without visual stacking.
      const remaining = MIN_LOADING_MS - (Date.now() - start)
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))

      message.success(t('preferences.export-diagnostic-logs-success', { path: zipPath }))
    } catch (e) {
      logger.error('Advanced.exportLogs', e)
      message.error(t('preferences.export-diagnostic-logs-failed'))
    } finally {
      exportingLogs.value = false
    }
  }

  function handleClearLog() {
    dialog.warning({
      title: t('preferences.clear-log'),
      content: t('preferences.clear-log-confirm'),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        try {
          await invoke('clear_log_file')
          message.success(t('preferences.clear-log-success'))
        } catch (e) {
          logger.error('Advanced.clearLog', e)
          message.error(t('preferences.clear-log-failed'))
        }
      },
    })
  }

  async function handleRevealPath(filePath: string) {
    if (!filePath) return
    try {
      const fileExists = await exists(filePath)
      if (!fileExists) {
        message.warning(t('task.file-not-exist'))
        return
      }
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      await revealItemInDir(filePath)
      message.success(t('task.open-folder-success'))
    } catch (e) {
      logger.warn('Advanced.revealPath', String(e))
      message.warning(t('task.file-not-exist'))
    }
  }

  async function handleOpenConfigFolder() {
    try {
      const dir = await appDataDir()
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(dir)
      message.success(t('task.open-folder-success'))
    } catch (e) {
      logger.error('Advanced.openConfigFolder', e)
      message.error(String(e))
    }
  }

  return {
    // State
    showDbBrowse,
    dbRecords,
    dbRecordsLoading,
    dbBrowseColumns,
    exportingLogs,
    // Handlers
    handleManualRestart,
    handleSessionReset,
    handleRestoreDefaults,
    handleFactoryReset,
    handleDbIntegrityCheck,
    handleDbBrowse,
    handleDbReset,
    handleExportLogs,
    handleClearLog,
    handleRevealPath,
    handleOpenConfigFolder,
  }
}
