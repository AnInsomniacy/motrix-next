/**
 * @fileoverview Tests for the useAppNotification composable.
 *
 * Key behaviors under test:
 * - notifyError: creates notification with translated title/description, logs error, deduplicates
 * - notifyTaskError: creates task notification, dedup works, handles undefined code/message
 * - notifyWarning: uses WARNING_DURATION (8000ms), no dedup tracking
 * - resolveDescription: messageKey translatable → i18n text, raw fallback when no messageKey
 * - evictOldest: destroys oldest when >3 active error notifications
 *
 * Because `activeErrors` is a module-level Map, we use vi.resetModules() + dynamic import()
 * to get a fresh module instance for each test, ensuring clean state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────

const destroyFn = vi.fn()
const mockNotificationApi = {
  error: vi.fn(() => ({ destroy: destroyFn })),
  warning: vi.fn(() => ({ destroy: vi.fn() })),
}

// te() returns true for known keys, t() returns translated text
const KNOWN_KEYS: Record<string, string> = {
  'app.error-title-engine': 'Engine Error',
  'app.error-title-task': 'Task Error',
  'app.error-title-network': 'Network Error',
  'app.error-title-file': 'File Error',
  'app.error-title-config': 'Config Error',
  'app.error-title-update': 'Update Error',
  'app.error-title-generic': 'Error',
  'app.error-engine-start-failed': 'Failed to start the download engine',
  'app.error-rpc-connection-failed': 'Could not connect to the download engine',
  'app.error-rpc-timeout': 'Request timed out',
  'task.error-disk-full': 'Disk is full',
  'task.error-network': 'Network error',
}

const mockLoggerError = vi.fn()

vi.mock('naive-ui', () => ({
  useNotification: () => mockNotificationApi,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => KNOWN_KEYS[key] ?? key,
    te: (key: string) => key in KNOWN_KEYS,
  }),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: mockLoggerError },
}))

// ── Helpers ──────────────────────────────────────────────────────────

async function freshModule() {
  vi.resetModules()
  const mod = await import('../useAppNotification')
  return mod.useAppNotification
}

// ── Tests ────────────────────────────────────────────────────────────

describe('useAppNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── notifyError ──────────────────────────────────────────────────

  describe('notifyError', () => {
    it('creates notification with translated title and description', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()
      notifyError('Failed to start engine')

      expect(mockNotificationApi.error).toHaveBeenCalledOnce()
      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.title).toBe('Engine Error')
      expect(opts.content).toContain('Failed to start the download engine')
    })

    it('logs error via logger.error', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()
      notifyError('something broke')

      expect(mockLoggerError).toHaveBeenCalled()
    })

    it('deduplicates: same error key skips second notification', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()

      notifyError('Failed to start engine')
      notifyError('Failed to start engine')

      expect(mockNotificationApi.error).toHaveBeenCalledTimes(1)
    })

    it('different error keys create separate notifications', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()

      notifyError('Failed to start engine')
      notifyError('disk full')

      expect(mockNotificationApi.error).toHaveBeenCalledTimes(2)
    })

    it('allows same error again after onClose dismissal', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()

      notifyError('Failed to start engine')
      expect(mockNotificationApi.error).toHaveBeenCalledTimes(1)

      // Simulate user closing the notification
      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      const onClose = opts.onClose as () => boolean
      onClose()

      notifyError('Failed to start engine')
      expect(mockNotificationApi.error).toHaveBeenCalledTimes(2)
    })

    it('uses fallback title when titleKey is not translatable', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()
      // 'something completely unknown' → generic category → 'app.error-title-generic' IS known
      notifyError('something completely unknown')

      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.title).toBe('Error')
    })
  })

  // ── notifyTaskError ──────────────────────────────────────────────

  describe('notifyTaskError', () => {
    it('creates task notification with correct title', async () => {
      const useAppNotification = await freshModule()
      const { notifyTaskError } = useAppNotification()
      notifyTaskError('5', 'no space left', 'archive.zip')

      expect(mockNotificationApi.error).toHaveBeenCalledOnce()
      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.title).toBe('Task Error')
    })

    it('deduplicates task errors', async () => {
      const useAppNotification = await freshModule()
      const { notifyTaskError } = useAppNotification()

      notifyTaskError('5', 'disk full', 'file1.zip')
      notifyTaskError('5', 'disk full', 'file1.zip')

      // Same errorCode → same messageKey → same dedup key
      expect(mockNotificationApi.error).toHaveBeenCalledTimes(1)
    })

    it('handles undefined code and message', async () => {
      const useAppNotification = await freshModule()
      const { notifyTaskError } = useAppNotification()
      notifyTaskError(undefined, undefined)

      expect(mockNotificationApi.error).toHaveBeenCalledOnce()
      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.content).toBe('Unknown error')
    })

    it('includes taskName in log output', async () => {
      const useAppNotification = await freshModule()
      const { notifyTaskError } = useAppNotification()
      notifyTaskError('6', 'network failure', 'movie.mkv')

      expect(mockLoggerError).toHaveBeenCalled()
      const logArgs = mockLoggerError.mock.calls[0]
      expect(logArgs[1]).toContain('movie.mkv')
    })
  })

  // ── notifyWarning ────────────────────────────────────────────────

  describe('notifyWarning', () => {
    it('creates warning with 8000ms duration', async () => {
      const useAppNotification = await freshModule()
      const { notifyWarning } = useAppNotification()
      notifyWarning('app.error-title-config', 'app.error-engine-start-failed')

      expect(mockNotificationApi.warning).toHaveBeenCalledOnce()
      const opts = (mockNotificationApi.warning.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.duration).toBe(8000)
    })

    it('does not track for deduplication (no dedup on warnings)', async () => {
      const useAppNotification = await freshModule()
      const { notifyWarning } = useAppNotification()

      notifyWarning('app.error-title-config')
      notifyWarning('app.error-title-config')

      // Both should go through — no dedup
      expect(mockNotificationApi.warning).toHaveBeenCalledTimes(2)
    })

    it('uses titleKey as-is when not translatable', async () => {
      const useAppNotification = await freshModule()
      const { notifyWarning } = useAppNotification()
      notifyWarning('some.unknown.key')

      const opts = (mockNotificationApi.warning.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.title).toBe('some.unknown.key')
    })

    it('uses rawFallback when no messageKey provided', async () => {
      const useAppNotification = await freshModule()
      const { notifyWarning } = useAppNotification()
      notifyWarning('app.error-title-config', undefined, 'Fallback text here')

      const opts = (mockNotificationApi.warning.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.content).toBe('Fallback text here')
    })
  })

  // ── resolveDescription (via notifyError) ─────────────────────────

  describe('resolveDescription (via notifyError)', () => {
    it('uses i18n text when messageKey is translatable', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()
      notifyError('Failed to start engine')

      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.content).toContain('Failed to start the download engine')
    })

    it('appends rawMessage when it differs from i18n text', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()
      notifyError('Failed to start engine')

      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      const content = opts.content as string
      // Should contain both i18n text and raw message
      expect(content).toContain('Failed to start the download engine')
      expect(content).toContain('Failed to start engine')
    })

    it('uses rawMessage when no messageKey matches', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()
      notifyError('disk full')

      const opts = (mockNotificationApi.error.mock.calls[0] as unknown as [Record<string, unknown>])[0]
      expect(opts.content).toBe('disk full')
    })
  })

  // ── evictOldest ──────────────────────────────────────────────────

  describe('evictOldest', () => {
    // evictOldest checks `activeErrors.size < MAX_ERROR_NOTIFICATIONS (3)`.
    // It's called BEFORE adding the new entry, so eviction triggers when
    // there are already 3 entries (on the 4th notifyError call).

    it('does not evict when <=3 active errors (at capacity)', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()

      vi.setSystemTime(1000)
      notifyError('error one')
      vi.setSystemTime(2000)
      notifyError('error two')
      vi.setSystemTime(3000)
      notifyError('error three')

      expect(mockNotificationApi.error).toHaveBeenCalledTimes(3)
      expect(destroyFn).not.toHaveBeenCalled()
    })

    it('destroys oldest when 4th error is added (exceeds MAX_ERROR_NOTIFICATIONS)', async () => {
      const useAppNotification = await freshModule()
      const { notifyError } = useAppNotification()

      vi.setSystemTime(1000)
      notifyError('error alpha')
      vi.setSystemTime(2000)
      notifyError('error beta')
      vi.setSystemTime(3000)
      notifyError('error gamma')
      vi.setSystemTime(4000)
      notifyError('error delta')

      expect(mockNotificationApi.error).toHaveBeenCalledTimes(4)
      // The oldest (error alpha, createdAt=1000) should have been evicted
      expect(destroyFn).toHaveBeenCalledTimes(1)
    })
  })
})
