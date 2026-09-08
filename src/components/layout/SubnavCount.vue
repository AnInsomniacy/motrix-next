<script setup lang="ts">
/** @fileoverview Animated numeric counter for secondary navigation rows. */
import { computed } from 'vue'
import { TransitionPresets, usePreferredReducedMotion, useTransition } from '@vueuse/core'

const props = defineProps<{
  value: number
}>()

const reducedMotion = usePreferredReducedMotion()
const target = computed(() => Math.max(0, Math.floor(Number.isFinite(props.value) ? props.value : 0)))
const animated = useTransition(target, {
  duration: 220,
  easing: TransitionPresets.easeOutCubic,
  disabled: computed(() => reducedMotion.value === 'reduce'),
})
const display = computed(() => Math.round(animated.value).toLocaleString())
</script>

<template>
  <span class="subnav-count" aria-hidden="true">
    {{ display }}
  </span>
</template>

<style scoped>
.subnav-count {
  flex: 0 0 auto;
  min-width: 2.25em;
  margin-left: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  text-align: center;
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  color: var(--m3-on-surface-variant);
  background: color-mix(in srgb, var(--m3-on-surface) 7%, transparent);
  transition:
    color 0.2s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    transform 0.2s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.16s cubic-bezier(0.2, 0, 0, 1);
}
</style>
