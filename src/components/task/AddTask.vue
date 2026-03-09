<script setup lang="ts">
/** @fileoverview Add task dialog: unified batch model for URI, torrent, and metalink inputs. */
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE } from '@shared/constants'
import { detectResource, bytesToSize } from '@shared/utils'
import { mergeUriLines } from '@shared/utils/batchHelpers'
import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
} from '@/composables/useAddTaskSubmit'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { readFile } from '@tauri-apps/plugin-fs'
import { logger } from '@shared/logger'
import { parseTorrentBuffer, uint8ToBase64 } from '@/composables/useTorrentParser'
import { detectKind, createBatchItem } from '@shared/utils/batchHelpers'
import bencode from 'bencode'
import {
  NModal,
  NCard,
  NTabs,
  NTabPane,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
  NGrid,
  NGridItem,
  NIcon,
  NInputGroup,
  NDataTable,
  NTag,
  NEllipsis,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import { useAppNotification } from '@/composables/useAppNotification'
import type { DataTableColumns } from 'naive-ui'
import type { BatchItem } from '@shared/types'
import { FolderOpenOutline } from '@vicons/ionicons5'
import TorrentUpload from './addtask/TorrentUpload.vue'
import AdvancedOptions from './addtask/AdvancedOptions.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()
const { notifyError } = useAppNotification()

const activeTab = ref(ADD_TASK_TYPE.URI)
const slideDirection = ref<'left' | 'right'>('left')
const showAdvanced = ref(false)
const config = preferenceStore.config
const submitting = ref(false)
const selectedBatchIndex = ref(0)

const form = ref({
  uris: '',
  out: '',
  dir: config.dir || '',
  split: config.split || 16,
  userAgent: '',
  authorization: '',
  referer: '',
  cookie: '',
  allProxy: '',
})

const maxSplit = computed(() => config.engineMaxConnectionPerServer || 64)

const fileColumns = computed<DataTableColumns>(() => [
  { type: 'selection' },
  { title: t('task.file-index'), key: 'idx', width: 50 },
  { title: t('task.file-name'), key: 'path', ellipsis: { tooltip: true } },
  {
    title: t('task.file-size'),
    key: 'length',
    width: 100,
    render(row: Record<string, unknown>) {
      return bytesToSize(row.length as number)
    },
  },
])

// ── Computed batch accessors ────────────────────────────────────────

const batch = computed(() => appStore.pendingBatch)
const hasBatch = computed(() => batch.value.length > 0)
const fileItems = computed(() => batch.value.filter((i) => i.kind !== 'uri'))
const selectedItem = computed(() => fileItems.value[selectedBatchIndex.value] || null)
const batchListRef = ref<HTMLElement | null>(null)
/** Manually controlled: stays true during leave animation of last item. */
const showBatchList = ref(false)

watch(
  () => fileItems.value.length,
  (len) => {
    if (len > 0) showBatchList.value = true
  },
)

// Sync download dir with latest preference every time the dialog opens.
// AddTask is kept mounted (`:show` not `v-if`), so form.dir would otherwise
// be stale if the user changes the default dir in preferences.
watch(
  () => props.show,
  (visible) => {
    if (visible) {
      form.value.dir = preferenceStore.config.dir || form.value.dir
    }
  },
)

const checkedRowKeys = computed({
  get: () => selectedItem.value?.selectedFileIndices || [],
  set: (keys: number[]) => {
    const item = selectedItem.value
    if (item) item.selectedFileIndices = keys
  },
})

const submitLabel = computed(() => {
  const pending = batch.value.filter((i) => i.status === 'pending').length
  const failed = batch.value.filter((i) => i.status === 'failed').length
  const count = pending + failed
  if (count > 1) return `${t('app.submit')} (${count})`
  return t('app.submit')
})

function handleTabChange(value: string) {
  slideDirection.value = value === ADD_TASK_TYPE.TORRENT ? 'left' : 'right'
  activeTab.value = value
}

// ── Lifecycle ───────────────────────────────────────────────────────

onMounted(async () => {
  if (!form.value.dir) {
    try {
      form.value.dir = await downloadDir()
    } catch (e) {
      logger.debug('AddTask.dir', e)
      form.value.dir = '~/Downloads'
    }
  }
})

// When dialog opens: resolve file items, set tab based on batch content
watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    selectedBatchIndex.value = 0

    if (hasBatch.value) {
      // Resolve file-based items and auto-switch tab
      await resolveUnresolvedItems()
      // Flush URI batch items into the editable textarea via normalized merge
      const uriItems = batch.value.filter((i) => i.kind === 'uri')
      if (uriItems.length > 0) {
        mergeUrisIntoForm(uriItems.map((i) => i.payload))
        drainUriItemsFromBatch()
      }
      if (fileItems.value.length > 0) {
        activeTab.value = ADD_TASK_TYPE.TORRENT
      } else {
        activeTab.value = ADD_TASK_TYPE.URI
      }
    } else {
      activeTab.value = ADD_TASK_TYPE.URI
      // No batch — check clipboard for URIs
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = await readText()
        if (text && detectResource(text)) {
          form.value.uris = text.trim()
        }
      } catch (e) {
        logger.debug('AddTask.readClipboard', e)
      }
    }
  },
)

