import { h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialog } from 'naive-ui'
import { useDatabaseStore } from '@/stores/database'
import { useAppMessage } from '@/composables/useAppMessage'
import { logger } from '@shared/logger'

/** Shared confirmation and native reset; Naive UI owns focus, loading and transitions. */
export function useDatabaseReset() {
  const { t } = useI18n()
  const dialogs = useDialog()
  const message = useAppMessage()
  const database = useDatabaseStore()

  function showDatabaseReset(recovery = false) {
    database.notified = true
    const dialog = dialogs.warning({
      title: recovery ? t('preferences.db-unavailable') : t('preferences.db-reset'),
      content: () =>
        h('div', { style: { whiteSpace: 'pre-line' } }, [
          ...(recovery ? [t('preferences.db-unavailable-description'), '\n'] : []),
          t('preferences.db-reset-confirm'),
        ]),
      positiveText: t('preferences.db-reset-restart'),
      negativeText: recovery ? t('preferences.db-reset-later') : t('app.cancel'),
      maskClosable: false,
      onPositiveClick: async () => {
        dialog.loading = true
        dialog.closable = false
        dialog.closeOnEsc = false
        dialog.negativeButtonProps = { disabled: true }
        try {
          await database.reset()
        } catch (error: unknown) {
          logger.error('Database.reset', error)
          message.error(t('preferences.db-reset-failed'))
          dialog.loading = false
          dialog.closable = true
          dialog.closeOnEsc = true
          dialog.negativeButtonProps = { disabled: false }
        }
        return false
      },
    })
  }

  return { showDatabaseReset }
}
