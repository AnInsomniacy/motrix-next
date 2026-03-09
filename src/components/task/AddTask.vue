<script setup lang="ts">
/** @fileoverview Add task dialog: URI, torrent, and metalink input with options. */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE } from '@shared/constants'
import { isEngineReady } from '@/api/aria2'
import { detectResource, bytesToSize } from '@shared/utils'
import { buildOuts } from '@shared/utils/rename'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { readFile } from '@tauri-apps/plugin-fs'
import { logger } from '@shared/logger'
import { parseTorrentBuffer, uint8ToBase64 } from '@/composables/useTorrentParser'
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
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import type { DataTableColumns } from 'naive-ui'
import type { Aria2EngineOptions } from '@shared/types'
import { FolderOpenOutline } from '@vicons/ionicons5'
import TorrentUpload from './addtask/TorrentUpload.vue'
import AdvancedOptions from './addtask/AdvancedOptions.vue'

const props = defineProps<{ type: string; show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()

const activeTab = ref(props.type || ADD_TASK_TYPE.URI)
const slideDirection = ref<'left' | 'right'>('left')
const showAdvanced = ref(false)
const config = preferenceStore.config

const torrentName = ref('')
const torrentBase64 = ref('')
const torrentLoaded = ref(false)
const torrentInfoHash = ref('')
const torrentFiles = ref<{ idx: number; path: string; length: number }[]>([])
const selectedFileIndices = ref<number[]>([])
const metalinkBase64 = ref('')
const submitting = ref(false)

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
  newTaskShowDownloading: config.newTaskShowDownloading !== false,
})

const dialogTop = computed(() => (showAdvanced.value ? '8vh' : '12vh'))
const maxSplit = computed(() => config.engineMaxConnectionPerServer || 64)

const fileColumns: DataTableColumns = [
  { type: 'selection' },
  { title: '#', key: 'idx', width: 50 },
  { title: 'File', key: 'path', ellipsis: { tooltip: true } },
  {
    title: 'Size',
    key: 'length',
    width: 100,
    render(row: Record<string, unknown>) {
      return bytesToSize(row.length as number)
    },
  },
]

const checkedRowKeys = computed({
  get: () => selectedFileIndices.value,
  set: (keys: number[]) => {
    selectedFileIndices.value = keys
  },
})

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