// Watch for new batch items added while dialog is already open (drag-drop, deep link)
watch(
  () => batch.value.length,
  async (newLen, oldLen) => {
    if (!props.show || newLen <= oldLen) return
    // Flush any newly added URI items via normalized merge (dedup against existing)
    const uriItems = batch.value.filter((i) => i.kind === 'uri')
    if (uriItems.length > 0) {
      mergeUrisIntoForm(uriItems.map((i) => i.payload))
      drainUriItemsFromBatch()
    }
    await resolveUnresolvedItems()
    if (fileItems.value.length > 0) {
      activeTab.value = ADD_TASK_TYPE.TORRENT
    }
  },
)

// ── URI normalization helpers ────────────────────────────────────────

/** Merge incoming URIs into form.uris with order-preserving dedup. Delegates to shared helper. */
function mergeUrisIntoForm(incoming: string[]): void {
  form.value.uris = mergeUriLines(form.value.uris, incoming)
}

/** Remove all URI-kind items from pendingBatch, keeping file items intact. */
function drainUriItemsFromBatch(): void {
  appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
}

// ── File resolution ─────────────────────────────────────────────────

async function resolveUnresolvedItems() {
  for (const item of batch.value) {
    if (item.kind !== 'uri' && item.status === 'pending' && item.payload === item.source) {
      await resolveFileItem(item)
    }
  }
}

async function resolveFileItem(item: BatchItem) {
  try {
    const bytes = await readFile(item.source)
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    item.payload = uint8ToBase64(uint8)

    if (item.kind === 'torrent') {
      try {
        const meta = await parseTorrentBuffer(uint8, bencode)
        if (meta) {
          item.torrentMeta = meta
          item.selectedFileIndices = meta.files.map((f) => f.idx)
        }
      } catch (e) {
        logger.debug('AddTask.parseTorrent', e)
      }
    }
  } catch (e) {
    logger.error('AddTask.resolveFileItem', e)
    item.status = 'failed'
    item.error = e instanceof Error ? e.message : String(e)
  }
}

// ── File chooser ────────────────────────────────────────────────────

async function chooseDirectory() {
  try {
    const selected = await openDialog({ directory: true })
    if (typeof selected === 'string') form.value.dir = selected
  } catch (e) {
    logger.debug('AddTask.chooseDirectory', e)
  }
}

