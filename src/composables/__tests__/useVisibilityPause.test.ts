/**
 * @fileoverview Tests for the useVisibilityPause composable.
 *
 * Verifies that CSS infinite animations are paused when the page becomes
 * hidden (minimized / tab switched) and resumed when visible again.
 *
 * On Windows with transparent: true, WebView2 continues rendering even when
 * minimized — DWM alpha compositing doesn't respect visibility.  This
 * composable toggles a CSS class on <html> to set animation-play-state: paused
 * globally, eliminating needless GPU re-composition of transparent layers.
 *
 * HONESTY NOTE: Tests use real DOM events (no mocks of the module under test).
 * We only stub `document.hidden` since JSDOM doesn't support the
 * Page Visibility API natively.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'

describe('useVisibilityPause', () => {
  // ── Helpers ────────────────────────────────────────────────────────
  let cleanup: (() => void) | undefined

  /** Simulate a visibilitychange event with a specific hidden state. */
  function fireVisibilityChange(hidden: boolean) {
    Object.defineProperty(document, 'hidden', {
      value: hidden,
      writable: true,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  beforeEach(() => {
    // Reset document.hidden to visible
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true,
    })
    // Ensure the class is absent
    document.documentElement.classList.remove('animations-paused')
    cleanup = undefined
  })

  afterEach(() => {
    cleanup?.()
    document.documentElement.classList.remove('animations-paused')
    vi.restoreAllMocks()
  })

  // ── Setup helper: mount the composable ──────────────────────────
  async function mountComposable() {
    // Dynamic import to get a fresh module each test
    const { useVisibilityPause } = await import('@/composables/useVisibilityPause')

    // Simulate Vue lifecycle — composable uses onMounted/onUnmounted
    // We use a tiny Vue app to trigger the lifecycle hooks properly
    const { createApp, defineComponent } = await import('vue')
    const TestComponent = defineComponent({
      setup() {
        useVisibilityPause()
        return () => null
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(TestComponent)
    app.mount(container)
    await nextTick()

    cleanup = () => {
      app.unmount()
      container.remove()
    }

    return { app, container }
  }

  // ── RED: Tests that define the expected behavior ────────────────

  it('does not add animations-paused class on mount when page is visible', async () => {
    await mountComposable()
    expect(document.documentElement.classList.contains('animations-paused')).toBe(false)
  })

  it('adds animations-paused class when page becomes hidden', async () => {
    await mountComposable()

    fireVisibilityChange(true)

    expect(document.documentElement.classList.contains('animations-paused')).toBe(true)
  })

  it('removes animations-paused class when page becomes visible again', async () => {
    await mountComposable()

    // Hide
    fireVisibilityChange(true)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(true)

    // Show
    fireVisibilityChange(false)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(false)
  })

  it('handles multiple hide/show cycles correctly', async () => {
    await mountComposable()

    // Cycle 1
    fireVisibilityChange(true)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(true)
    fireVisibilityChange(false)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(false)

    // Cycle 2
    fireVisibilityChange(true)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(true)
    fireVisibilityChange(false)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(false)
  })

  it('removes event listener on unmount (no leak)', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { app, container } = await mountComposable()

    // Should have registered one visibilitychange listener
    const addCalls = addSpy.mock.calls.filter((c) => c[0] === 'visibilitychange')
    expect(addCalls.length).toBe(1)

    const handler = addCalls[0][1]

    // Unmount
    app.unmount()
    container.remove()
    cleanup = undefined // Already cleaned up

    // The same handler should have been removed
    const removeCalls = removeSpy.mock.calls.filter((c) => c[0] === 'visibilitychange')
    expect(removeCalls.length).toBe(1)
    expect(removeCalls[0][1]).toBe(handler)
  })

  it('does not affect DOM after unmount', async () => {
    const { app, container } = await mountComposable()

    // Unmount
    app.unmount()
    container.remove()
    cleanup = undefined

    // Fire event after unmount — class should NOT be toggled
    fireVisibilityChange(true)
    expect(document.documentElement.classList.contains('animations-paused')).toBe(false)
  })
})
