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
} from '@vicons/ionicons5'
import { usePreferenceStore } from '@/stores/preference'
import {
  isActionDisabled,
  getActionLabel,
  getActionType,
  getActionTarget,
  isUpdateRollback,
  calcProgressPercent,
  bytesToMB,
  getUpdateProxy as resolveProxy,
  formatUpdateError,
} from '@/composables/useUpdateFlow'

interface UpdateMetadata {
  version: string
  body: string | null
  date: string | null
}

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
const renderedNotes = computed(() => {
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
const activeChannel = ref('stable')
let progressUnlisten: UnlistenFn | null = null

const progressPercent = computed(() => calcProgressPercent(downloadReceived.value, downloadTotal.value))

// ── Version direction detection ──────────────────────────────────────
const isRollback = computed(() => isUpdateRollback(currentVersion.value, version.value))

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
  const ch = channel || preferenceStore.config.updateChannel || 'stable'
  activeChannel.value = ch
  show.value = true
  phase.value = 'checking'
  version.value = ''
  releaseNotes.value = ''
  errorMsg.value = ''
  downloadTotal.value = 0
  downloadReceived.value = 0
  downloadCancelled.value = false
  currentVersion.value = await getVersion()

  try {
    const update = await invoke<UpdateMetadata | null>('check_for_update', {
      channel: ch,
      proxy: getUpdateProxy(),
    })

    if (update) {
      version.value = update.version
      releaseNotes.value = update.body || ''
      phase.value = 'available'
    } else {
      phase.value = 'up-to-date'
    }
  } catch (e) {
    errorMsg.value = formatUpdateError(e)
    phase.value = 'error'
  } finally {
    preferenceStore.updateAndSave({ lastCheckUpdateTime: Date.now() })
  }
}

async function startDownload() {
  phase.value = 'downloading'
  downloadReceived.value = 0
  downloadTotal.value = 0
  downloadCancelled.value = false
  const ch = activeChannel.value

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
    await invoke('download_update', { channel: ch, proxy: getUpdateProxy() })
    if (!downloadCancelled.value) {
      phase.value = 'ready'
    }
  } catch (e) {
    if (!downloadCancelled.value) {
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
  invoke('cancel_update').catch(() => {
    /* best-effort: Rust side may have already finished */
  })
}

async function handleInstallAndRelaunch() {
  phase.value = 'installing'
  const ch = activeChannel.value
  await invoke('apply_update', { channel: ch, proxy: getUpdateProxy() })
  relaunch()
}

function close() {
  if (phase.value === 'downloading') {
    cancelDownload()
  }
  show.value = false
}

onUnmounted(() => {
  progressUnlisten?.()
})

defineExpose({ open })
</script>

<template>
  <NModal
    v-model:show="show"
    :mask-closable="phase !== 'downloading' && phase !== 'installing'"
    :close-on-esc="phase !== 'downloading' && phase !== 'installing'"
    transform-origin="center"
    :closable="phase !== 'downloading' && phase !== 'installing'"
    @update:show="
      (v: boolean) => {
        if (!v) close()
      }
    "
  >
    <div class="update-dialog">
      <div class="update-dialog-header">
        <div class="update-dialog-title-group">
          <span class="update-dialog-title">{{ t('preferences.auto-update') }}</span>
          <NTag :type="activeChannel === 'beta' ? 'warning' : 'success'" size="small" round :bordered="false">
            {{ t(`preferences.update-channel-${activeChannel}`) }}
          </NTag>
        </div>
        <button class="update-dialog-close" @click="close">×</button>
      </div>
      <div class="update-dialog-body">
        <Transition name="phase-switch" mode="out-in">
          <div v-if="phase === 'checking'" key="checking" class="update-phase">
            <NSpin size="medium" />
            <NText depth="2" class="update-hint">{{ t('app.checking-for-updates') }}</NText>
          </div>

          <div v-else-if="phase === 'up-to-date'" key="up-to-date" class="update-phase">
            <div class="update-icon-wrap update-icon-success">
              <NIcon :size="40"><CheckmarkCircleOutline /></NIcon>
            </div>
            <NText class="update-main-text">{{ t('preferences.is-latest-version') }}</NText>
            <NText depth="3" class="update-hint">v{{ currentVersion }}</NText>
          </div>

          <div v-else-if="phase === 'available'" key="available" class="update-phase">
            <div class="update-icon-wrap" :class="isRollback ? 'update-icon-warn' : 'update-icon-new'">
              <NIcon :size="40">
                <ArrowDownCircleOutline v-if="isRollback" />
                <ArrowUpCircleOutline v-else />
              </NIcon>
            </div>
            <div class="update-version-info">
              <NText class="update-main-text">
                {{ isRollback ? t('app.older-version-available') : t('app.new-version-available') }}
              </NText>
              <div class="update-version-tags">
                <span class="version-tag version-old">v{{ currentVersion }}</span>
                <span class="version-arrow">→</span>
                <span class="version-tag version-new">v{{ version }}</span>
              </div>
            </div>
            <div v-if="releaseNotes" class="update-notes">
              <div class="update-notes-text" v-html="renderedNotes" />
            </div>
          </div>

          <div v-else-if="phase === 'downloading'" key="downloading" class="update-phase">
            <div class="update-icon-wrap" :class="isRollback ? 'update-icon-warn' : 'update-icon-new'">
              <NIcon :size="40">
                <ArrowDownCircleOutline v-if="isRollback" />
                <ArrowUpCircleOutline v-else />
              </NIcon>
            </div>
            <div class="update-progress-wrap">
              <NProgress
                type="line"
                :percentage="progressPercent"
                :show-indicator="true"
                indicator-placement="inside"
                processing
              />
              <NText depth="3" class="update-hint" style="margin-top: 6px">
                {{ downloadedMB }} / {{ totalMB }} MB · {{ progressPercent }}%
              </NText>
            </div>
          </div>

          <div v-else-if="phase === 'ready'" key="ready" class="update-phase">
            <div class="update-icon-wrap update-icon-success">
              <NIcon :size="40"><CheckmarkCircleOutline /></NIcon>
            </div>
            <NText class="update-main-text">{{ t('preferences.update-download-complete') }}</NText>
          </div>

          <div v-else-if="phase === 'installing'" key="installing" class="update-phase">
            <NSpin size="medium" />
            <NText depth="2" class="update-hint">{{ t('preferences.installing') }}</NText>
          </div>

          <div v-else-if="phase === 'error'" key="error" class="update-phase">
            <div class="update-icon-wrap update-icon-error">
              <NIcon :size="40"><CloseCircleOutline /></NIcon>
            </div>
            <NText class="update-main-text">{{ t('preferences.check-update-failed') }}</NText>
            <div class="update-error-detail">
              <NText depth="3" class="update-error-msg">{{ errorMsg }}</NText>
            </div>
          </div>
        </Transition>
      </div>
      <!-- Fixed action footer — always rendered with 2 buttons -->
      <div class="update-dialog-footer">
        <NButton style="min-width: 120px" @click="close">
          {{ t('app.close') }}
        </NButton>
        <NButton
          class="action-btn"
          :class="{ 'action-btn--active': !actionDisabled }"
          :type="actionType"
          :disabled="actionDisabled"
          style="min-width: 180px"
          @click="handleActionClick"
        >
          {{ t(actionLabel) }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.update-dialog {
  width: 460px;
  background: var(--n-color, #1e1e2e);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 12px 40px var(--m3-shadow);
}
.update-dialog-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 0;
}
.update-dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color, #fff);
}
.update-dialog-close {
  background: none;
  border: none;
  color: var(--n-text-color, #aaa);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  opacity: 0.5;
  transition: opacity 0.2s;
}
.update-dialog-close:hover {
  opacity: 1;
}
.update-dialog-body {
  position: relative;
  padding: 14px 30px 12px;
  height: 380px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
}
.update-dialog-footer {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 16px 30px 22px;
  border-top: 1px solid var(--m3-outline-variant);
}
.action-btn {
  transition: all 0.4s ease;
  opacity: 0.5;
}
.action-btn--active {
  opacity: 1;
  animation: action-pulse 0.4s ease;
}
@keyframes action-pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.04);
  }
  100% {
    transform: scale(1);
  }
}
.update-dialog-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.update-phase {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
  width: 100%;
}

