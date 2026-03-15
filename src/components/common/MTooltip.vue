<script lang="ts">
/**
 * @fileoverview MTooltip — project tooltip wrapper with MD3 three-phase delay.
 *
 * Wraps Naive UI's `NTooltip` to enforce a consistent delay model across the
 * entire application, following Material Design 3's tooltip timing spec:
 *
 *   1. **Warmup (500ms)** — first hover waits before showing tooltip
 *   2. **Cooldown (1500ms)** — after hiding, a window stays "warm"
 *   3. **Reshow (0ms)** — during cooldown, next tooltip appears instantly
 *
 * Usage is identical to NTooltip — all props, slots, and events are passed
 * through transparently.
 *
 * @example
 * ```vue
 * <MTooltip placement="right">
 *   <template #trigger>
 *     <button>hover me</button>
 *   </template>
 *   Brief tooltip text
 * </MTooltip>
 * ```
 */

/** Default configuration constants, exported for testing. */
export const TOOLTIP_DEFAULTS = {
  /** Initial delay before first tooltip appears (ms). */
  delay: 500,
  /** Duration after hiding during which subsequent tooltips show instantly (ms). */
  cooldown: 1500,
} as const

// ── Global warmup/cooldown state machine ──────────────────────────
// Shared across all MTooltip instances in the app.  This enables the
// "reshow" behavior: if you hover button A (tooltip shows), move to
// button B within the cooldown window, button B's tooltip appears
// immediately instead of waiting for another full warmup.

let lastHideTimestamp = 0

/**
 * Mark that a tooltip was just hidden.  Starts (or resets) the cooldown
 * window so subsequent MTooltip instances can reshow instantly.
 */
export function markTooltipHidden(): void {
  lastHideTimestamp = Date.now()
}

/**
 * Compute the effective delay for a tooltip based on warmup/cooldown state.
 *
 * @param baseDelay - The desired warmup delay (default: TOOLTIP_DEFAULTS.delay)
 * @returns 0 if within cooldown window (instant reshow), baseDelay otherwise
 */
export function computeDelay(baseDelay: number): number {
  if (lastHideTimestamp === 0) return baseDelay
  const elapsed = Date.now() - lastHideTimestamp
  return elapsed < TOOLTIP_DEFAULTS.cooldown ? 0 : baseDelay
}

/**
 * Reset the global cooldown state.  Exported for testing only —
 * production code should never call this.
 * @internal
 */
export function resetTooltipState(): void {
  lastHideTimestamp = 0
}
</script>

<script setup lang="ts">
/**
 * MTooltip component — wraps NTooltip with automatic delay management.
 *
 * All NTooltip props are accepted.  If `delay` is not explicitly passed,
 * the warmup default (500ms) is applied.  During the global cooldown
 * window, the delay is automatically reduced to 0 for instant reshow.
 */
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'

const props = withDefaults(
  defineProps<{
    /** Show delay in ms.  Defaults to TOOLTIP_DEFAULTS.delay (500ms). */
    delay?: number
    /** Tooltip placement.  Passed through to NTooltip. */
    placement?:
      | 'top'
      | 'bottom'
      | 'left'
      | 'right'
      | 'top-start'
      | 'top-end'
      | 'bottom-start'
      | 'bottom-end'
      | 'left-start'
      | 'left-end'
      | 'right-start'
      | 'right-end'
    /** Whether the tooltip is disabled.  Passed through to NTooltip. */
    disabled?: boolean
    /** Duration the tooltip remains visible in ms.  Passed through. */
    duration?: number
  }>(),
  {
    delay: TOOLTIP_DEFAULTS.delay,
    placement: undefined,
    disabled: undefined,
    duration: undefined,
  },
)

/**
 * Effective delay accounting for the global cooldown state machine.
 * During cooldown → 0 (instant reshow).  Otherwise → props.delay.
 */
const effectiveDelay = computed(() => computeDelay(props.delay))

function onUpdateShow(visible: boolean) {
  if (!visible) {
    markTooltipHidden()
  }
}
</script>

<template>
  <NTooltip
    :delay="effectiveDelay"
    :placement="placement"
    :disabled="disabled"
    :duration="duration"
    @update:show="onUpdateShow"
  >
    <template #trigger>
      <slot name="trigger" />
    </template>
    <slot />
  </NTooltip>
</template>
