<script setup lang="ts">
/** @fileoverview In-card drag rail used by SortableJS task ordering. */
</script>

<template>
  <span class="task-drag-handle" role="button" tabindex="0" aria-label="Drag task">
    <span class="task-drag-dots" aria-hidden="true">⋮⋮</span>
  </span>
</template>

<style scoped>
.task-drag-handle {
  height: 100%;
  min-height: 0;
  border: none;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--m3-on-surface) 7%, transparent), transparent 76%),
    linear-gradient(180deg, color-mix(in srgb, var(--m3-on-surface) 3%, transparent), transparent 46%),
    color-mix(in srgb, var(--task-item-bg) 94%, var(--m3-on-surface) 6%);
  color: var(--m3-outline);
  cursor: grab;
  opacity: 0.52;
  font-size: 15px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  border-right: 1px solid color-mix(in srgb, var(--m3-outline-variant) 54%, transparent);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--m3-on-surface) 3%, transparent);
  transition:
    opacity 0.16s cubic-bezier(0.2, 0, 0, 1),
    color 0.16s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.16s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.16s cubic-bezier(0.2, 0, 0, 1);
}
.task-drag-handle:hover {
  color: color-mix(in srgb, var(--m3-primary) 75%, var(--m3-outline));
  opacity: 0.96;
  border-right-color: color-mix(in srgb, var(--m3-primary) 46%, transparent);
  background-color: color-mix(in srgb, var(--m3-primary) 12%, var(--task-item-bg));
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--m3-primary) 18%, transparent);
}
.task-drag-handle:active {
  cursor: grabbing;
}
.task-drag-dots {
  transform: translateX(-1px);
  letter-spacing: -1px;
}
</style>
