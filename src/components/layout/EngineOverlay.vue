<script setup lang="ts">
/**
 * @fileoverview Engine crash recovery dialog.
 *
 * Displayed when the aria2 engine process terminates unexpectedly.
 * Matches UpdateDialog styling: NModal + phase-switch + icon-wrap + fixed footer.
 *
 * Three phases:
 *  - recovering: auto-restart in progress with attempt counter
 *  - recovered:  engine restored — auto-dismiss after brief delay
 *  - failed:     all retries exhausted — manual retry available
 *
 * The dialog is CLOSABLE — dismissing it lets the user continue in a degraded
 * state (no download engine).  A warning toast is shown on close.
 */
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NButton, NIcon, NText, NSpin } from 'naive-ui'
import { CheckmarkCircleOutline, CloseCircleOutline } from '@vicons/ionicons5'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { logger } from '@shared/logger'
import { ENGINE_RPC_PORT } from '@shared/constants'

const MAX_RETRIES = 3

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  recovered: []
  close: []
}>()

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()
const { restartEngine } = useEngineRestart()

type Phase = 'recovering' | 'recovered' | 'failed'
const phase = ref<Phase>('recovering')
const attempt = ref(0)
const statusKey = ref<'engine-recovering' | 'engine-verifying-stability'>('engine-recovering')
const rpcPort = computed(() => Number(preferenceStore.config.rpcListenPort) || ENGINE_RPC_PORT)

// ── Button label state machines ───────────────────────────────────────
const dismissLabel = computed(() => (phase.value === 'recovering' ? 'app.cancel' : 'app.close'))
const actionLabel = computed(() => {
  switch (phase.value) {
    case 'recovering':
      return 'app.engine-retrying'
    case 'failed':
      return 'app.engine-manual-retry'
    case 'recovered':
      return 'app.engine-recovered'
  }
  return 'app.engine-retrying'
})
const actionType = computed<'default' | 'primary' | 'success'>(() => {
  switch (phase.value) {
    case 'recovering':
      return 'default'
    case 'failed':
      return 'primary'
    case 'recovered':
      return 'success'
  }
  return 'default'
})
const actionDisabled = computed(() => phase.value !== 'failed')

/** Attempt engine recovery with exponential backoff. */
async function attemptRecovery() {
  phase.value = 'recovering'
  attempt.value = 0

  for (let i = 0; i < MAX_RETRIES; i++) {
    attempt.value = i + 1

    // Exponential backoff: 1s, 2s, 4s
    const delay = 1000 * 2 ** i
    await new Promise((r) => setTimeout(r, delay))

    const port = Number(preferenceStore.config.rpcListenPort) || ENGINE_RPC_PORT
    const secret = preferenceStore.config.rpcSecret || ''

    statusKey.value = 'engine-recovering'
    const restartStart = Date.now()
    const ok = await restartEngine({ port, secret })
    if (ok === false) {
      // Already restarting — wait and retry
      continue
    }

    // Ensure "Restarting aria2..." is visible for at least 500ms to prevent flicker
    const MIN_DISPLAY = 500
    const elapsed = Date.now() - restartStart
    if (elapsed < MIN_DISPLAY) {
      await new Promise((r) => setTimeout(r, MIN_DISPLAY - elapsed))
    }

    // Check if engine actually recovered — with stability window.
    // Wait 2s after restart to confirm aria2 doesn't immediately crash again.
    const { useAppStore } = await import('@/stores/app')
    const appStore = useAppStore()
    if (appStore.engineReady) {
      statusKey.value = 'engine-verifying-stability'
      const STABILITY_WINDOW = 5000
      await new Promise((r) => setTimeout(r, STABILITY_WINDOW))

      if (appStore.engineReady) {
        phase.value = 'recovered'
        logger.info('EngineOverlay', `recovered on attempt ${attempt.value} (stable)`)
        setTimeout(() => {
          emit('recovered')
        }, 1500)
        return
      }
      // aria2 crashed during stability window — treat as failed attempt
      statusKey.value = 'engine-recovering'
      logger.warn('EngineOverlay', `attempt ${attempt.value} unstable — aria2 crashed within ${STABILITY_WINDOW}ms`)
    }
  }

  // All retries exhausted
  phase.value = 'failed'
  logger.error('EngineOverlay', `all ${MAX_RETRIES} recovery attempts failed`)
}

/** Manual retry button handler. */
async function retry() {
  await attemptRecovery()
}

/** Close dialog — warn user only if engine is still down. */
function dismiss() {
  if (phase.value !== 'recovered') {
    message.warning(t('app.engine-dismiss-warning'))
  }
  emit('close')
}

// Start recovery automatically when dialog becomes visible.
watch(
  () => props.show,
  async (visible) => {
    if (visible) {
      // Reset state synchronously to avoid stale green flash from previous recovery
      phase.value = 'recovering'
      statusKey.value = 'engine-recovering'
      attempt.value = 0
      await nextTick()
      await attemptRecovery()
    }
  },
)
</script>