async function chooseTorrentFile() {
  try {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: 'Torrent / Metalink', extensions: ['torrent', 'metalink', 'meta4'] }],
    })
    const paths = typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected : []
    if (paths.length === 0) return

    // Deduplicate: skip files already in the batch by source path
    const existingSources = new Set(batch.value.map((i) => i.source))
    const newPaths = paths.filter((p) => !existingSources.has(p))
    if (newPaths.length === 0) {
      message.warning(t('task.duplicate-task'))
      return
    }
    if (newPaths.length < paths.length) {
      message.warning(t('task.duplicate-task'))
    }

    const items = newPaths.map((p) => createBatchItem(detectKind(p), p))
    for (const item of items) {
      await resolveFileItem(item)
    }
    appStore.pendingBatch = [...appStore.pendingBatch, ...items]
    selectedBatchIndex.value = Math.max(0, fileItems.value.length - 1)
  } catch (e) {
    logger.debug('AddTask.chooseTorrentFile', e)
  }
}

function removeBatchItem(item: BatchItem) {
  appStore.pendingBatch = batch.value.filter((i) => i !== item)
  selectedBatchIndex.value = Math.min(selectedBatchIndex.value, Math.max(0, fileItems.value.length - 1))
}

// ── Batch item TransitionGroup JS hooks (bypass CSS specificity) ────

/** M3 emphasized decelerate easing for enter animations. */
const M3_DECELERATE = 'cubic-bezier(0.2, 0, 0, 1)'
/** M3 accelerate easing for exit animations. */
const M3_ACCELERATE = 'cubic-bezier(0.3, 0, 0.8, 0.15)'

function onBatchItemBeforeEnter(el: Element) {
  const htmlEl = el as HTMLElement
  htmlEl.style.opacity = '0'
  htmlEl.style.transform = 'translateX(-12px)'
}

