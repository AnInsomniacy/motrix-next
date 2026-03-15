/**
 * @fileoverview Tests for MTooltip — the project's tooltip wrapper component.
 *
 * MTooltip wraps Naive UI's NTooltip with an MD3-standard three-phase delay
 * model (warmup → cooldown → reshow), ensuring consistent tooltip behavior
 * across the entire application.
 *
 * The three-phase model:
 *   1. **Warmup (500ms)** — first hover waits 500ms before showing tooltip
 *   2. **Cooldown (1500ms)** — after hiding, a 1500ms window stays "warm"
 *   3. **Reshow (0ms)** — during cooldown, moving to another tooltip shows
 *      it immediately without waiting for the full warmup delay
 *
 * HONESTY NOTE: These tests exercise the real delay computation logic via
 * vi.useFakeTimers.  NTooltip is mocked at the module level because JSDOM
 * can't render Naive UI's popover positioning layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'

// ── Mock naive-ui — factory must be self-contained (vi.mock is hoisted) ─
vi.mock('naive-ui', async () => {
  const { defineComponent, h: hh } = await import('vue')
  return {
    NTooltip: defineComponent({
      name: 'NTooltip',
      props: {
        delay: { type: Number, default: undefined },
        placement: { type: String, default: undefined },
        disabled: { type: Boolean, default: undefined },
        duration: { type: Number, default: undefined },
      },
      emits: ['update:show'],
      setup(_props, { slots }) {
        return () => hh('div', { class: 'mock-tooltip' }, [slots.trigger?.(), slots.default?.()])
      },
    }),
  }
})

import { TOOLTIP_DEFAULTS, computeDelay, markTooltipHidden, resetTooltipState } from '@/components/common/MTooltip.vue'
import MTooltip from '@/components/common/MTooltip.vue'

// ── Lifecycle ──────────────────────────────────────────────────────
beforeEach(() => {
  resetTooltipState()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('MTooltip', () => {
  // ── Mount helper ────────────────────────────────────────────────
  function mountMTooltip(props: Record<string, unknown> = {}, slots?: Record<string, () => unknown>) {
    return mount(MTooltip, {
      props,
      slots: slots ?? {
        trigger: () => h('button', 'hover me'),
        default: () => 'tooltip text',
      },
    })
  }

  /** Find the inner mocked NTooltip component */
  function findInnerTooltip(wrapper: ReturnType<typeof mountMTooltip>) {
    return wrapper.findComponent({ name: 'NTooltip' })
  }

  // ── Constants ────────────────────────────────────────────────────
  describe('TOOLTIP_DEFAULTS export', () => {
    it('exports default delay of 500ms', () => {
      expect(TOOLTIP_DEFAULTS.delay).toBe(500)
    })

    it('exports cooldown of 1500ms', () => {
      expect(TOOLTIP_DEFAULTS.cooldown).toBe(1500)
    })
  })

  // ── Default delay ───────────────────────────────────────────────
  describe('default delay', () => {
    it('passes delay=500 to NTooltip when no delay prop is specified', () => {
      const wrapper = mountMTooltip()

      const inner = findInnerTooltip(wrapper)
      expect(inner.exists()).toBe(true)
      expect(inner.props('delay')).toBe(500)
    })

    it('allows overriding delay via prop', () => {
      const wrapper = mountMTooltip({ delay: 300 })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('delay')).toBe(300)
    })

    it('allows setting delay to 0 (instant) when explicitly passed', () => {
      const wrapper = mountMTooltip({ delay: 0 })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('delay')).toBe(0)
    })
  })

  // ── Prop passthrough ────────────────────────────────────────────
  describe('prop passthrough', () => {
    it('passes placement to NTooltip', () => {
      const wrapper = mountMTooltip({ placement: 'right' })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('placement')).toBe('right')
    })

    it('passes disabled to NTooltip', () => {
      const wrapper = mountMTooltip({ disabled: true })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('disabled')).toBe(true)
    })

    it('passes duration to NTooltip', () => {
      const wrapper = mountMTooltip({ duration: 2000 })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('duration')).toBe(2000)
    })
  })

  // ── Slot passthrough ────────────────────────────────────────────
  describe('slot passthrough', () => {
    it('renders trigger slot content', () => {
      const wrapper = mountMTooltip(
        {},
        {
          trigger: () => h('button', { id: 'my-btn' }, 'click'),
          default: () => 'tooltip info',
        },
      )

      expect(wrapper.find('#my-btn').exists()).toBe(true)
      expect(wrapper.find('#my-btn').text()).toBe('click')
    })

    it('renders default slot text content', () => {
      const wrapper = mountMTooltip(
        {},
        {
          trigger: () => h('button', 'btn'),
          default: () => h('span', { class: 'tip-body' }, 'useful info'),
        },
      )

      expect(wrapper.find('.tip-body').exists()).toBe(true)
      expect(wrapper.find('.tip-body').text()).toBe('useful info')
    })
  })

  // ── Warmup / Cooldown / Reshow state machine ────────────────────
  describe('warmup / cooldown / reshow state machine', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      resetTooltipState()
    })

    it('computeDelay returns full warmup delay when cold (no recent tooltip)', () => {
      expect(computeDelay(500)).toBe(500)
    })

    it('computeDelay returns 0 during cooldown window (reshow behavior)', () => {
      markTooltipHidden()
      expect(computeDelay(500)).toBe(0)
    })

    it('computeDelay returns full delay after cooldown expires', () => {
      markTooltipHidden()
      vi.advanceTimersByTime(TOOLTIP_DEFAULTS.cooldown + 1)
      expect(computeDelay(500)).toBe(500)
    })

    it('computeDelay uses custom delay value when cold', () => {
      expect(computeDelay(300)).toBe(300)
    })

    it('reshow still returns 0 even with custom delay during cooldown', () => {
      markTooltipHidden()
      expect(computeDelay(300)).toBe(0)
    })

    it('cooldown window resets on each markTooltipHidden call', () => {
      markTooltipHidden()

      vi.advanceTimersByTime(1000)
      expect(computeDelay(500)).toBe(0) // Still warm

      markTooltipHidden() // Reset

      vi.advanceTimersByTime(1000)
      expect(computeDelay(500)).toBe(0) // Still warm (1000ms < 1500ms from reset)

      vi.advanceTimersByTime(501)
      expect(computeDelay(500)).toBe(500) // Cold again
    })

    it('computeDelay returns full delay at exactly the cooldown boundary', () => {
      markTooltipHidden()
      vi.advanceTimersByTime(TOOLTIP_DEFAULTS.cooldown)
      expect(computeDelay(500)).toBe(500)
    })

    it('computeDelay returns 0 at 1ms before cooldown boundary', () => {
      markTooltipHidden()
      vi.advanceTimersByTime(TOOLTIP_DEFAULTS.cooldown - 1)
      expect(computeDelay(500)).toBe(0)
    })
  })
})