watch(
  () => props.type,
  (val) => {
    if (val) activeTab.value = val
  },
)

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    if (appStore.droppedTorrentPaths.length > 0) {
      await loadDroppedFile(appStore.droppedTorrentPaths[0])
      return
    }
    if (activeTab.value === ADD_TASK_TYPE.URI && !form.value.uris) {
      if (appStore.addTaskUrl) {
        form.value.uris = appStore.addTaskUrl
        appStore.addTaskUrl = ''
        return
      }
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

watch(
  () => appStore.droppedTorrentPaths,
  async (paths) => {
    if (paths.length > 0 && props.show) {
      await loadDroppedFile(paths[0])
    }
  },
)

/**
 * Loads a dropped file (torrent or metalink) by detecting its extension.
 * Sets the appropriate base64 data and switches to the torrent tab.
 */
async function loadDroppedFile(filePath: string) {
  const lower = filePath.toLowerCase()
  activeTab.value = ADD_TASK_TYPE.TORRENT

  if (lower.endsWith('.metalink') || lower.endsWith('.meta4')) {
    // Metalink file: read as base64 for addMetalink API
    try {
      clearTorrent() // fully reset all torrent state before loading metalink
      const bytes = await readFile(filePath)
      const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      metalinkBase64.value = uint8ToBase64(uint8)
      torrentName.value =
        filePath.substring(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1) || 'unknown.metalink'
      torrentLoaded.value = true
    } catch (e) {
      logger.error('AddTask.loadMetalink', e)
    }
  } else {
    // Torrent file
    metalinkBase64.value = ''
    await loadTorrentFromPath(filePath)
  }
}

async function loadTorrentFromPath(filePath: string) {
  try {
    const bytes = await readFile(filePath)
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    torrentName.value =
      filePath.substring(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1) || 'unknown.torrent'
    torrentBase64.value = uint8ToBase64(uint8)
    torrentLoaded.value = true
    await parseTorrentData(uint8)
  } catch (e) {
    logger.error('AddTask.loadTorrentFromPath', e)
  }
}

async function parseTorrentData(uint8: Uint8Array) {
  try {
    const result = await parseTorrentBuffer(uint8, bencode)
    if (!result) return

    torrentInfoHash.value = result.infoHash
    torrentFiles.value = result.files
    selectedFileIndices.value = result.files.map((f) => f.idx)
  } catch (e) {
    logger.error('AddTask.parseTorrentData', e)
    torrentFiles.value = []
    selectedFileIndices.value = []
  }
}

function clearTorrent() {
  torrentName.value = ''
  torrentBase64.value = ''
  torrentLoaded.value = false
  torrentInfoHash.value = ''
  torrentFiles.value = []
  selectedFileIndices.value = []
  metalinkBase64.value = ''
}

function handleTabChange(name: string) {
  slideDirection.value = name === ADD_TASK_TYPE.TORRENT ? 'left' : 'right'

  // FLIP: snapshot current height before switch
  const wrapper = document.querySelector('.add-task-card .n-tabs-pane-wrapper') as HTMLElement | null
  const startHeight = wrapper?.offsetHeight ?? 0

  activeTab.value = name

  // After Vue renders new tab content, animate height using Web Animations API
  // (runs on compositor layer, doesn't conflict with NUI's inline style management)
  nextTick(() => {
    requestAnimationFrame(() => {
      if (wrapper) {
        const endHeight = wrapper.scrollHeight
        if (Math.abs(startHeight - endHeight) > 2) {
          wrapper.animate([{ height: startHeight + 'px' }, { height: endHeight + 'px' }], {
            duration: 300,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
          })
        }
      }
    })
  })
}

async function chooseDirectory() {
  try {
    const selected = await openDialog({ directory: true, multiple: false })
    if (typeof selected === 'string') form.value.dir = selected
  } catch (e) {
    logger.debug('AddTask.chooseDirectory', e)
  }
}

async function chooseTorrentFile() {
  try {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'Torrent / Metalink', extensions: ['torrent', 'metalink', 'meta4'] }],
    })
    if (typeof selected === 'string') await loadTorrentFromPath(selected)
  } catch (e) {
    logger.debug('AddTask.chooseTorrentFile', e)
  }
}

function handleClose() {
  emit('close')
  clearTorrent()
}

