<script setup lang="ts">
/** @fileoverview Application update notification dialog with channel support. */
import { marked } from 'marked'
import markedAlert from 'marked-alert'
import DOMPurify from 'dompurify'

// Register GitHub-style alert blocks: [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]
marked.use(markedAlert())
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NButton, NProgress, NIcon, NText, NSpin, NTag } from 'naive-ui'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { relaunch } from '@tauri-apps/plugin-process'
import { getVersion } from '@tauri-apps/api/app'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  ArrowUpCircleOutline,
  ArrowDownCircleOutline,
  CloudDownloadOutline,
} from '@vicons/ionicons5'
import { usePreferenceStore } from '@/stores/preference'
import { logger } from '@shared/logger'
import type { ResolvedUpdateChannel, TauriUpdate, UpdateChannel } from '@shared/types'
import {
  isActionDisabled,
  getActionLabel,
  getActionType,
  getActionTarget,
  resolvePhaseAfterDownload,
  shouldAllowUpdateDialogClose,
  calcProgressPercent,
  bytesToMB,
  getUpdateProxy as resolveProxy,
  formatUpdateError,
  type DownloadUpdateResult,
} from '@/composables/useUpdateFlow'

interface UpdateProgressStarted {
  event: 'Started'
  data: { content_length: number }
}
interface UpdateProgressChunk {
  event: 'Progress'
  data: { chunk_length: number; downloaded: number }
}
interface UpdateProgressFinished {
  event: 'Finished'
}
type UpdateProgressEvent = UpdateProgressStarted | UpdateProgressChunk | UpdateProgressFinished

const { t } = useI18n()
const preferenceStore = usePreferenceStore()

const show = ref(false)
const phase = ref<'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'>(
  'checking',
)
const version = ref('')
const currentVersion = ref('')
const releaseNotes = ref('')
const sanitizedReleaseNotesHtml = computed(() => {
  if (!releaseNotes.value) return ''
  const raw = marked.parse(releaseNotes.value, { async: false }) as string
  // Allow SVG elements used by marked-alert icons
  return DOMPurify.sanitize(raw, {
    ADD_TAGS: ['svg', 'path'],
    ADD_ATTR: ['viewBox', 'aria-hidden', 'd', 'fill', 'class'],
  })
})
const errorMsg = ref('')
const downloadTotal = ref(0)
const downloadReceived = ref(0)
const downloadCancelled = ref(false)
const activeChannel = ref<ResolvedUpdateChannel>('stable')
const requestedChannel = ref<UpdateChannel>('stable')
let progressUnlisten: UnlistenFn | null = null
let operationId = 0
const dialogClosable = computed(() => shouldAllowUpdateDialogClose(phase.value))
const displayChannel = computed<UpdateChannel>(() =>
  requestedChannel.value === 'latest' ? 'latest' : activeChannel.value,
)
const channelTagType = computed(() => {
  if (displayChannel.value === 'beta') return 'warning'
  if (displayChannel.value === 'latest') return 'info'
  return 'success'
})

const progressPercent = computed(() => calcProgressPercent(downloadReceived.value, downloadTotal.value))

// ── Version direction detection (authoritative comparison done in Rust) ──
const isRollback = ref(false)

// ── Action button state machine ──────────────────────────────────────
const actionDisabled = computed(() => isActionDisabled(phase.value))
const actionLabel = computed(() => getActionLabel(phase.value, isRollback.value))
const actionType = computed(() => getActionType(phase.value))
function handleActionClick() {
  const target = getActionTarget(phase.value)
  if (target === 'download') startDownload()
  else if (target === 'cancel') cancelDownload()
  else if (target === 'install') handleInstallAndRelaunch()
  else if (target === 'retry') open()
}
function getUpdateProxy(): string | null {
  return resolveProxy(preferenceStore.config.proxy)
}

const downloadedMB = computed(() => bytesToMB(downloadReceived.value))
const totalMB = computed(() => bytesToMB(downloadTotal.value))

