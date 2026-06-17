/** @fileoverview Tracks per-task elapsed download time with pause-aware accumulation. */
import { ref, computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Aria2Task } from '@shared/types'
import { timeFormat } from '@shared/utils'

interface ElapsedState {
  /** Milliseconds accumulated from previous active segments (excludes current active segment). */
  accumulatedMs: number
  /** Timestamp (ms) when the current active segment started, or null if not active. */
  activeSince: number | null
}

const elapsedMap = ref(new Map<string, ElapsedState>())

/**
 * Call once per polling cycle with the current task list.
 * Detects active→non-active and non-active→active transitions,
 * accumulating elapsed time accordingly.
 */
export function trackTaskElapsed(tasks: Aria2Task[]): void {
  const now = Date.now()
  for (const task of tasks) {
    const state = elapsedMap.value.get(task.gid)
    if (task.status === 'active') {
      if (!state) {
        // First time seeing this task as active
        elapsedMap.value.set(task.gid, { accumulatedMs: 0, activeSince: now })
      } else if (state.activeSince === null) {
        // Transition: non-active → active (resume or first start)
        state.activeSince = now
      }
      // else: already active, no change needed
    } else {
      if (state?.activeSince !== null && state?.activeSince !== undefined) {
        // Transition: active → non-active (pause/complete/error)
        state.accumulatedMs += now - state.activeSince
        state.activeSince = null
      }
    }
  }
}

/** Get raw elapsed milliseconds for a task (0 if unknown). */
function getElapsedMs(gid: string): number {
  const state = elapsedMap.value.get(gid)
  if (!state) return 0
  if (state.activeSince !== null) return state.accumulatedMs + (Date.now() - state.activeSince)
  return state.accumulatedMs
}

/** Check if a task is currently being timed (active). */
function isTiming(gid: string): boolean {
  return elapsedMap.value.get(gid)?.activeSince != null
}

function formatElapsedSeconds(seconds: number, t: (key: string) => string): string {
  return timeFormat(seconds, {
    i18n: {
      gt1d: t('app.gt1d') || '>1d',
      hour: t('app.hour') || 'h',
      minute: t('app.minute') || 'm',
      second: t('app.second') || 's',
    },
  })
}

/** Composable that returns a reactive elapsed display for a single task. */
export function useTaskElapsed(
  task: ComputedRef<Aria2Task | null>,
  t: (key: string) => string,
  opts?: { addedAt?: ComputedRef<string> | Ref<string>; completedAt?: ComputedRef<string> | Ref<string> },
): { elapsedText: ComputedRef<string>; isTimingActive: ComputedRef<boolean> } {
  // Tick ref forces reactivity update every second for active tasks
  const tick = ref(0)
  let timer: ReturnType<typeof setInterval> | null = null

  const isTimingActive = computed(() => (task.value ? isTiming(task.value.gid) : false))

  // Manage the 1s tick timer based on whether this task is active
  const elapsedText = computed(() => {
    // Read tick to establish reactive dependency
    void tick.value
    const gid = task.value?.gid
    if (!gid) return ''
    const active = isTiming(gid)
    if (active && !timer) {
      timer = setInterval(() => {
        tick.value++
      }, 1000)
    } else if (!active && timer) {
      clearInterval(timer)
      timer = null
    }

    // Primary: use real-time tracking data
    const ms = getElapsedMs(gid)
    if (ms > 0) return formatElapsedSeconds(Math.floor(ms / 1000), t)

    // Fallback: compute from addedAt/completedAt timestamps (for completed tasks)
    const addedAt = opts?.addedAt?.value
    const completedAt = opts?.completedAt?.value
    if (addedAt && completedAt) {
      const diff = new Date(completedAt).getTime() - new Date(addedAt).getTime()
      if (diff > 0) return formatElapsedSeconds(Math.floor(diff / 1000), t)
    }

    return ''
  })

  return { elapsedText, isTimingActive }
}
