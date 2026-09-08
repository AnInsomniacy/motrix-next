<script setup lang="ts">
/** Fade out, then fade in semantic text changes without remounting the card. */
defineProps<{ value: string }>()
</script>

<template>
  <span class="task-text-transition">
    <Transition name="task-text" mode="out-in">
      <span :key="value" class="task-text-transition-content"><slot /></span>
    </Transition>
  </span>
</template>

<style scoped>
.task-text-transition {
  display: inline-flex;
  min-width: 0;
  vertical-align: top;
}
.task-text-transition-content {
  display: flex;
  align-items: center;
  min-width: 0;
}
.task-text-enter-active {
  transition: opacity var(--task-motion-enter) var(--task-motion-ease);
}
.task-text-leave-active {
  transition: opacity var(--task-motion-leave) var(--task-motion-ease);
  pointer-events: none;
}
.task-text-enter-from,
.task-text-leave-to {
  opacity: 0;
}
</style>