async function open(channel?: string) {
  const currentOperationId = ++operationId
  const ch = (channel || preferenceStore.config.updateChannel || 'stable') as UpdateChannel
  requestedChannel.value = ch
  activeChannel.value = ch === 'beta' ? 'beta' : 'stable'
  show.value = true
  phase.value = 'checking'
  logger.info('Updater', `checking channel=${ch}`)
  version.value = ''
  releaseNotes.value = ''
  errorMsg.value = ''
  downloadTotal.value = 0
  downloadReceived.value = 0
  downloadCancelled.value = false
  currentVersion.value = await getVersion()
  if (currentOperationId !== operationId) return

  try {
    const update = await invoke<TauriUpdate | null>('check_for_update', {
      channel: ch,
      proxy: getUpdateProxy(),
    })
    if (currentOperationId !== operationId) return

    if (update) {
      version.value = update.version
      releaseNotes.value = update.body || ''
      activeChannel.value = update.channel
      requestedChannel.value = update.requestedChannel
      isRollback.value = update.isRollback
      phase.value = 'available'
      logger.info(
        'Updater',
        `update available: v${currentVersion.value} → v${update.version} channel=${update.channel} requested=${update.requestedChannel}`,
      )
    } else {
      logger.info('Updater', `up-to-date v${currentVersion.value}`)
      phase.value = 'up-to-date'
    }
    preferenceStore.updateAndSave({ lastCheckUpdateTime: Date.now() })
  } catch (e) {
    if (currentOperationId !== operationId) return
    logger.error('Updater', e)
    errorMsg.value = formatUpdateError(e)
    phase.value = 'error'
  }
}

async function present(update: TauriUpdate) {
  const currentOperationId = ++operationId
  requestedChannel.value = update.requestedChannel
  activeChannel.value = update.channel
  show.value = true
  phase.value = 'checking'
  version.value = ''
  releaseNotes.value = ''
  errorMsg.value = ''
  downloadTotal.value = 0
  downloadReceived.value = 0
  downloadCancelled.value = false
  currentVersion.value = await getVersion()
  if (currentOperationId !== operationId) return

  version.value = update.version
  releaseNotes.value = update.body || ''
  isRollback.value = update.isRollback
  phase.value = 'available'
}

async function startDownload() {
  phase.value = 'downloading'
  downloadReceived.value = 0
  downloadTotal.value = 0
  downloadCancelled.value = false
  const ch = activeChannel.value
  logger.info('Updater', `downloading v${version.value} channel=${ch}`)

  // Listen for progress events from Rust
  progressUnlisten = await listen<UpdateProgressEvent>('update-progress', (event) => {
    if (downloadCancelled.value) return
    const payload = event.payload
    if (payload.event === 'Started') {
      downloadTotal.value = payload.data.content_length
    } else if (payload.event === 'Progress') {
      downloadReceived.value = payload.data.downloaded
    } else if (payload.event === 'Finished') {
      downloadReceived.value = downloadTotal.value
    }
  })

  try {
    const result = await invoke<DownloadUpdateResult>('download_update', { channel: ch, proxy: getUpdateProxy() })
    if (!downloadCancelled.value) {
      phase.value = resolvePhaseAfterDownload(result.status)
      logger.info('Updater', `download complete: status=${result.status}`)
    }
  } catch (e) {
    if (!downloadCancelled.value) {
      logger.error('Updater', e)
      errorMsg.value = formatUpdateError(e)
      phase.value = 'error'
    }
  } finally {
    progressUnlisten?.()
    progressUnlisten = null
  }
}

function cancelDownload() {
  downloadCancelled.value = true
  phase.value = 'available'
  logger.info('Updater', 'download cancelled by user')
  invoke('cancel_update').catch(() => {
    /* best-effort: Rust side may have already finished */
  })
}

async function handleInstallAndRelaunch() {
  phase.value = 'installing'
  const ch = activeChannel.value
  logger.info('Updater', `applying update v${version.value} channel=${ch}`)
  try {
    await invoke('apply_update', { channel: ch, proxy: getUpdateProxy() })
    relaunch()
  } catch (e) {
    // Engine recovery is owned by the Rust supervisor. This block only
    // manages the update dialog state.
    logger.error('Updater', e)
    errorMsg.value = formatUpdateError(e)
    phase.value = 'error'
  }
}

function close() {
  if (!shouldAllowUpdateDialogClose(phase.value)) {
    return
  }
  operationId += 1
  show.value = false
}

onUnmounted(() => {
  progressUnlisten?.()
})

defineExpose({ open, present })
</script>