.update-icon-wrap {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}
.update-icon-success {
  background: color-mix(in srgb, var(--m3-success) 12%, transparent);
  color: var(--m3-success);
}
.update-icon-new {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}
.update-icon-warn {
  background: color-mix(in srgb, var(--m3-error) 10%, transparent);
  color: var(--m3-tertiary);
}
.update-icon-error {
  background: color-mix(in srgb, var(--m3-error) 12%, transparent);
  color: var(--m3-error);
}

.update-main-text {
  font-size: 15px;
  font-weight: 600;
}
.update-hint {
  font-size: 12px;
}

.update-version-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.update-version-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}
.version-tag {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.version-old {
  background: color-mix(in srgb, var(--n-text-color, #666) 12%, transparent);
  color: var(--n-text-color, #999);
  opacity: 0.7;
}
.version-new {
  background: var(--m3-primary-container-bg);
  color: var(--color-primary);
}
.version-arrow {
  font-size: 12px;
  opacity: 0.3;
}

.update-progress-wrap {
  width: 100%;
  padding: 0 8px;
}

.update-notes {
  width: 100%;
  background: color-mix(in srgb, var(--m3-on-surface) 6%, transparent);
  border-radius: 8px;
  padding: 10px 14px;
  max-height: 200px;
  flex: 1;
  overflow-y: auto;
}
.update-notes-text {
  font-size: 12.5px;
  line-height: 1.6;
  opacity: 0.65;
  color: var(--n-text-color, #ccc);
}
.update-notes-text :deep(h2) {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 4px;
}
.update-notes-text :deep(h3) {
  font-size: 12.5px;
  font-weight: 600;
  margin: 6px 0 2px;
}
.update-notes-text :deep(p) {
  margin: 2px 0;
}
.update-notes-text :deep(ul),
.update-notes-text :deep(ol) {
  margin: 2px 0;
  padding-left: 18px;
}
.update-notes-text :deep(li) {
  margin: 1px 0;
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
  border-left: 3px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
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
  border-left-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  color: var(--color-primary);
}
.update-notes-text :deep(.markdown-alert-tip) {
  border-left-color: var(--m3-success);
  background: color-mix(in srgb, var(--m3-success) 6%, transparent);
  color: var(--m3-success);
}
.update-notes-text :deep(.markdown-alert-important) {
  border-left-color: var(--m3-tertiary);
  background: color-mix(in srgb, var(--m3-tertiary) 6%, transparent);
  color: var(--m3-tertiary);
}
.update-notes-text :deep(.markdown-alert-warning) {
  border-left-color: var(--m3-warning, #d4a04a);
  background: color-mix(in srgb, var(--m3-warning, #d4a04a) 6%, transparent);
  color: var(--m3-warning, #d4a04a);
}
.update-notes-text :deep(.markdown-alert-caution) {
  border-left-color: var(--m3-error);
  background: color-mix(in srgb, var(--m3-error) 6%, transparent);
  color: var(--m3-error);
}
.update-notes-text :deep(.markdown-alert p:not(.markdown-alert-title)) {
  color: var(--n-text-color, #ccc);
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
  color: var(--color-primary);
  text-decoration: none;
}
.update-notes-text :deep(a:hover) {
  text-decoration: underline;
}

/* ── Emphasis ──────────────────────────────────────────────────────── */
.update-notes-text :deep(strong) {
  font-weight: 600;
  color: var(--n-text-color, #eee);
}

.update-error-detail {
  width: 100%;
  background: var(--m3-error-container-bg);
  border-radius: 8px;
  padding: 10px 14px;
  max-height: 72px;
  overflow-y: auto;
}
.update-error-msg {
  font-size: 12.5px;
  word-break: break-all;
  line-height: 1.5;
}

.phase-switch-enter-active {
  transition:
    opacity 0.3s cubic-bezier(0.2, 0, 0, 1),
    transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.phase-switch-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.25s cubic-bezier(0.4, 0, 1, 1);
}
.phase-switch-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(8px);
}
.phase-switch-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}
</style>
