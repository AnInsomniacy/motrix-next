/**
 * @fileoverview RAF-throttled resize handler for Tauri window events.
 *
 * On macOS, the native layer (tao/wry) fires resize events at the display's
 * refresh rate — 60 to 240+ times per second.  If each event triggers an
 * IPC call (e.g. `isMaximized()`), the resulting IPC storm blocks the main
 * thread and freezes the UI.
 *
 * This module provides a `requestAnimationFrame`-based throttle that
 * coalesces multiple resize events into at most one callback per animation
 * frame.  RAF automatically adapts to any display refresh rate:
 *
 *   | Refresh Rate | RAF Interval |
 *   |:------------:|:------------:|
 *   | 60 Hz        | 16.7 ms      |
 *   | 120 Hz       | 8.3 ms       |
 *   | 144 Hz       | 6.9 ms       |
 *   | 240 Hz       | 4.2 ms       |
 *
 * This is the standard approach used by Chromium, Electron, and all major
 * desktop frameworks for throttling resize-driven visual updates.
 */

let pendingRafId = 0

/**
 * Schedule a callback on the next animation frame, coalescing any
 * subsequent calls until that frame fires.
 *
 * @param callback - The function to execute once per frame.
 */
export function throttledResizeHandler(callback: () => void): void {
  if (pendingRafId) return
  pendingRafId = requestAnimationFrame(() => {
    pendingRafId = 0
    callback()
  })
}

/**
 * Cancel any pending RAF callback.  Call this during component cleanup
 * (e.g. `onUnmounted`) to prevent stale callbacks from executing.
 */
export function cancelPendingResize(): void {
  if (pendingRafId) {
    cancelAnimationFrame(pendingRafId)
    pendingRafId = 0
  }
}