<template>
  <NModal
    v-model:show="show"
    :mask-closable="dialogClosable"
    :close-on-esc="dialogClosable"
    transform-origin="center"
    :closable="dialogClosable"
    @update:show="
      (v: boolean) => {
        if (!v) close()
      }
    "
  >
    <section class="update-dialog" :data-phase="phase" aria-live="polite">
      <header class="update-dialog-header">
        <div class="update-dialog-title-group">
          <span class="update-dialog-title">{{ t('preferences.auto-update') }}</span>
          <NTag :type="channelTagType" size="small" round :bordered="false">
            {{ t(`preferences.update-channel-${displayChannel}`) }}
          </NTag>
        </div>
        <button class="update-dialog-close" :disabled="!dialogClosable" :aria-label="t('app.close')" @click="close">
          ×
        </button>
      </header>

      <div class="update-dialog-viewport">
        <Transition name="update-panel">
          <div v-if="phase === 'checking'" key="checking" class="update-panel update-panel--centered">
            <NSpin size="large" />
            <div class="update-copy">
              <h2>{{ t('app.checking-for-updates') }}</h2>
              <p>v{{ currentVersion }}</p>
            </div>
          </div>

          <div v-else-if="phase === 'up-to-date'" key="up-to-date" class="update-panel update-panel--centered">
            <div class="update-status-icon update-status-icon--success">
              <NIcon :size="38"><CheckmarkCircleOutline /></NIcon>
            </div>
            <div class="update-copy">
              <h2>{{ t('preferences.is-latest-version') }}</h2>
              <p>v{{ currentVersion }}</p>
            </div>
          </div>

          <div v-else-if="phase === 'available'" key="available" class="update-panel update-panel--document">
            <div class="update-summary">
              <div
                class="update-status-icon"
                :class="isRollback ? 'update-status-icon--warning' : 'update-status-icon--primary'"
              >
                <NIcon :size="30">
                  <ArrowDownCircleOutline v-if="isRollback" />
                  <ArrowUpCircleOutline v-else />
                </NIcon>
              </div>
              <div class="update-copy update-copy--left">
                <h2>{{ isRollback ? t('app.older-version-available') : t('app.new-version-available') }}</h2>
                <div class="update-version-flow">
                  <span>v{{ currentVersion }}</span>
                  <span class="update-version-arrow">→</span>
                  <strong>v{{ version }}</strong>
                </div>
              </div>
            </div>
            <div class="update-document" tabindex="0">
              <!-- eslint-disable-next-line vue/no-v-html -- sanitizedReleaseNotesHtml is DOMPurify output -->
              <div v-if="releaseNotes" class="update-notes-text" v-html="sanitizedReleaseNotesHtml" />
              <NText v-else depth="3">—</NText>
            </div>
          </div>

          <div v-else-if="phase === 'downloading'" key="downloading" class="update-panel update-panel--centered">
            <div class="update-status-icon update-status-icon--primary">
              <NIcon :size="34"><CloudDownloadOutline /></NIcon>
            </div>
            <div class="update-copy">
              <h2>{{ t('preferences.download-update') }}</h2>
              <p>v{{ version }}</p>
            </div>
            <div class="update-progress-wrap">
              <NProgress type="line" :percentage="progressPercent" :show-indicator="false" processing />
              <div class="update-progress-meta">
                <span>{{ downloadedMB }} / {{ totalMB }} MB</span>
                <strong>{{ progressPercent }}%</strong>
              </div>
            </div>
          </div>

          <div v-else-if="phase === 'ready'" key="ready" class="update-panel update-panel--centered">
            <div class="update-status-icon update-status-icon--success">
              <NIcon :size="38"><CheckmarkCircleOutline /></NIcon>
            </div>
            <div class="update-copy">
              <h2>{{ t('preferences.update-download-complete') }}</h2>
              <p>v{{ version }}</p>
            </div>
          </div>

          <div v-else-if="phase === 'installing'" key="installing" class="update-panel update-panel--centered">
            <NSpin size="large" />
            <div class="update-copy">
              <h2>{{ t('preferences.installing') }}</h2>
              <p>v{{ version }}</p>
            </div>
          </div>

          <div v-else key="error" class="update-panel update-panel--document">
            <div class="update-summary">
              <div class="update-status-icon update-status-icon--error">
                <NIcon :size="30"><CloseCircleOutline /></NIcon>
              </div>
              <div class="update-copy update-copy--left">
                <h2>{{ t('preferences.check-update-failed') }}</h2>
              </div>
            </div>
            <pre class="update-error-detail" tabindex="0"><code>{{ errorMsg }}</code></pre>
          </div>
        </Transition>
      </div>

      <footer class="update-dialog-footer">
        <NButton class="update-dialog-close-action" :disabled="!dialogClosable" @click="close">
          {{ t('app.close') }}
        </NButton>
        <NButton class="action-btn" :type="actionType" :disabled="actionDisabled" @click="handleActionClick">
          <span class="action-label">
            <Transition name="action-label-swap" mode="out-in">
              <span :key="actionLabel">{{ t(actionLabel) }}</span>
            </Transition>
          </span>
        </NButton>
      </footer>
    </section>
  </NModal>