async function handleSubmit() {
  if (submitting.value) return
  submitting.value = true
  try {
    if (activeTab.value === ADD_TASK_TYPE.URI) {
      if (!form.value.uris.trim()) return
      const uris = form.value.uris.split('\n').filter((u: string) => u.trim())
      const options: Aria2EngineOptions = {
        dir: form.value.dir,
        split: String(form.value.split),
        out: form.value.out || undefined,
      }
      if (form.value.userAgent) options['user-agent'] = form.value.userAgent
      if (form.value.referer) options.referer = form.value.referer
      const headers: string[] = []
      if (form.value.cookie) headers.push(`Cookie: ${form.value.cookie}`)
      if (form.value.authorization) headers.push(`Authorization: ${form.value.authorization}`)
      if (headers.length > 0) options.header = headers
      if (form.value.allProxy) options['all-proxy'] = form.value.allProxy
      if (uris.length > 1 && form.value.out) {
        delete options.out
        let outs = buildOuts(uris, form.value.out)
        if (outs.length === 0) {
          const dotIdx = form.value.out.lastIndexOf('.')
          const base = dotIdx > 0 ? form.value.out.substring(0, dotIdx) : form.value.out
          const ext = dotIdx > 0 ? form.value.out.substring(dotIdx) : ''
          outs = uris.map((_, i) => `${base}_${i + 1}${ext}`)
        }
        await taskStore.addUri({ uris, outs, options })
      } else {
        await taskStore.addUri({ uris, outs: [], options })
      }
    } else if (activeTab.value === ADD_TASK_TYPE.TORRENT && torrentBase64.value) {
      if (torrentInfoHash.value && isEngineReady()) {
        const { getClient } = await import('@/api/aria2')
        const [active, waiting] = await Promise.all([
          getClient().call<{ infoHash?: string }[]>('tellActive', ['infoHash']),
          getClient().call<{ infoHash?: string }[]>('tellWaiting', 0, 1000, ['infoHash']),
        ])
        const existing = [...active, ...waiting].map((t) => t.infoHash).filter(Boolean)
        if (existing.includes(torrentInfoHash.value)) {
          message.warning(t('task.duplicate-task'), { duration: 5000, closable: true })
          return
        }
      }
      const options: Aria2EngineOptions = { dir: form.value.dir }
      if (selectedFileIndices.value.length > 0 && selectedFileIndices.value.length < torrentFiles.value.length) {
        options['select-file'] = selectedFileIndices.value.join(',')
      }
      await taskStore.addTorrent({ torrent: torrentBase64.value, options })
    } else if (activeTab.value === ADD_TASK_TYPE.TORRENT && metalinkBase64.value) {
      // Metalink file import
      const options: Aria2EngineOptions = { dir: form.value.dir }
      await taskStore.addMetalink({ metalink: metalinkBase64.value, options })
    } else {
      return
    }
    message.success(t('task.add-task-success') || 'Task added successfully')
    handleClose()
    if (form.value.newTaskShowDownloading) {
      router.push({ path: '/task/active' }).catch(() => {
        /* duplicate navigation */
      })
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e)
    logger.error('AddTask.submit', e)
    if (errMsg.includes('not initialized') || !isEngineReady()) {
      message.error(t('app.engine-not-ready'), { duration: 5000, closable: true })
    } else if (/duplicate|already/i.test(errMsg)) {
      message.warning(t('task.duplicate-task') || 'This task already exists and cannot be added again.', {
        duration: 5000,
        closable: true,
      })
    } else {
      message.error(errMsg, { duration: 5000, closable: true })
    }
  } finally {
    submitting.value = false
  }
}

function handleHotkey(event: KeyboardEvent) {
  if (!props.show) return
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    handleSubmit()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleHotkey)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleHotkey)
})
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
      :style="{ maxWidth: '680px', minWidth: '380px', width: '70vw', marginTop: dialogTop }"
      :content-style="{ maxHeight: '60vh', overflowY: 'auto', overflowX: 'hidden' }"
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
            <TorrentUpload
              :loaded="torrentLoaded"
              :name="torrentName"
              @choose="chooseTorrentFile"
              @clear="clearTorrent"
            >
              <template #file-list>
                <div v-if="torrentFiles.length > 0" class="torrent-file-list">
                  <NDataTable
                    v-model:checked-row-keys="checkedRowKeys"
                    :columns="fileColumns"
                    :data="torrentFiles"
                    :row-key="(row: any) => row.idx as number"
                    size="small"
                    :max-height="200"
                    :scroll-x="400"
                  />
                </div>
              </template>
              <template #placeholder>{{ t('task.select-torrent') || 'Drag torrent here or click to select' }}</template>
            </TorrentUpload>
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
            v-model:new-task-show-downloading="form.newTaskShowDownloading"
          />
        </div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="handleClose">{{ t('app.cancel') }}</NButton>
          <NButton type="primary" :loading="submitting" @click="handleSubmit">{{ t('app.submit') }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.torrent-file-list {
  margin-top: 4px;
}

/* Tab slide animation for shared bottom form */
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
</style>
