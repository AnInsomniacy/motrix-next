import { useI18n } from 'vue-i18n'
import { useDialog } from 'naive-ui'
import { useEngineStore, type EngineOperationCause } from '@/stores/engine'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { logger } from '@shared/logger'

type RestartCause = Extract<EngineOperationCause, 'manualRestart' | 'settingsChange'>

export function useEngineRestart() {
  const { t } = useI18n()
  const dialog = useDialog()
  const engineStore = useEngineStore()

  function restartEngine(cause: RestartCause): void {
    void engineStore.restart(cause).catch((error: unknown) => {
      logger.warn('EngineRestart', getErrorMessage(error))
    })
  }

  function confirmManualRestart(): void {
    let accepted = false
    dialog.info({
      title: t('preferences.engine-restart-title'),
      content: t('preferences.engine-restart-manual-confirm'),
      positiveText: t('preferences.engine-restart-now'),
      negativeText: t('preferences.engine-restart-later'),
      maskClosable: false,
      onPositiveClick: () => {
        accepted = true
      },
      onAfterLeave: () => {
        if (accepted) restartEngine('manualRestart')
      },
    })
  }

  return { confirmManualRestart, restartEngine }
}
