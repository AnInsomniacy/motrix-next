/** @fileoverview AutoAnimate directive controlled by the global reduced-motion preference. */
import autoAnimate, {
  type AnimationController,
  type AutoAnimateOptions,
  type AutoAnimationPlugin,
} from '@formkit/auto-animate'
import { watch, type Directive, type WatchStopHandle } from 'vue'
import { usePreferenceStore } from '@/stores/preference'

type MotionAutoAnimateOptions = Partial<AutoAnimateOptions> | AutoAnimationPlugin

interface MotionAutoAnimateState {
  controller: AnimationController
  stop: WatchStopHandle
}

const states = new WeakMap<HTMLElement, MotionAutoAnimateState>()

export const vMotionAutoAnimate: Directive<HTMLElement, MotionAutoAnimateOptions | undefined> = {
  mounted(element, binding) {
    const controller = autoAnimate(element, binding.value)
    const preferenceStore = usePreferenceStore()
    const stop = watch(
      () => preferenceStore.config.reduceMotion,
      (reduceMotion) => {
        if (reduceMotion) controller.disable()
        else controller.enable()
      },
      { immediate: true },
    )
    states.set(element, { controller, stop })
  },
  unmounted(element) {
    const state = states.get(element)
    if (!state) return
    state.stop()
    state.controller.destroy?.()
    states.delete(element)
  },
}