function onBatchItemEnter(el: Element, done: () => void) {
  const htmlEl = el as HTMLElement
  const anim = htmlEl.animate(
    [
      { opacity: 0, transform: 'translateX(-12px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ],
    { duration: 220, easing: M3_DECELERATE, fill: 'forwards' },
  )
  anim.onfinish = () => {
    htmlEl.style.opacity = ''
    htmlEl.style.transform = ''
    done()
  }
}
function onBatchItemAfterLeave() {
  if (fileItems.value.length === 0 && batchListRef.value) {
    const el = batchListRef.value
    const h = el.offsetHeight
    el.animate(
      [
        { height: `${h}px`, marginBottom: '8px', opacity: 1 },
        { height: '0px', marginBottom: '0px', opacity: 0 },
      ],
      { duration: 150, easing: M3_ACCELERATE, fill: 'forwards' },
    ).onfinish = () => {
      showBatchList.value = false
      el.getAnimations().forEach((a) => a.cancel())
    }
  }
}

function onBatchItemLeave(el: Element, done: () => void) {
  const htmlEl = el as HTMLElement
  const startHeight = htmlEl.offsetHeight
  htmlEl.style.overflow = 'hidden'
  const anim = htmlEl.animate(
    [
      { opacity: 1, height: `${startHeight}px` },
      { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px' },
    ],
    { duration: 150, easing: M3_ACCELERATE, fill: 'forwards' },
  )
  anim.onfinish = done
}

// ── Submit ───────────────────────────────────────────────────────────

function handleClose() {
  emit('close')
  form.value.uris = ''
  form.value.out = ''
  form.value.userAgent = ''
  form.value.authorization = ''
  form.value.referer = ''
  form.value.cookie = ''
  form.value.allProxy = ''
  submitting.value = false
  selectedBatchIndex.value = 0
  showBatchList.value = false
}

async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true

  try {
    const options = buildEngineOptions(form.value)

    if (hasBatch.value) {
      await submitBatchItems(batch.value, options, taskStore)
    }
    if (form.value.uris.trim()) {
      await submitManualUris(form.value, options, taskStore)
    }

    const failed = batch.value.filter((i) => i.status === 'failed')
    if (failed.length > 0) {
      message.warning(`${failed.length} ${t('task.failed') || 'failed'}`, { duration: 5000, closable: true })
    } else {
      message.success(t('task.add-task-success') || 'Task added successfully')
      handleClose()
      if (preferenceStore.config.newTaskShowDownloading !== false) {
        router.push({ path: '/task/active' }).catch(() => {})
      }
    }
  } catch (e: unknown) {
    const category = classifySubmitError(e)
    const errMsg = e instanceof Error ? e.message : String(e)
    logger.error('AddTask.submit', e)
    if (category === 'duplicate') {
      message.warning(errMsg, { duration: 5000, closable: true })
    } else {
      notifyError(e, category === 'engine-not-ready' ? 'engine' : 'task')
    }
  } finally {
    submitting.value = false
  }
}

function kindTagType(kind: string): 'info' | 'success' | 'warning' {
  switch (kind) {
    case 'torrent':
      return 'info'
    case 'metalink':
      return 'success'
    default:
      return 'warning'
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="false"
    :close-on-esc="true"
    :auto-focus="false"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="
      (v: boolean) => {
        if (!v) handleClose()
      }
    "
  >
    <NCard
      :title="t('task.new-task')"
      closable
      class="add-task-card"
      :style="{
        maxWidth: '680px',
        minWidth: '380px',
        width: '70vw',
        marginTop: '5vh',
        height: '85vh',
        display: 'flex',
        flexDirection: 'column',
      }"
      :content-style="{ flex: '1', minHeight: '0', overflowY: 'auto', overflowX: 'hidden' }"
      :segmented="{ footer: true }"
      @close="handleClose"
    >
      <NForm label-placement="left" label-width="110px">
        <NTabs :value="activeTab" type="line" animated @update:value="handleTabChange">
          <NTabPane :name="ADD_TASK_TYPE.URI" :tab="t('task.uri-task') || 'URL'">
            <div class="tab-pane-content">
              <NFormItem :show-label="false" style="margin-bottom: 0">
                <NInput
                  v-model:value="form.uris"
                  type="textarea"
                  :rows="5"
                  :placeholder="t('task.uri-task-tips') || 'One URL per line'"
                />
              </NFormItem>
            </div>
          </NTabPane>
          <NTabPane :name="ADD_TASK_TYPE.TORRENT" :tab="t('task.torrent-task') || 'Torrent'">
            <div class="tab-pane-content">
              <!-- Batch list for file items -->
              <div v-show="showBatchList" ref="batchListRef" class="batch-list">
                <TransitionGroup
                  tag="div"
                  :css="false"
                  appear
                  @before-enter="onBatchItemBeforeEnter"
                  @enter="onBatchItemEnter"
                  @leave="onBatchItemLeave"
                  @after-leave="onBatchItemAfterLeave"
                >
                  <div
                    v-for="(item, idx) in fileItems"
                    :key="item.id"
                    class="batch-item"
                    :class="{ 'batch-item-selected': idx === selectedBatchIndex }"
                    @click="selectedBatchIndex = idx"
                  >
                    <div class="batch-item-main">
                      <NEllipsis :style="{ maxWidth: '400px', flex: 1 }">{{ item.displayName }}</NEllipsis>
                      <NSpace :size="4" align="center" :wrap="false">
                        <NTag :type="kindTagType(item.kind)" size="small" :bordered="false">
                          {{ item.kind === 'metalink' ? 'Metalink' : 'Torrent' }}
                        </NTag>
                        <NTag v-if="item.status === 'failed'" type="error" size="small" :bordered="false">✕</NTag>
                        <NButton quaternary size="tiny" @click.stop="removeBatchItem(item)">✕</NButton>
                      </NSpace>
                    </div>
                    <div v-if="item.error" class="batch-item-error">{{ item.error }}</div>
                  </div>
                </TransitionGroup>
              </div>

              <!-- Single torrent detail / upload area -->
              <Transition name="batch-fade" mode="out-in">
                <TorrentUpload
                  :key="selectedItem?.id || 'empty'"
                  :loaded="!!selectedItem && selectedItem.payload !== selectedItem.source"
                  @choose="chooseTorrentFile"
                >
                  <template #file-list>
                    <div
                      v-if="selectedItem?.torrentMeta && selectedItem.torrentMeta.files.length > 0"
                      class="torrent-file-list"
                    >
                      <NDataTable
                        v-model:checked-row-keys="checkedRowKeys"
                        :columns="fileColumns"
                        :data="selectedItem.torrentMeta.files"
                        :row-key="(row: any) => row.idx as number"
                        size="small"
                        :max-height="200"
                        :scroll-x="400"
                      />
                    </div>
                  </template>
                  <template #placeholder>
                    {{ t('task.select-torrent') || 'Drag torrent here or click to select' }}
                  </template>
                </TorrentUpload>
              </Transition>
            </div>
          </NTabPane>
        </NTabs>
        <div class="tab-shared-form">
          <NGrid :cols="24" :x-gap="12">
            <NGridItem :span="15">
              <NFormItem :label="t('task.task-out') + ':'">
                <NInput v-model:value="form.out" :placeholder="t('task.task-out-tips')" :autofocus="false" />
              </NFormItem>
            </NGridItem>
            <NGridItem :span="9">
              <NFormItem :label="t('task.task-split') + ':'">
                <NInputNumber v-model:value="form.split" :min="1" :max="maxSplit" style="width: 100%" />
              </NFormItem>
            </NGridItem>
          </NGrid>
          <NFormItem :label="t('task.task-dir') + ':'">
            <NInputGroup>
              <NInput v-model:value="form.dir" style="flex: 1" />
              <NButton @click="chooseDirectory">
                <template #icon>
                  <NIcon><FolderOpenOutline /></NIcon>
                </template>
              </NButton>
            </NInputGroup>
          </NFormItem>
          <AdvancedOptions
            v-model:show="showAdvanced"
            v-model:user-agent="form.userAgent"
            v-model:authorization="form.authorization"
            v-model:referer="form.referer"
            v-model:cookie="form.cookie"
            v-model:all-proxy="form.allProxy"
          />
        </div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="handleClose">{{ t('app.cancel') }}</NButton>
          <NButton type="primary" :loading="submitting" @click="handleSubmit">{{ submitLabel }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.torrent-file-list {
  margin-top: 4px;
}

/* Fixed-height tab panes prevent jitter when switching tabs */
.tab-pane-content {
  min-height: 160px;
}

/* Batch item list — overflow:hidden safe now (JS hooks don't use position:absolute) */
.batch-list {
  position: relative;
  margin-bottom: 8px;
  border-radius: 6px;
  border: 1px solid var(--n-border-color, rgba(255, 255, 255, 0.09));
  overflow: hidden;
}
</style>

<!-- Non-scoped: Vue Transition/TransitionGroup classes must NOT be scoped -->
<style>
/* Tab slide animation */
.tab-slide-left-enter-active,
.tab-slide-left-leave-active,
.tab-slide-right-enter-active,
.tab-slide-right-leave-active {
  transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.tab-slide-left-enter-from {
  opacity: 0;
  transform: translateX(30px);
}
.tab-slide-left-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}
.tab-slide-right-enter-from {
  opacity: 0;
  transform: translateX(-30px);
}
.tab-slide-right-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

/* M3 crossfade for batch detail switching & container enter/leave */
.batch-fade-enter-active {
  transition: opacity 0.22s cubic-bezier(0.2, 0, 0, 1);
}
.batch-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.batch-fade-enter-from,
.batch-fade-leave-to {
  opacity: 0;
}

/* Batch item styles — MUST be non-scoped to avoid specificity conflict with TransitionGroup */
.batch-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}
.batch-item:hover {
  background: var(--n-color-hover, rgba(255, 255, 255, 0.04));
}
.batch-item-selected {
  background: var(--n-color-hover, rgba(255, 255, 255, 0.06));
}
.batch-item + .batch-item {
  border-top: 1px solid var(--n-border-color, rgba(255, 255, 255, 0.06));
}
.batch-item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.batch-item-error {
  color: var(--n-text-color-error, #e88080);
  font-size: 12px;
  margin-top: 4px;
}
</style>