</template>

<style scoped>
.update-dialog {
  width: min(558px, calc(100vw - 40px));
  height: min(513px, calc(100vh - 40px));
  display: grid;
  grid-template-rows: 66px minmax(0, 1fr) 74px;
  color: var(--m3-on-surface);
  background: var(--m3-surface-container-high);
  border: 1px solid var(--m3-outline-variant);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 18px 56px var(--m3-shadow);
}
.update-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid var(--m3-outline-variant);
}
.update-dialog-title {
  font-size: 16px;
  font-weight: 650;
}
.update-dialog-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--m3-outline);
  font-size: 20px;
  cursor: pointer;
  line-height: 30px;
  transition:
    background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.update-dialog-close:hover {
  color: var(--m3-on-surface);
  background: var(--m3-surface-container-highest);
}
.update-dialog-close:disabled {
  cursor: default;
  opacity: 0.35;
}
.update-dialog-viewport {
  position: relative;
  min-height: 0;
  overflow: hidden;
}
.update-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 0 24px;
  border-top: 1px solid var(--m3-outline-variant);
}
.update-dialog-close-action {
  min-width: 96px;
}
.action-btn {
  min-width: 150px;
}
.action-label {
  display: inline-grid;
  place-items: center;
}
.action-label > span {
  grid-area: 1 / 1;
}
.update-dialog-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.update-panel {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  padding: 28px 32px;
}
.update-panel--centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  text-align: center;
}
.update-panel--document {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 22px;
}
.update-summary {
  display: flex;
  align-items: center;
  gap: 16px;
}
.update-status-icon {
  display: grid;
  width: 54px;
  height: 54px;
  flex: 0 0 auto;
  border-radius: 50%;
  place-items: center;
}
.update-status-icon--primary {
  color: var(--m3-on-primary-container);
  background: var(--m3-primary-container);
}
.update-status-icon--success {
  color: var(--m3-on-success-container);
  background: var(--m3-success-container);
}
.update-status-icon--warning {
  color: var(--m3-on-warning-container);
  background: var(--m3-warning-container);
}
.update-status-icon--error {
  color: var(--m3-on-error-container);
  background: var(--m3-error-container);
}
.update-copy h2 {
  margin: 0;
  color: var(--m3-on-surface);
  font-size: 19px;
  font-weight: 650;
  line-height: 1.35;
}
.update-copy p {
  margin: 6px 0 0;
  color: var(--m3-on-surface-variant);
  font-size: 13px;
}
.update-copy--left {
  text-align: left;
}
.update-version-flow {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-top: 6px;
  color: var(--m3-on-surface-variant);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.update-version-flow strong {
  color: var(--m3-primary);
  font-size: 15px;
}
.update-version-arrow {
  color: var(--m3-outline);
}
.update-progress-wrap {
  width: min(100%, 430px);
}
.update-progress-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  color: var(--m3-on-surface-variant);
  font-size: 12px;
}
.update-progress-meta strong {
  color: var(--m3-primary);
  font-weight: 650;
}
.update-document,
.update-error-detail {
  min-height: 0;
  margin: 0;
  padding: 18px 20px;
  overflow: auto;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 12px;
  background: var(--m3-surface-container);
  scrollbar-gutter: stable;
}
.update-notes-text {
  font-size: 13px;
  line-height: 1.65;
  color: var(--m3-on-surface-variant);
}
.update-notes-text :deep(h2) {
  margin: 18px 0 8px;
  color: var(--m3-on-surface);
  font-size: 15px;
  font-weight: 650;
}
.update-notes-text :deep(h2:first-child) {
  margin-top: 0;
}
.update-notes-text :deep(h3) {
  margin: 14px 0 6px;
  color: var(--m3-on-surface);
  font-size: 14px;
  font-weight: 650;
}
.update-notes-text :deep(p) {
  margin: 6px 0;
}
.update-notes-text :deep(ul),
.update-notes-text :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}
.update-notes-text :deep(li) {
  margin: 4px 0;
}

/* ── Table ─────────────────────────────────────────────────────────── */
.update-notes-text :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.update-notes-text :deep(th),
.update-notes-text :deep(td) {
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--m3-on-surface) 12%, transparent);
  text-align: left;
}
.update-notes-text :deep(th) {
  font-weight: 600;
  background: color-mix(in srgb, var(--m3-on-surface) 8%, transparent);
}
.update-notes-text :deep(tr:nth-child(even)) {
  background: color-mix(in srgb, var(--m3-on-surface) 4%, transparent);
}

