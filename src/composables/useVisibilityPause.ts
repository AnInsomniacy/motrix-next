/**
 * @fileoverview Pause all CSS infinite animations when the page is hidden.
 *
 * On Windows with `transparent: true`, WebView2 continues rendering even
 * when the window is minimized — DWM alpha compositing doesn't respect the
 * Page Visibility API.  This composable toggles a CSS class on `<html>`
 * that applies `animation-play-state: paused` globally, eliminating
 * needless GPU re-composition of transparent layers each frame.
 *
 * The corresponding CSS rule lives in `variables.css`:
 *
 * ```css
 * .animations-paused *,
 * .animations-paused *::before,
 * .animations-paused *::after {
 *   animation-play-state: paused !important;
 * }
 * ```
 *
 * This is a cross-platform benefit: macOS and Linux also skip unnecessary
 * CSS animation work when the window is not visible.
 */
import { onMounted, onUnmounted } from 'vue'

const PAUSED_CLASS = 'animations-paused'

/**
 * Toggle the `animations-paused` class on `<html>` based on page visibility.
 *
 * Must be called inside a Vue component's `setup()` function so the
 * lifecycle hooks (`onMounted` / `onUnmounted`) attach correctly.
 */
export function useVisibilityPause(): void {
  function onVisibilityChange(): void {
    document.documentElement.classList.toggle(PAUSED_CLASS, document.hidden)
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
}
