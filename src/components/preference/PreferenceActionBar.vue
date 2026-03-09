<script setup lang="ts">
/** @fileoverview Shared save/discard/restore action bar for preference pages. */
import { useI18n } from 'vue-i18n'
import { NButton, NSpace } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'

defineProps<{ isDirty: boolean }>()
defineEmits<{ save: []; discard: []; restore: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="form-actions">
    <NSpace :size="12">
      <NButton :class="{ 'save-btn-dirty': isDirty }" type="primary" @click="$emit('save')">
        {{ t('preferences.save') }}
      </NButton>
      <NButton :class="{ 'discard-btn-dirty': isDirty }" @click="$emit('discard')">
        {{ t('preferences.discard') }}
      </NButton>
    </NSpace>
    <NButton class="restore-btn" quaternary size="small" @click="$emit('restore')">
      <template #icon>
        <RefreshOutline />
      </template>
      {{ t('preferences.restore-defaults') }}
    </NButton>
  </div>
</template>

<style scoped>
.form-actions {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 16px 24px 16px 40px;
}

/* ── Restore Defaults — M3 Standard easing (0.2, 0, 0, 1) ──────── */
/* Transition all visual properties together for a smooth hover feel */
.restore-btn {
  color: var(--m3-outline);
  font-size: var(--font-size-xs);
  transition:
    color 0.2s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
  opacity: 0.7;
}
.restore-btn:hover {
  color: var(--m3-error);
  opacity: 1;
}

/* ── Save — dirty state with M3 emphasized enter (0.2, 0, 0, 1) ── */
.save-btn-dirty {
  background-color: var(--m3-success) !important;
  transition:
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.save-btn-dirty :deep(.n-button__border) {
  border-color: var(--m3-success) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.save-btn-dirty :deep(.n-button__state-border) {
  border-color: var(--m3-success) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

/* ── Discard — dirty state ────────────────────────────────────── */
.discard-btn-dirty {
  background-color: var(--m3-error) !important;
  color: var(--m3-on-error) !important;
  transition:
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.discard-btn-dirty :deep(.n-button__border) {
  border-color: var(--m3-error) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.discard-btn-dirty :deep(.n-button__state-border) {
  border-color: var(--m3-error) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
</style>
