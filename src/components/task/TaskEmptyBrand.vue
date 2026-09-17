<script setup lang="ts">
defineProps<{ show: boolean }>()
</script>

<template>
  <Transition name="empty-brand">
    <div v-if="show" class="empty-brand" aria-hidden="true">
      <div class="empty-brand-mark" />
    </div>
  </Transition>
</template>

<style scoped>
.empty-brand {
  --empty-brand-enter-duration: 240ms;
  --empty-brand-leave-duration: 160ms;
  --empty-brand-easing: cubic-bezier(0.2, 0, 0, 1);
  position: absolute;
  inset: 16px 36px 70px;
  display: grid;
  place-items: center;
  container-type: size;
  pointer-events: none;
  user-select: none;
}
.empty-brand-mark {
  width: min(clamp(180px, 36cqw, 280px), 80cqw, 80cqh);
  aspect-ratio: 1;
  background: color-mix(in srgb, var(--m3-on-surface-variant) 85%, var(--m3-primary));
  opacity: 0.12;
  mask: url('/logo.svg') center / contain no-repeat;
  mask-mode: alpha;
}
.empty-brand-enter-active {
  transition: opacity var(--empty-brand-enter-duration) var(--empty-brand-easing);
}
.empty-brand-leave-active {
  transition: opacity var(--empty-brand-leave-duration) var(--empty-brand-easing);
}
.empty-brand-enter-from,
.empty-brand-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .empty-brand-enter-active,
  .empty-brand-leave-active {
    transition-duration: 1ms;
  }
}
</style>
