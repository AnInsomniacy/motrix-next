/**
 * @fileoverview Tests for the RAF-throttled resize handler in MainLayout.
 *
 * The MainLayout component listens to `appWindow.onResized()` to track the
 * maximize state (used to remove CSS border-radius when maximized).
 * On macOS, the native layer fires resize events at display refresh rate
 * (60-240+ per second), and each event previously triggered an IPC call to
 * `isMaximized()` — causing an IPC storm that froze the main thread.
 *
 * The fix wraps the callback with `requestAnimationFrame` so at most one
 * IPC round-trip occurs per animation frame, regardless of display refresh
 * rate.  These tests verify the throttling behavior at the unit level by
 * extracting the throttle logic into a testable function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock requestAnimationFrame / cancelAnimationFrame ──────────────
let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = []
let nextRafId = 1
const mockRAF = vi.fn((cb: FrameRequestCallback): number => {
  const id = nextRafId++
  rafCallbacks.push({ id, cb })
  return id
})
const mockCancelRAF = vi.fn((id: number) => {
  rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id)
})

vi.stubGlobal('requestAnimationFrame', mockRAF)
vi.stubGlobal('cancelAnimationFrame', mockCancelRAF)

/** Simulate flushing all pending RAF callbacks (like a vsync tick). */
function flushRAF() {
  const pending = [...rafCallbacks]
  rafCallbacks = []
  for (const { cb } of pending) {
    cb(performance.now())
  }
}

import { throttledResizeHandler, cancelPendingResize } from '@/layouts/resizeThrottle'

beforeEach(() => {
  rafCallbacks = []
  nextRafId = 1
  mockRAF.mockClear()
  mockCancelRAF.mockClear()
  cancelPendingResize()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('throttledResizeHandler', () => {
  it('calls the callback on the next animation frame', () => {
    const spy = vi.fn()
    throttledResizeHandler(spy)

    expect(spy).not.toHaveBeenCalled()
    expect(mockRAF).toHaveBeenCalledTimes(1)

    flushRAF()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('coalesces multiple calls within a single frame into one execution', () => {
    const spy = vi.fn()

    // Simulate macOS spamming resize events (5 events before next frame)
    throttledResizeHandler(spy)
    throttledResizeHandler(spy)
    throttledResizeHandler(spy)
    throttledResizeHandler(spy)
    throttledResizeHandler(spy)

    // Only one RAF should have been scheduled
    expect(mockRAF).toHaveBeenCalledTimes(1)

    flushRAF()

    // Callback executes exactly once per frame
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('allows a new call after the previous frame has been flushed', () => {
    const spy = vi.fn()

    // Frame 1
    throttledResizeHandler(spy)
    flushRAF()
    expect(spy).toHaveBeenCalledTimes(1)

    // Frame 2 — should schedule a new RAF
    throttledResizeHandler(spy)
    expect(mockRAF).toHaveBeenCalledTimes(2)

    flushRAF()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('supports different callbacks on different frames', () => {
    const spyA = vi.fn()
    const spyB = vi.fn()

    throttledResizeHandler(spyA)
    flushRAF()
    expect(spyA).toHaveBeenCalledTimes(1)

    throttledResizeHandler(spyB)
    flushRAF()
    expect(spyB).toHaveBeenCalledTimes(1)
  })

  it('cancelPendingResize prevents a scheduled callback from executing', () => {
    const spy = vi.fn()

    throttledResizeHandler(spy)
    expect(mockRAF).toHaveBeenCalledTimes(1)

    cancelPendingResize()
    expect(mockCancelRAF).toHaveBeenCalledTimes(1)

    flushRAF()

    // The callback should NOT have been called — it was cancelled
    expect(spy).not.toHaveBeenCalled()
  })

  it('cancelPendingResize is safe to call when nothing is pending', () => {
    // Should not throw
    expect(() => cancelPendingResize()).not.toThrow()
    expect(mockCancelRAF).not.toHaveBeenCalled()
  })

  it('handles 100 rapid events with only 1 callback execution per frame', () => {
    const spy = vi.fn()

    for (let i = 0; i < 100; i++) {
      throttledResizeHandler(spy)
    }

    expect(mockRAF).toHaveBeenCalledTimes(1)

    flushRAF()

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
