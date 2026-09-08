/**
 * @fileoverview Composable for Advanced preference page actions.
 *
 * Extracted from Advanced.vue to reduce component script size.
 * Contains dialog-heavy operations: session reset, restore defaults,
 * factory reset, DB integrity check, DB browse, DB reset, export logs,
 * and diagnostics utilities.
 */
import { ref, h, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { appDataDir, join } from '@tauri-apps/api/path'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { NTag, useDialog, type DataTableColumns } from 'naive-ui'
import { logger } from '@shared/logger'
import { bytesToSize } from '@shared/utils/format'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { resolveUserVisibleDownloadDir } from '@shared/utils/userVisibleDirectory'
import { buildSettingsBackup, parseSettingsBackup } from '@shared/utils/settingsBackup'
import { buildSystemConfigFromAppConfig } from '@shared/utils/systemConfig'
import { useEngineStore } from '@/stores/engine'
import { useDatabaseReset } from '@/composables/useDatabaseReset'
import type { AppConfig, HistoryRecord } from '@shared/types'
import type { DataTableSortState, PaginationProps } from 'naive-ui'
import type { I18nKey } from '@shared/i18nTypes'

interface AdvancedActionsDeps {
  t: (key: string, params?: Record<string, unknown>) => string
  message: {
    success: (msg: string) => void
    error: (msg: string) => void
    warning: (msg: string) => void
    info: (msg: string, opts?: Record<string, unknown>) => void
  }
  historyStore: {
    checkIntegrity: () => Promise<string>
    getRecordsPage: (input: {
      page: number
      pageSize: number
      sortField?: string
      sortOrder?: 'ascend' | 'descend' | false
    }) => Promise<{ records: HistoryRecord[]; total: number }>
  }
  preferenceStore: {
    config: AppConfig
    replaceAndSave: (nextConfig: Partial<AppConfig>) => Promise<boolean>
    resetToDefaults: () => Promise<boolean>
  }
  form: { value: Record<string, unknown> }
  buildForm: () => Record<string, unknown>
  resetSnapshot: () => void
}

const STATUS_I18N_MAP: Record<string, I18nKey> = {
  complete: 'task.task-complete',
  error: 'task.task-error',
  removed: 'task.task-removed',
}

export function useAdvancedActions(deps: AdvancedActionsDeps) {
  const { t, message, historyStore, preferenceStore, form, buildForm, resetSnapshot } = deps

  const dialog = useDialog()
  const engineStore = useEngineStore()
  const { showDatabaseReset } = useDatabaseReset()

  // ── DB Browse state ──────────────────────────────────────────────────
  const showDbBrowse = ref(false)
  const dbRecords = ref<HistoryRecord[]>([])
  const dbRecordsLoading = ref(false)
  const dbRecordsPage = ref(1)
  const dbRecordsPageSize = ref(50)
  const dbRecordsTotal = ref(0)
  const dbRecordsSortField = ref<string | undefined>(undefined)
  const dbRecordsSortOrder = ref<'ascend' | 'descend' | false>(false)

  const dbBrowseColumns = computed<DataTableColumns<HistoryRecord>>(() => {
    const data = dbRecords.value
    return [
      { title: t('task.task-name'), key: 'name', ellipsis: { tooltip: true }, minWidth: 200 },
      {
        title: t('task.task-status'),
        key: 'status',
        width: calcColumnWidth({
          title: t('task.task-status'),
          values: Object.values(STATUS_I18N_MAP).map((k) => t(k)),
          sortable: true,
          extraWidth: 20,
        }),
        sorter: true,
        render: (row) =>
          h(
            NTag,
            {
              type: row.status === 'complete' ? 'success' : row.status === 'error' ? 'error' : 'warning',
              size: 'small',
            },
            () => t(STATUS_I18N_MAP[row.status] ?? 'task.task-removed'),
          ),
      },
      {
        title: t('task.task-file-size'),
        key: 'total_length',
        width: calcColumnWidth({
          title: t('task.task-file-size'),
          values: data.slice(0, 50).map((r) => (r.total_length ? bytesToSize(r.total_length) : '—')),
          sortable: true,
        }),
        sorter: true,
        render: (row) => (row.total_length ? bytesToSize(row.total_length) : '—'),
      },
      {
        title: t('task.task-type'),
        key: 'task_type',
        width: calcColumnWidth({
          title: t('task.task-type'),
          values: data.slice(0, 50).map((r) => r.task_type ?? ''),
          sortable: true,
        }),
        sorter: true,
      },
      {
        title: t('task.task-completed-at'),
        key: 'completed_at',
        width: calcColumnWidth({
          title: t('task.task-completed-at'),
          values: data.slice(0, 50).map((r) => (r.completed_at ? new Date(r.completed_at).toLocaleString() : '—')),
          sortable: true,
        }),
        sorter: true,
        render: (row) => (row.completed_at ? new Date(row.completed_at).toLocaleString() : '—'),
      },
    ]
  })

  const dbBrowsePagination = computed<PaginationProps>(() => ({
    page: dbRecordsPage.value,
    pageSize: dbRecordsPageSize.value,
    itemCount: dbRecordsTotal.value,
    showSizePicker: true,
    pageSizes: [20, 50, 100],
    prefix: () => t('preferences.db-record-count', { count: dbRecordsTotal.value }),
    onUpdatePage: (page) => {
      dbRecordsPage.value = page
      void loadDbRecords()
    },
    onUpdatePageSize: (pageSize) => {
      dbRecordsPageSize.value = pageSize
      dbRecordsPage.value = 1
      void loadDbRecords()
    },
  }))

  // ── Export logs state ────────────────────────────────────────────────
  const exportingLogs = ref(false)
  const exportingSettings = ref(false)
  const importingSettings = ref(false)

  // ── Handlers ─────────────────────────────────────────────────────────

  function handleEngineStateReset() {
    dialog.error({
      title: t('preferences.reset-engine-state'),
      content: t('preferences.reset-engine-state-confirm'),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        try {
          await engineStore.recoverRuntimeState()
          message.success(t('preferences.reset-engine-state-success'))
        } catch (e) {
          logger.error('Advanced.engineStateReset', e)
        }
      },
    })
  }

  function handleRestoreDefaults() {
    dialog.error({
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
              await engineStore.stop('appRelaunch')
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
          await engineStore.stop('appRelaunch')
          await invoke('factory_reset')
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
    dbRecordsPage.value = 1
    await loadDbRecords()
  }

  async function loadDbRecords() {
    dbRecordsLoading.value = true
    try {
      const page = await historyStore.getRecordsPage({
        page: dbRecordsPage.value,
        pageSize: dbRecordsPageSize.value,
        sortField: dbRecordsSortField.value,
        sortOrder: dbRecordsSortOrder.value,
      })
      dbRecords.value = page.records
      dbRecordsTotal.value = page.total
    } catch (e) {
      logger.error('Advanced.dbBrowse', e)
      message.error((e as Error).message)
    } finally {
      dbRecordsLoading.value = false
    }
  }

  function handleDbSorterChange(sorter: DataTableSortState | DataTableSortState[] | null) {
    const next = Array.isArray(sorter) ? sorter[0] : sorter
    dbRecordsSortField.value = next?.columnKey ? String(next.columnKey) : undefined
    dbRecordsSortOrder.value = next?.order ?? false
    dbRecordsPage.value = 1
    void loadDbRecords()
  }

  function handleDbReset() {
    showDatabaseReset()
  }

  async function handleExportLogs() {
    try {
      const resolvedDir = await resolveUserVisibleDownloadDir({ configuredDir: preferenceStore.config.dir })
      const defaultPath = await join(resolvedDir.path, 'motrix-next-logs.zip')
      logger.info('Advanced.exportLogs', `defaultDir source=${resolvedDir.source} fallback=${resolvedDir.usedFallback}`)
      const savePath = await saveDialog({
        title: t('preferences.export-diagnostic-logs'),
        defaultPath,
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

  async function handleExportSettings() {
    try {
      const resolvedDir = await resolveUserVisibleDownloadDir({ configuredDir: preferenceStore.config.dir })
      const date = new Date().toISOString().slice(0, 10)
      const defaultPath = await join(resolvedDir.path, `motrix-next-settings-backup-${date}.json`)
      const savePath = await saveDialog({
        title: t('preferences.export-settings'),
        defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!savePath) return

      exportingSettings.value = true
      const appVersion = await getVersion()
      const backup = buildSettingsBackup(preferenceStore.config, appVersion)
      await invoke('write_settings_backup_file', { path: savePath, content: `${JSON.stringify(backup, null, 2)}\n` })
      message.success(t('preferences.export-settings-success', { path: savePath }))
    } catch (e) {
      logger.error('Advanced.exportSettings', e)
      message.error(t('preferences.export-settings-failed'))
    } finally {
      exportingSettings.value = false
    }
  }

  async function handleImportSettings() {
    const selected = await openDialog({
      title: t('preferences.import-settings'),
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (typeof selected !== 'string') return

    let imported: AppConfig
    try {
      imported = parseSettingsBackup(await invoke<string>('read_settings_backup_file', { path: selected }))
    } catch (e) {
      logger.warn('Advanced.importSettings', e instanceof Error ? e.message : String(e))
      message.error(t('preferences.import-settings-invalid'))
      return
    }

    dialog.warning({
      title: t('preferences.import-settings'),
      content: t('preferences.import-settings-confirm'),
      positiveText: t('preferences.import-settings'),
      negativeText: t('app.cancel'),
      maskClosable: false,
      onPositiveClick: async () => {
        importingSettings.value = true
        try {
          const ok = await preferenceStore.replaceAndSave(imported)
          if (!ok) {
            message.error(t('preferences.import-settings-failed'))
            return
          }
          await invoke('replace_system_config', { config: buildSystemConfigFromAppConfig(imported, imported.dir) })
          Object.assign(form.value, buildForm())
          resetSnapshot()
          message.success(t('preferences.import-settings-success'))
          dialog.info({
            title: t('preferences.settings-imported'),
            content: t('preferences.import-settings-restart-confirm'),
            positiveText: t('preferences.restart-now'),
            negativeText: t('preferences.engine-restart-later'),
            maskClosable: false,
            onPositiveClick: async () => {
              await engineStore.stop('appRelaunch')
              await relaunch()
            },
          })
        } catch (e) {
          logger.error('Advanced.importSettings', e)
          message.error(t('preferences.import-settings-failed'))
        } finally {
          importingSettings.value = false
        }
      },
    })
  }

  function handleClearLog() {
    dialog.error({
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
      const fileExists = await invoke<boolean>('check_path_exists', { path: filePath })
      if (!fileExists) {
        message.warning(t('task.file-not-exist'))
        return
      }
      await invoke('show_item_in_dir', { path: filePath })
      message.success(t('task.open-folder-success'))
    } catch (e) {
      logger.warn('Advanced.revealPath', e instanceof Error ? e.message : JSON.stringify(e))
      message.warning(t('task.file-not-exist'))
    }
  }

  async function handleOpenConfigFolder() {
    try {
      const dir = await appDataDir()
      await invoke('open_path_normalized', { path: dir })
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
    dbBrowsePagination,
    handleDbSorterChange,
    exportingLogs,
    exportingSettings,
    importingSettings,
    // Handlers
    handleEngineStateReset,
    handleRestoreDefaults,
    handleFactoryReset,
    handleDbIntegrityCheck,
    handleDbBrowse,
    handleDbReset,
    handleExportLogs,
    handleExportSettings,
    handleImportSettings,
    handleClearLog,
    handleRevealPath,
    handleOpenConfigFolder,
  }
}
