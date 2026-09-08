/**
 * @fileoverview Tests for the useAppMessage composable.
 *
 * Key behaviors under test:
 * - All four message types invoke Naive UI's message API
 * - Content is truncated via ellipsis when exceeding TOAST_MAX_LENGTH
 * - Duplicate messages within the dedup window are coalesced (destroy + rescheduled)
 * - Different content strings are tracked independently
 * - After the dedup timer expires, the same content can be shown again
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock naive-ui's useMessage before importing the composable ──────
const destroyFn = vi.fn()
function createMessageHandle(options?: { duration?: number; onAfterLeave?: () => void }) {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    options?.onAfterLeave?.()
  }
  const duration = options?.duration ?? 0
  if (duration > 0) setTimeout(close, duration)
  return {
    destroy: () => {
      destroyFn()
      close()
    },
  }
}

const mockMessageApi = {
  success: vi.fn((_content: unknown, options?: { duration?: number; onAfterLeave?: () => void }) =>
    createMessageHandle(options),
  ),
  error: vi.fn((_content: unknown, options?: { duration?: number; onAfterLeave?: () => void }) =>
    createMessageHandle(options),
  ),
  warning: vi.fn((_content: unknown, options?: { duration?: number; onAfterLeave?: () => void }) =>
    createMessageHandle(options),
  ),
  info: vi.fn((_content: unknown, options?: { duration?: number; onAfterLeave?: () => void }) =>
    createMessageHandle(options),
  ),
  loading: vi.fn((content: unknown, options?: { duration?: number; onAfterLeave?: () => void }) => ({
    ...createMessageHandle(options),
    content,
    type: 'loading',
    closable: false,
  })),
}

vi.mock('naive-ui', () => ({
  useMessage: () => mockMessageApi,
}))

import { useAppMessage } from '../useAppMessage'

function renderMessageCallContent(method: keyof typeof mockMessageApi, index = 0) {
  const content = (mockMessageApi[method].mock.calls[index] as unknown as [() => unknown])[0]
  expect(typeof content).toBe('function')
  return content as () => { props?: { class?: string; style?: Record<string, string> }; children?: string }
}

describe('useAppMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('updates and completes a tracked progress message in place', () => {
    const msg = useAppMessage()
    const progress = msg.progress('stopping')
    const reactive = mockMessageApi.loading.mock.results[0].value as {
      content: () => { children?: string }
      type: string
      closable: boolean
    }

    progress.update('restarting')
    expect(reactive.content().children).toBe('restarting')
    expect(reactive.type).toBe('loading')

    progress.finish('complete', 'success')
    expect(reactive.content().children).toBe('complete')
    expect(reactive.type).toBe('success')
    expect(reactive.closable).toBe(true)

    vi.advanceTimersByTime(4000)
    expect(destroyFn).toHaveBeenCalledOnce()
  })

  it('truncates long content to TOAST_MAX_LENGTH (128 chars)', () => {
    const msg = useAppMessage()
    const longContent = 'A'.repeat(200)

    msg.info(longContent)

    const vnode = renderMessageCallContent('info')()
    const displayedContent = vnode.children ?? ''
    expect(displayedContent.length).toBeLessThanOrEqual(131) // 128 chars + "..."
    expect(displayedContent).toContain('...')
  })

  it('destroys and reschedules duplicate messages within the dedup window', () => {
    const msg = useAppMessage()

    msg.error('connection lost')
    expect(mockMessageApi.error).toHaveBeenCalledTimes(1)

    // Immediately trigger the same message again — should destroy the first
    msg.error('connection lost')
    expect(destroyFn).toHaveBeenCalledTimes(1)

    // After 80ms debounce, the replacement message is shown
    vi.advanceTimersByTime(80)
    expect(mockMessageApi.error).toHaveBeenCalledTimes(2)
    expect(typeof (mockMessageApi.error.mock.calls[1] as unknown as [unknown])[0]).toBe('function')
  })

  it('does not interfere between different message contents', () => {
    const msg = useAppMessage()

    msg.error('error A')
    msg.error('error B')

    // Both should be shown independently — no dedup
    expect(mockMessageApi.error).toHaveBeenCalledTimes(2)
    expect(destroyFn).not.toHaveBeenCalled()
  })

  it('allows the same content again after the dedup timer expires', () => {
    const msg = useAppMessage()

    msg.info('hello')
    expect(mockMessageApi.info).toHaveBeenCalledTimes(1)

    // Advance past the MESSAGE_DURATION (3000ms) cleanup timer
    vi.advanceTimersByTime(4000)

    msg.info('hello')
    // Should not trigger dedup — shown fresh
    expect(mockMessageApi.info).toHaveBeenCalledTimes(2)
    expect(destroyFn).not.toHaveBeenCalled()
  })

  it('applies custom options (duration) from caller', () => {
    const msg = useAppMessage()

    msg.success('fast', { duration: 1000 })

    const options = (mockMessageApi.success.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]
    expect(options.duration).toBe(1000)
    expect(options.closable).toBe(true)
    expect(options.keepAliveOnHover).toBe(true)
  })
})