<template>
  <NModal
    :show="show"
    mask-closable
    close-on-esc
    transform-origin="center"
    @update:show="
      (v: boolean) => {
        if (!v) dismiss()
      }
    "
  >
    <div class="engine-dialog">
      <div class="engine-dialog-header">
        <span class="engine-dialog-title">{{ t('app.engine-crashed') }}</span>
        <button class="engine-dialog-close" @click="dismiss">×</button>
      </div>
      <div class="engine-dialog-body">
        <Transition name="phase-switch" mode="out-in">
          <!-- Recovering -->
          <div v-if="phase === 'recovering'" key="recovering" class="engine-phase">
            <NSpin size="medium" />
            <Transition name="status-text" mode="out-in">
              <NText :key="statusKey" class="engine-main-text">{{ t(`app.${statusKey}`) }}</NText>
            </Transition>
            <div class="engine-attempt-counter">
              {{ t('app.engine-retry') }}
              <Transition name="status-text" mode="out-in">
                <span :key="attempt" class="engine-attempt-num">{{ attempt }}</span>
              </Transition>
              / {{ MAX_RETRIES }}
            </div>
          </div>

          <!-- Recovered -->
          <div v-else-if="phase === 'recovered'" key="recovered" class="engine-phase">
            <div class="engine-icon-wrap engine-icon-success">
              <NIcon :size="40"><CheckmarkCircleOutline /></NIcon>
            </div>
            <NText class="engine-main-text">{{ t('app.engine-recovered') }}</NText>
          </div>

          <!-- Failed -->
          <div v-else-if="phase === 'failed'" key="failed" class="engine-phase">
            <div class="engine-icon-wrap engine-icon-error">
              <NIcon :size="40"><CloseCircleOutline /></NIcon>
            </div>
            <NText class="engine-main-text">{{ t('app.engine-unrecoverable') }}</NText>
            <div class="engine-warning-box">
              <NText depth="3" class="engine-hint engine-port-hint">
                {{ t('app.engine-port-conflict-hint', { port: rpcPort }) }}
              </NText>
            </div>
          </div>
        </Transition>
      </div>
      <div class="engine-dialog-footer">
        <NButton style="min-width: 120px" @click="dismiss">
          <Transition name="status-text" mode="out-in">
            <span :key="dismissLabel">{{ t(dismissLabel) }}</span>
          </Transition>
        </NButton>
        <NButton
          class="action-btn"
          :type="actionType"
          style="min-width: 140px"
          :disabled="actionDisabled"
          @click="retry"
        >
          <Transition name="status-text" mode="out-in">
            <span :key="actionLabel">{{ t(actionLabel) }}</span>
          </Transition>
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.engine-dialog {
  width: min(420px, calc(100vw - 24px));
  background: var(--m3-surface-container-high);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 12px 40px var(--m3-shadow);
}
.engine-dialog-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 0;
}
.engine-dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--m3-on-surface);
}
.engine-dialog-close {
  background: none;
  border: none;
  color: var(--m3-outline);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  opacity: 0.5;
  transition: opacity 0.2s;
}
.engine-dialog-close:hover {
  opacity: 1;
}
.engine-dialog-body {
  position: relative;
  padding: 30px 30px 20px;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.engine-dialog-footer {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 16px 30px 22px;
  border-top: 1px solid var(--m3-outline-variant);
}
.engine-phase {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  width: 100%;
}
.engine-icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}
.engine-icon-success {
  background: color-mix(in srgb, var(--m3-success) 12%, transparent);
  color: var(--m3-success);
}
.engine-icon-error {
  background: color-mix(in srgb, var(--m3-error) 12%, transparent);
  color: var(--m3-error);
}
.engine-main-text {
  font-size: 15px;
  font-weight: 600;
}
.engine-hint {
  font-size: 12px;
}
.engine-port-hint {
  display: block;
  white-space: pre-line;
}
.engine-attempt-counter {
  font-size: 14px;
  font-weight: 500;
  color: var(--m3-on-surface-variant);
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.engine-attempt-num {
  display: inline-block;
  font-weight: 700;
  font-size: 16px;
  color: var(--m3-on-surface);
  min-width: 1em;
  text-align: center;
}
.engine-warning-box {
  background: color-mix(in srgb, var(--m3-error) 6%, transparent);
  border-radius: 8px;
  padding: 14px 16px;
  max-width: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Phase switch transitions (same as UpdateDialog) */
.phase-switch-enter-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}
.phase-switch-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.phase-switch-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.phase-switch-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Status text transitions within recovering phase */
.status-text-enter-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.status-text-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.status-text-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.status-text-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* Action button — smooth transition for type/disabled changes */
.action-btn {
  transition: all 0.35s ease;
}
</style>
