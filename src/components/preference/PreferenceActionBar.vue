<script setup lang="ts">
/** @fileoverview Shared save/discard/restart action bar for preference pages. */
import { useI18n } from 'vue-i18n'
import { NButton, NSpace, NIcon } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'

defineProps<{ isDirty: boolean }>()
defineEmits<{ save: []; discard: []; restart: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="form-actions">
    <NSpace :size="12" align="center">
      <NButton :class="{ 'save-btn-dirty': isDirty }" type="primary" @click="$emit('save')">
        {{ t('preferences.save') }}
      </NButton>
      <NButton :class="{ 'discard-btn-dirty': isDirty }" @click="$emit('discard')">
        {{ t('preferences.discard') }}
      </NButton>
    </NSpace>
    <NButton class="restart-engine-action-btn" @click="$emit('restart')">
      <template #icon>
        <NIcon :size="16"><RefreshOutline /></NIcon>
      </template>
      {{ t('preferences.engine-restart-btn') }}
    </NButton>
  </div>
</template>

<style scoped>
.form-actions {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 16px 24px 16px 40px;
}

/* ── Restart Engine — muted blue-gray cautionary button ─────────── */
/* Same size/shape as Save & Discard but with extra left gap (32px)  */
/* from the NSpace group. Blue-gray conveys "available maintenance   */
/* action" without the alarm of amber/warning or red/error colors.   */
.restart-engine-action-btn {
  --btn-muted: #8898aa;
  --btn-muted-bg: color-mix(in srgb, #8898aa 10%, transparent);
  --btn-muted-hover: #9aacbe;
  color: var(--btn-muted) !important;
  border-color: var(--btn-muted) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    transform 0.15s cubic-bezier(0.2, 0, 0, 1);
}
.restart-engine-action-btn:hover {
  color: var(--btn-muted-hover) !important;
  background-color: var(--btn-muted-bg) !important;
}
.restart-engine-action-btn:active {
  transform: scale(0.97);
}
.restart-engine-action-btn :deep(.n-button__border) {
  border-color: var(--btn-muted) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.restart-engine-action-btn :deep(.n-button__state-border) {
  border-color: var(--btn-muted) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
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

/* ── Discard — dirty state (error-container tonal fill) ─────────── */
.discard-btn-dirty {
  background-color: var(--m3-error-container) !important;
  color: var(--m3-error) !important;
  transition:
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.discard-btn-dirty :deep(.n-button__border) {
  border-color: var(--m3-error-container) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.discard-btn-dirty :deep(.n-button__state-border) {
  border-color: var(--m3-error-container) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
</style>
