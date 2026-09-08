<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NModal, NSpin } from 'naive-ui'
import { CheckmarkCircleOutline, CheckmarkOutline, CloseCircleOutline } from '@vicons/ionicons5'
import { useEngineStore, type EnginePhase } from '@/stores/engine'
import { useAppMessage } from '@/composables/useAppMessage'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { logger } from '@shared/logger'
import { ENGINE_RECOVERY_SUCCESS_DURATION } from '@shared/timing'

type PanelState = 'recovering' | 'cleaning' | 'failed' | 'complete'
type RecoveryStageState = 'complete' | 'active' | 'pending'

interface RecoveryStage {
  label: string
  state: RecoveryStageState
}

const { t } = useI18n()
const engineStore = useEngineStore()
const message = useAppMessage()
const pendingAction = ref<'cancel' | 'retry' | 'cleanup' | null>(null)
const visible = ref(false)
const completed = ref(false)
let successTimer: ReturnType<typeof setTimeout> | null = null

const failed = computed(() => engineStore.snapshot.phase === 'failed')
const cleaning = computed(() => engineStore.snapshot.phase === 'cleaning')
const panelState = computed<PanelState>(() => {
  if (completed.value) return 'complete'
  if (failed.value) return 'failed'
  if (cleaning.value) return 'cleaning'
  return 'recovering'
})
const title = computed(() =>
  engineStore.snapshot.cause === 'runtimeCrash' ? t('app.engine-crashed') : t('app.engine-failed'),
)
const attemptText = computed(() => {
  const { attempt, maxAttempts } = engineStore.snapshot
  return `${attempt} / ${maxAttempts}`
})
const failureDetail = computed(() => {
  const failure = engineStore.snapshot.failure
  if (!failure) return ''
  const stderr = failure.stderrTail.map((line) => line.trim()).filter((line) => line && line !== 'Exception caught')
  return stderr.length > 0 ? stderr[stderr.length - 1] : failure.message
})
const activeStage = computed(() => {
  const phase: EnginePhase = engineStore.snapshot.phase
  if (phase === 'starting') return 1
  if (phase === 'probing' || phase === 'initializing' || phase === 'stabilizing') return 2
  return 0
})
const activeStageLabel = computed(
  () => [t('app.engine-stage-stop'), t('app.engine-stage-start'), t('app.engine-stage-verify')][activeStage.value],
)
const recoveryStages = computed<RecoveryStage[]>(() =>
  [t('app.engine-stage-stop'), t('app.engine-stage-start'), t('app.engine-stage-verify')].map((label, index) => ({
    label,
    state: index < activeStage.value ? 'complete' : index === activeStage.value ? 'active' : 'pending',
  })),
)

function clearSuccessTimer() {
  if (successTimer === null) return
  clearTimeout(successTimer)
  successTimer = null
}

function scheduleSuccessDismissal() {
  clearSuccessTimer()
  void nextTick(() => {
    if (!visible.value || !completed.value) return
    successTimer = setTimeout(() => {
      visible.value = false
      completed.value = false
      successTimer = null
    }, ENGINE_RECOVERY_SUCCESS_DURATION)
  })
}

watch(
  () => engineStore.showStatusDialog,
  (show) => {
    if (show) {
      clearSuccessTimer()
      visible.value = true
      completed.value = false
    }
  },
  { immediate: true, flush: 'sync' },
)

watch(
  () => engineStore.snapshot.phase,
  (phase) => {
    if (phase === 'running' && visible.value) {
      completed.value = true
      scheduleSuccessDismissal()
      return
    }
    if (phase === 'stopped') {
      clearSuccessTimer()
      visible.value = false
      completed.value = false
    }
  },
  { flush: 'sync' },
)

onBeforeUnmount(clearSuccessTimer)

async function cancel() {
  if (pendingAction.value) return
  pendingAction.value = 'cancel'
  try {
    await engineStore.cancel()
  } catch (error) {
    message.error(getErrorMessage(error))
  } finally {
    pendingAction.value = null
  }
}

async function retry() {
  if (pendingAction.value) return
  pendingAction.value = 'retry'
  try {
    await engineStore.ensureRunning('failureRetry')
  } catch (error) {
    logger.warn('EngineRecovery.retry', getErrorMessage(error))
  } finally {
    pendingAction.value = null
  }
}

