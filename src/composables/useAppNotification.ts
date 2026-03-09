/** @fileoverview Composable wrapping Naive UI notifications for structured error/warning display. */
import { useNotification } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { normalizeError, normalizeTaskError, errorDedupeKey } from '@shared/errorNormalizer'
import type { ErrorCategory, NormalizedError } from '@shared/errorNormalizer'
import { logger } from '@shared/logger'

/** Duration before warning notifications auto-dismiss (ms). */
const WARNING_DURATION = 8000

/** Maximum active error notifications before oldest is evicted. */
const MAX_ERROR_NOTIFICATIONS = 3

const activeErrors = new Map<string, { destroy: () => void; createdAt: number }>()

function evictOldest() {
  if (activeErrors.size <= MAX_ERROR_NOTIFICATIONS) return
  let oldestKey = ''
  let oldestTime = Infinity
  for (const [key, entry] of activeErrors) {
    if (entry.createdAt < oldestTime) {
      oldestTime = entry.createdAt
      oldestKey = key
    }
  }
  if (oldestKey) {
    activeErrors.get(oldestKey)?.destroy()
    activeErrors.delete(oldestKey)
  }
}

export function useAppNotification() {
  const notification = useNotification()
  const { t, te } = useI18n()

  function resolveDescription(normalized: NormalizedError): string {
    if (normalized.messageKey && te(normalized.messageKey)) {
      const i18nText = t(normalized.messageKey)
      // Append raw message for debugging context when it differs from the i18n text
      if (normalized.rawMessage && normalized.rawMessage !== i18nText) {
        return `${i18nText}\n\n${normalized.rawMessage}`
      }
      return i18nText
    }
    return normalized.rawMessage
  }

  /**
   * Show an error notification with structured title and description.
   * Deduplicates by error key to prevent notification spam.
   */
  function notifyError(error: unknown, contextHint?: ErrorCategory) {
    const normalized = normalizeError(error, contextHint)
    const key = errorDedupeKey(normalized)

    logger.error(`[${normalized.category}]`, normalized.rawMessage)

    // Deduplicate: skip if same error is already showing
    if (activeErrors.has(key)) return

    evictOldest()

    const title = te(normalized.titleKey) ? t(normalized.titleKey) : t('app.error-title-generic')
    const description = resolveDescription(normalized)

    const inst = notification.error({
      title,
      content: description,
      closable: true,
      duration: 15_000,
      keepAliveOnHover: true,
      onClose: () => {
        activeErrors.delete(key)
        return true
      },
      onAfterLeave: () => {
        activeErrors.delete(key)
      },
    })

    activeErrors.set(key, { destroy: inst.destroy, createdAt: Date.now() })
  }

  /**
   * Show an error notification for an aria2 task error with errorCode-based mapping.
   */
  function notifyTaskError(errorCode: string | undefined, errorMessage: string | undefined, taskName?: string) {
    const normalized = normalizeTaskError(errorCode, errorMessage, taskName)
    const key = errorDedupeKey(normalized)

    logger.error(`[task]`, normalized.rawMessage)

    if (activeErrors.has(key)) return
    evictOldest()

    const title = te(normalized.titleKey) ? t(normalized.titleKey) : t('app.error-title-generic')
    const description = resolveDescription(normalized)

    const inst = notification.error({
      title,
      content: description,
      closable: true,
      duration: 15_000,
      keepAliveOnHover: true,
      onClose: () => {
        activeErrors.delete(key)
        return true
      },
      onAfterLeave: () => {
        activeErrors.delete(key)
      },
    })

    activeErrors.set(key, { destroy: inst.destroy, createdAt: Date.now() })
  }

  /**
   * Show a warning notification for degraded-but-functional scenarios.
   */
  function notifyWarning(titleKey: string, messageKey?: string, rawFallback?: string) {
    const title = te(titleKey) ? t(titleKey) : titleKey
    const content = messageKey && te(messageKey) ? t(messageKey) : rawFallback || ''

    notification.warning({
      title,
      content: content || undefined,
      closable: true,
      duration: WARNING_DURATION,
      keepAliveOnHover: true,
    })
  }

  return { notifyError, notifyTaskError, notifyWarning }
}