/* ── Blockquote ────────────────────────────────────────────────────── */
.update-notes-text :deep(blockquote) {
  margin: 6px 0;
  padding: 6px 12px;
  border-left: 3px solid color-mix(in srgb, var(--m3-primary) 50%, transparent);
  background: color-mix(in srgb, var(--m3-on-surface) 4%, transparent);
  border-radius: 0 4px 4px 0;
}
.update-notes-text :deep(blockquote p) {
  margin: 2px 0;
}

/* ── GitHub-style Alerts (marked-alert) ───────────────────────────── */
.update-notes-text :deep(.markdown-alert) {
  margin: 6px 0;
  padding: 8px 12px;
  border-left: 3px solid;
  border-radius: 0 4px 4px 0;
}
.update-notes-text :deep(.markdown-alert-title) {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 4px;
}
.update-notes-text :deep(.markdown-alert-title svg) {
  width: 14px;
  height: 14px;
  fill: currentColor;
  flex-shrink: 0;
}
.update-notes-text :deep(.markdown-alert p) {
  margin: 2px 0;
}
.update-notes-text :deep(.markdown-alert-note) {
  border-left-color: var(--m3-primary);
  background: var(--m3-primary-container);
  color: var(--m3-on-primary-container);
}
.update-notes-text :deep(.markdown-alert-tip) {
  border-left-color: var(--m3-success);
  background: var(--m3-success-container);
  color: var(--m3-on-success-container);
}
.update-notes-text :deep(.markdown-alert-important) {
  border-left-color: var(--m3-tertiary);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
}
.update-notes-text :deep(.markdown-alert-warning) {
  border-left-color: var(--m3-warning);
  background: var(--m3-warning-container);
  color: var(--m3-on-warning-container);
}
.update-notes-text :deep(.markdown-alert-caution) {
  border-left-color: var(--m3-error);
  background: var(--m3-error-container);
  color: var(--m3-on-error-container);
}
.update-notes-text :deep(.markdown-alert p:not(.markdown-alert-title)) {
  color: var(--m3-on-surface-variant);
}

/* ── Horizontal rule ───────────────────────────────────────────────── */
.update-notes-text :deep(hr) {
  border: none;
  height: 1px;
  background: color-mix(in srgb, var(--m3-on-surface) 10%, transparent);
  margin: 8px 0;
}

/* ── Inline code & code blocks ─────────────────────────────────────── */
.update-notes-text :deep(code) {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.9em;
  padding: 1px 5px;
  background: color-mix(in srgb, var(--m3-on-surface) 10%, transparent);
  border-radius: 4px;
}
.update-notes-text :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--m3-on-surface) 8%, transparent);
  border-radius: 6px;
  overflow-x: auto;
}
.update-notes-text :deep(pre code) {
  padding: 0;
  background: none;
}

/* ── Links ─────────────────────────────────────────────────────────── */
.update-notes-text :deep(a) {
  color: var(--m3-primary);
  text-decoration: none;
}
.update-notes-text :deep(a:hover) {
  text-decoration: underline;
}

/* ── Emphasis ──────────────────────────────────────────────────────── */
.update-notes-text :deep(strong) {
  font-weight: 600;
  color: var(--m3-on-surface);
}

.update-error-detail {
  box-sizing: border-box;
  border-color: color-mix(in srgb, var(--m3-error) 32%, var(--m3-outline-variant));
  background: color-mix(in srgb, var(--m3-error) 7%, var(--m3-surface-container));
  color: var(--m3-on-surface);
  white-space: pre-wrap;
}
.update-error-detail code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.update-panel-enter-active,
.update-panel-leave-active {
  transition:
    opacity 0.48s cubic-bezier(0.2, 0, 0, 1),
    transform 0.56s cubic-bezier(0.2, 0, 0, 1);
}
.update-panel-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.update-panel-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}

@media (max-width: 680px) {
  .update-dialog {
    width: calc(100vw - 24px);
    height: calc(100vh - 24px);
  }

  .update-panel {
    padding: 22px 20px;
  }

  .update-dialog-header,
  .update-dialog-footer {
    padding-right: 20px;
    padding-left: 20px;
  }
}
</style>

<style>
.action-label-swap-enter-active {
  animation: action-pulse 0.4s ease;
  transition: opacity 0.28s cubic-bezier(0.05, 0.7, 0.1, 1);
}
.action-label-swap-leave-active {
  transition: opacity 0.18s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.action-label-swap-enter-from,
.action-label-swap-leave-to {
  opacity: 0;
}
@keyframes action-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.04);
  }
}
</style>