async function cleanupAndRetry() {
  if (pendingAction.value) return
  pendingAction.value = 'cleanup'
  try {
    await engineStore.recoverRuntimeState()
  } catch (error) {
    logger.warn('EngineRecovery.cleanup', getErrorMessage(error))
  } finally {
    pendingAction.value = null
  }
}
</script>

<template>
  <NModal :show="visible" :mask-closable="false" :close-on-esc="false" transform-origin="center">
    <section class="engine-dialog" :data-state="panelState" aria-live="polite">
      <div class="engine-panel-viewport">
        <Transition name="engine-panel" mode="out-in">
          <div :key="panelState" class="engine-panel-state" :data-panel="panelState">
            <template v-if="panelState === 'recovering'">
              <div class="engine-heading-row">
                <NSpin size="small" />
                <div>
                  <h2>{{ t('app.engine-recovering') }}</h2>
                  <p class="engine-attempt">{{ t('app.engine-attempt') }} {{ attemptText }}</p>
                </div>
              </div>

              <TransitionGroup name="engine-recovery-content" tag="div" class="engine-recovery-body">
                <div key="stages" class="engine-stage-track" role="list" :aria-label="activeStageLabel">
                  <template v-for="(stage, index) in recoveryStages" :key="stage.label">
                    <div
                      class="engine-recovery-stage"
                      :data-state="stage.state"
                      role="listitem"
                      :aria-current="stage.state === 'active' ? 'step' : undefined"
                    >
                      <span class="engine-stage-marker">
                        <span class="engine-stage-dot" />
                        <NIcon class="engine-stage-check" :size="22">
                          <CheckmarkCircleOutline />
                        </NIcon>
                      </span>
                      <span class="engine-stage-label">{{ stage.label }}</span>
                    </div>
                    <span
                      v-if="index < recoveryStages.length - 1"
                      class="engine-stage-connector"
                      :data-complete="index < activeStage"
                      aria-hidden="true"
                    />
                  </template>
                </div>

                <div v-if="failureDetail" key="error" class="engine-error-block">
                  <span class="engine-error-label">{{ t('app.engine-last-error') }}</span>
                  <code>{{ failureDetail }}</code>
                </div>
              </TransitionGroup>
            </template>

            <template v-else-if="panelState === 'cleaning'">
              <div class="engine-heading-row">
                <NSpin size="small" />
                <h2>{{ t('app.engine-cleaning') }}</h2>
              </div>
              <p class="engine-description">{{ t('app.engine-cleaning-description') }}</p>
            </template>

            <template v-else-if="panelState === 'failed'">
              <div class="engine-heading-row engine-heading-row--error">
                <NIcon :size="24"><CloseCircleOutline /></NIcon>
                <div>
                  <h2>{{ title }}</h2>
                  <p>{{ t('app.engine-unrecoverable') }}</p>
                  <p class="engine-attempt">{{ t('app.engine-attempt') }} {{ attemptText }}</p>
                </div>
              </div>

              <div v-if="failureDetail" class="engine-error-block">
                <span class="engine-error-label">{{ t('app.engine-last-error') }}</span>
                <code>{{ failureDetail }}</code>
              </div>

              <p class="engine-cleanup-warning">{{ t('app.engine-cleanup-warning') }}</p>
            </template>

            <template v-else>
              <div class="engine-complete">
                <div class="engine-success-mark" aria-hidden="true">
                  <span class="engine-success-halo" />
                  <NIcon :size="38"><CheckmarkOutline /></NIcon>
                </div>
                <div class="engine-complete-copy">
                  <h2>{{ t('preferences.engine-restarted') }}</h2>
                  <p>{{ t('app.engine-recovered-description') }}</p>
                </div>
              </div>
            </template>
          </div>
        </Transition>
      </div>

      <footer class="engine-dialog-footer">
        <Transition name="engine-actions" mode="out-in">
          <div v-if="panelState === 'recovering'" key="recovering" class="engine-footer-state">
            <NButton :loading="pendingAction === 'cancel'" :disabled="pendingAction !== null" @click="cancel">
              {{ t('app.cancel') }}
            </NButton>
          </div>

          <div v-else-if="panelState === 'failed'" key="failed" class="engine-footer-state engine-footer-state--failed">
            <NButton :loading="pendingAction === 'cancel'" :disabled="pendingAction !== null" @click="cancel">
              {{ t('app.cancel') }}
            </NButton>
            <div class="engine-dialog-actions">
              <NButton :loading="pendingAction === 'retry'" :disabled="pendingAction !== null" @click="retry">
                {{ t('app.engine-manual-retry') }}
              </NButton>
              <NButton
                type="primary"
                :loading="pendingAction === 'cleanup'"
                :disabled="pendingAction !== null"
                @click="cleanupAndRetry"
              >
                {{ t('app.engine-reset-state') }}
              </NButton>
            </div>
          </div>

          <div v-else :key="panelState" class="engine-footer-state" />
        </Transition>
      </footer>
    </section>
  </NModal>
</template>

<style scoped>
.engine-dialog {
  width: min(520px, calc(100vw - 40px));
  height: min(440px, calc(100vh - 40px));
  overflow: hidden;
  display: grid;
  grid-template-rows: minmax(0, 1fr) 82px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 16px;
  color: var(--m3-on-surface);
  background: var(--m3-surface-container-high);
  box-shadow: 0 18px 56px var(--m3-shadow);
}

.engine-dialog[data-state='complete'] {
  border-color: transparent;
}

.engine-error-label {
  color: var(--m3-on-surface-variant);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.engine-heading-row .engine-attempt {
  margin-top: 7px;
  color: var(--m3-primary);
  font-size: 14px;
  font-weight: 650;
  line-height: 1.35;
}

.engine-panel-viewport {
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.engine-panel-state {
  position: absolute;
  inset: 0;
  overflow: auto;
  padding: 30px 24px 24px;
}

.engine-heading-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.engine-heading-row h2,
.engine-complete h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  line-height: 1.35;
}

.engine-heading-row p,
.engine-complete p,
.engine-description {
  margin: 4px 0 0;
  color: var(--m3-on-surface-variant);
  line-height: 1.55;
}

.engine-heading-row--error {
  align-items: flex-start;
  color: var(--m3-error);
}

.engine-heading-row--error p {
  color: var(--m3-on-surface-variant);
}

.engine-panel-state[data-panel='recovering'] {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.engine-recovery-body {
  display: grid;
  min-height: 0;
  align-content: center;
  gap: 26px;
}

.engine-recovery-content-move,
.engine-recovery-content-enter-active,
.engine-recovery-content-leave-active {
  transition:
    opacity 0.28s cubic-bezier(0.2, 0, 0, 1),
    transform 0.34s cubic-bezier(0.2, 0, 0, 1);
}

.engine-recovery-content-enter-from,
.engine-recovery-content-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.engine-stage-track {
  display: grid;
  grid-template-columns: auto minmax(24px, 1fr) auto minmax(24px, 1fr) auto;
  align-items: start;
}

.engine-recovery-stage {
  display: grid;
  min-width: 74px;
  justify-items: center;
  gap: 9px;
}

.engine-stage-marker {
  position: relative;
  z-index: 1;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
}

.engine-stage-marker > * {
  grid-area: 1 / 1;
}

.engine-stage-dot {
  width: 10px;
  height: 10px;
  border: 2px solid var(--m3-outline);
  border-radius: 50%;
  background: var(--m3-surface-container-high);
  transition:
    opacity 0.24s cubic-bezier(0.2, 0, 0, 1),
    transform 0.28s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.28s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.28s cubic-bezier(0.2, 0, 0, 1);
}

.engine-recovery-stage[data-state='active'] .engine-stage-dot {
  border-color: var(--m3-primary);
  background: var(--m3-primary);
  animation: engine-stage-pulse 1.8s cubic-bezier(0.2, 0, 0, 1) infinite;
}

.engine-stage-check {
  color: var(--m3-success);
  opacity: 0;
  transform: scale(0.7);
  transition:
    opacity 0.24s cubic-bezier(0.2, 0, 0, 1),
    transform 0.28s cubic-bezier(0.2, 0, 0, 1);
}

.engine-recovery-stage[data-state='complete'] .engine-stage-dot {
  opacity: 0;
  transform: scale(1.35);
}

.engine-recovery-stage[data-state='complete'] .engine-stage-check {
  opacity: 1;
  transform: scale(1);
}

.engine-stage-label {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  text-align: center;
  transition:
    color 0.28s cubic-bezier(0.2, 0, 0, 1),
    font-weight 0.28s cubic-bezier(0.2, 0, 0, 1);
}

.engine-recovery-stage[data-state='active'] .engine-stage-label {
  color: var(--m3-primary);
  font-weight: 650;
}

.engine-recovery-stage[data-state='pending'] .engine-stage-label {
  color: var(--m3-outline);
}

.engine-stage-connector {
  position: relative;
  height: 2px;
  overflow: hidden;
  margin-top: 11px;
  border-radius: 1px;
  background: var(--m3-outline-variant);
}

.engine-stage-connector::after {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--m3-success);
  content: '';
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 0.34s cubic-bezier(0.2, 0, 0, 1);
}

.engine-stage-connector[data-complete='true']::after {
  transform: scaleX(1);
}

.engine-panel-state[data-panel='recovering'] .engine-error-block {
  width: min(100%, 430px);
  box-sizing: border-box;
  margin: 0 auto;
}

.engine-error-block {
  display: grid;
  gap: 8px;
  margin-top: 26px;
  padding: 13px 15px;
  border: 1px solid color-mix(in srgb, var(--m3-error) 30%, var(--m3-outline-variant));
  border-radius: 10px;
  background: color-mix(in srgb, var(--m3-error) 7%, var(--m3-surface-container));
}

.engine-error-block code {
  overflow-wrap: anywhere;
  color: var(--m3-on-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.engine-cleanup-warning {
  margin: 18px 0 0;
  color: var(--m3-on-surface-variant);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-line;
}

.engine-complete {
  display: flex;
  height: 100%;
  align-items: center;
  flex-direction: column;
  justify-content: center;
  gap: 20px;
  text-align: center;
}

.engine-success-mark {
  position: relative;
  display: grid;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  color: var(--m3-on-success-container);
  background: var(--m3-success-container);
  place-items: center;
  animation: engine-success-arrive 0.56s cubic-bezier(0.2, 0, 0, 1) both;
}

.engine-success-halo {
  position: absolute;
  inset: -9px;
  border: 1px solid color-mix(in srgb, var(--m3-success) 45%, transparent);
  border-radius: 50%;
  animation: engine-success-halo 0.72s cubic-bezier(0.2, 0, 0, 1) both;
}

.engine-complete-copy {
  display: grid;
  max-width: 360px;
  gap: 6px;
}

.engine-complete p {
  margin: 0;
  color: var(--m3-on-surface-variant);
}

.engine-description {
  margin-top: 16px;
}

.engine-dialog-footer {
  position: relative;
  display: flex;
  align-items: center;
  padding: 16px 24px;
  border-top: 1px solid var(--m3-outline-variant);
  transition: border-color 0.24s cubic-bezier(0.2, 0, 0, 1);
}

.engine-dialog[data-state='complete'] .engine-dialog-footer {
  border-top-color: transparent;
}

.engine-footer-state {
  position: absolute;
  inset: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.engine-footer-state--failed {
  justify-content: space-between;
}

.engine-dialog-actions {
  display: flex;
  gap: 10px;
}

.engine-panel-enter-active,
.engine-panel-leave-active,
.engine-actions-enter-active,
.engine-actions-leave-active {
  transition:
    opacity 0.24s cubic-bezier(0.2, 0, 0, 1),
    transform 0.24s cubic-bezier(0.2, 0, 0, 1);
}

.engine-panel-enter-active[data-panel='complete'] {
  transition-duration: 0.36s;
}

.engine-panel-enter-from,
.engine-actions-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.engine-panel-leave-to,
.engine-actions-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@keyframes engine-stage-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--m3-primary) 30%, transparent);
    transform: scale(0.94);
  }

  50% {
    box-shadow: 0 0 0 7px color-mix(in srgb, var(--m3-primary) 0%, transparent);
    transform: scale(1);
  }
}

@keyframes engine-success-arrive {
  from {
    opacity: 0;
    transform: scale(0.76) rotate(-8deg);
  }

  to {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
}

@keyframes engine-success-halo {
  from {
    opacity: 0;
    transform: scale(0.72);
  }

  55% {
    opacity: 1;
  }

  to {
    opacity: 0.55;
    transform: scale(1);
  }
}

@media (max-width: 560px) {
  .engine-dialog {
    height: min(500px, calc(100vh - 24px));
  }

  .engine-footer-state--failed {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .engine-dialog-actions {
    flex-direction: column;
  }
}
</style>
