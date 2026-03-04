<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE } from '@shared/constants'
import { detectResource, bytesToSize } from '@shared/utils'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { readFile } from '@tauri-apps/plugin-fs'
import bencode from 'bencode'
import {
  NModal, NCard, NTabs, NTabPane, NForm, NFormItem, NInput, NInputNumber,
  NButton, NCheckbox, NSpace, NGrid, NGridItem, NIcon, NText, NInputGroup,
  NCollapseTransition, NTooltip, NDataTable, useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { CloudUploadOutline, FolderOpenOutline, TrashOutline } from '@vicons/ionicons5'

const props = defineProps<{ type: string; show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const message = useMessage()

const activeTab = ref(props.type || ADD_TASK_TYPE.URI)
const slideDirection = ref<'left' | 'right'>('left')
const showAdvanced = ref(false)
const config = (preferenceStore.config || {}) as Record<string, unknown>

const torrentName = ref('')
const torrentBase64 = ref('')
const torrentLoaded = ref(false)
const torrentFiles = ref<{ idx: number; path: string; length: number }[]>([])
const selectedFileIndices = ref<number[]>([])

const form = ref({
  uris: '',
  out: '',
  dir: (config.dir as string) || '',
  split: (config.split as number) || 16,
  userAgent: '',
  authorization: '',
  referer: '',
  cookie: '',
  allProxy: '',
  newTaskShowDownloading: true,
})

const dialogTop = computed(() => showAdvanced.value ? '8vh' : '12vh')
const maxSplit = computed(() => (config.engineMaxConnectionPerServer as number) || 64)

const fileColumns: DataTableColumns = [
  { type: 'selection' },
  { title: '#', key: 'idx', width: 50 },
  { title: 'File', key: 'path', ellipsis: { tooltip: true } },
  {
    title: 'Size',
    key: 'length',
    width: 100,
    render(row: any) {
      return bytesToSize(row.length)
    }
  },
]

const checkedRowKeys = computed({
  get: () => selectedFileIndices.value,
  set: (keys: number[]) => { selectedFileIndices.value = keys }
})

onMounted(async () => {
  if (!form.value.dir) {
    try { form.value.dir = await downloadDir() } catch { form.value.dir = '~/Downloads' }
  }
})

watch(() => props.type, (val) => { if (val) activeTab.value = val })

watch(() => props.show, async (visible) => {
  if (visible && appStore.droppedTorrentPaths.length > 0) {
    activeTab.value = ADD_TASK_TYPE.TORRENT
    await loadTorrentFromPath(appStore.droppedTorrentPaths[0])
  }
})

watch(() => appStore.droppedTorrentPaths, async (paths) => {
  if (paths.length > 0 && props.show) {
    activeTab.value = ADD_TASK_TYPE.TORRENT
    await loadTorrentFromPath(paths[0])
  }
})

async function loadTorrentFromPath(filePath: string) {
  try {
    const bytes = await readFile(filePath)
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    torrentName.value = filePath.split('/').pop() || 'unknown.torrent'
    torrentBase64.value = uint8ToBase64(uint8)
    torrentLoaded.value = true
    await parseTorrentData(uint8)
  } catch (e) {
    console.error('loadTorrentFromPath error:', e)
  }
}

function uint8ToBase64(uint8: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  return btoa(binary)
}

async function parseTorrentData(uint8: Uint8Array) {
  try {
    const decoded = bencode.decode(uint8) as any
    const info = decoded.info
    if (!info) return

    const textDecoder = new TextDecoder('utf-8', { fatal: false })
    const decodeName = (v: any) => v instanceof Uint8Array ? textDecoder.decode(v) : String(v)

    if (info.files && info.files.length > 0) {
      torrentFiles.value = info.files.map((f: any, i: number) => {
        const pathParts = (f.path || f['path.utf-8'] || []).map(decodeName)
        return {
          idx: i + 1,
          path: pathParts.join('/') || `file-${i + 1}`,
          length: f.length || 0,
        }
      })
      selectedFileIndices.value = torrentFiles.value.map(f => f.idx)
    } else if (info.name) {
      torrentFiles.value = [{
        idx: 1,
        path: decodeName(info['name.utf-8'] || info.name),
        length: info.length || 0,
      }]
      selectedFileIndices.value = [1]
    }
  } catch (e) {
    console.error('parseTorrentData error:', e)
    torrentFiles.value = []
    selectedFileIndices.value = []
  }
}

function clearTorrent() {
  torrentName.value = ''
  torrentBase64.value = ''
  torrentLoaded.value = false
  torrentFiles.value = []
  selectedFileIndices.value = []
}

function handleTabChange(name: string) {
  slideDirection.value = name === ADD_TASK_TYPE.TORRENT ? 'left' : 'right'
  activeTab.value = name
}

async function chooseDirectory() {
  try {
    const selected = await openDialog({ directory: true, multiple: false })
    if (selected) form.value.dir = selected as string
  } catch {}
}

async function chooseTorrentFile() {
  try {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'Torrent', extensions: ['torrent'] }]
    })
    if (selected) await loadTorrentFromPath(selected as string)
  } catch {}
}

function handleClose() {
  emit('close')
  clearTorrent()
}

async function handleSubmit() {
  try {
    if (activeTab.value === ADD_TASK_TYPE.URI) {
      if (!form.value.uris.trim()) return
      const uris = form.value.uris.split('\n').filter((u: string) => u.trim())
      const options: Record<string, unknown> = {
        dir: form.value.dir,
        split: String(form.value.split),
        out: form.value.out || undefined,
      }
      if (form.value.userAgent) options['user-agent'] = form.value.userAgent
      if (form.value.referer) options.referer = form.value.referer
      if (form.value.cookie) options.header = `Cookie: ${form.value.cookie}`
      if (form.value.allProxy) options['all-proxy'] = form.value.allProxy
      if (form.value.authorization) options.header = `Authorization: ${form.value.authorization}`
      await taskStore.addUri({ uris, outs: [], options })
    } else if (activeTab.value === ADD_TASK_TYPE.TORRENT && torrentBase64.value) {
      const options: Record<string, unknown> = { dir: form.value.dir }
      if (selectedFileIndices.value.length > 0 && selectedFileIndices.value.length < torrentFiles.value.length) {
        options['select-file'] = selectedFileIndices.value.join(',')
      }
      await taskStore.addTorrent({ torrent: torrentBase64.value, options })
    } else {
      return
    }
    handleClose()
    if (form.value.newTaskShowDownloading) {
      router.push({ path: '/task/active' }).catch(() => {})
    }
  } catch (e: any) {
    const errMsg = e?.message || String(e)
    console.error('[AddTask] submit error:', e)
    message.error(errMsg, { duration: 5000, closable: true })
  }
}

function handleHotkey(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    handleSubmit()
  }
}

onMounted(() => { document.addEventListener('keydown', handleHotkey) })
onUnmounted(() => { document.removeEventListener('keydown', handleHotkey) })
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="false"
    :close-on-esc="true"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="(v: boolean) => { if (!v) handleClose() }"
  >
    <NCard
      :title="t('task.new-task')"
      closable
      @close="handleClose"
      class="add-task-card"
      :style="{ maxWidth: '680px', minWidth: '380px', width: '70vw', marginTop: dialogTop }"
      :content-style="{ maxHeight: '60vh', overflowY: 'auto', overflowX: 'hidden' }"
      :segmented="{ footer: true }"
    >
      <NForm label-placement="left" label-width="110px">
        <NTabs :value="activeTab" type="line" animated @update:value="handleTabChange">
          <NTabPane :name="ADD_TASK_TYPE.URI" :tab="t('task.uri-task') || 'URL'">
            <div style="padding-bottom: 12px;">
              <NFormItem :show-label="false">
                <NInput
                  type="textarea"
                  :autosize="{ minRows: 3, maxRows: 5 }"
                  :placeholder="t('task.uri-task-tips') || 'One URL per line'"
                  v-model:value="form.uris"
                />
              </NFormItem>
            </div>
          </NTabPane>
          <NTabPane :name="ADD_TASK_TYPE.TORRENT" :tab="t('task.torrent-task') || 'Torrent'">
            <div style="padding-bottom: 12px;">
              <template v-if="torrentLoaded">
                <div class="torrent-info-row">
                  <NTooltip>
                    <template #trigger>
                      <div class="torrent-filename">
                        <NIcon :size="18" style="margin-right: 6px; flex-shrink: 0;"><CloudUploadOutline /></NIcon>
                        <span>{{ torrentName }}</span>
                      </div>
                    </template>
                    {{ torrentName }}
                  </NTooltip>
                  <NButton quaternary size="small" type="error" @click="clearTorrent">
                    <template #icon><NIcon :size="16"><TrashOutline /></NIcon></template>
                  </NButton>
                </div>
                <div v-if="torrentFiles.length > 0" class="torrent-file-list">
                  <NDataTable
                    :columns="fileColumns"
                    :data="torrentFiles"
                    :row-key="(row: any) => row.idx as number"
                    v-model:checked-row-keys="checkedRowKeys"
                    size="small"
                    :max-height="200"
                    :scroll-x="400"
                  />
                </div>
              </template>
              <div v-else class="torrent-upload" @click="chooseTorrentFile">
                <NIcon :size="48" :depth="3"><CloudUploadOutline /></NIcon>
                <NText style="display: block; margin-top: 8px; font-size: 14px;">
                  {{ t('task.select-torrent') || 'Drag torrent here or click to select' }}
                </NText>
              </div>
            </div>
          </NTabPane>
        </NTabs>
        <Transition :name="'tab-slide-' + slideDirection" mode="out-in">
          <div :key="activeTab" class="tab-shared-form">
            <NGrid :cols="24" :x-gap="12">
              <NGridItem :span="15">
                <NFormItem :label="t('task.task-out') + ':'">
                  <NInput :placeholder="t('task.task-out-tips')" v-model:value="form.out" :autofocus="false" />
                </NFormItem>
              </NGridItem>
              <NGridItem :span="9">
                <NFormItem :label="t('task.task-split') + ':'">
                  <NInputNumber v-model:value="form.split" :min="1" :max="maxSplit" style="width: 100%;" />
                </NFormItem>
              </NGridItem>
            </NGrid>
            <NFormItem :label="t('task.task-dir') + ':'">
              <NInputGroup>
                <NInput v-model:value="form.dir" style="flex: 1;" />
                <NButton @click="chooseDirectory">
                  <template #icon><NIcon><FolderOpenOutline /></NIcon></template>
                </NButton>
              </NInputGroup>
            </NFormItem>
            <NFormItem :show-label="false">
              <NCheckbox v-model:checked="showAdvanced">
                {{ t('task.show-advanced-options') }}
              </NCheckbox>
            </NFormItem>
            <NCollapseTransition :show="showAdvanced">
              <div>
                <NFormItem :label="t('task.task-user-agent') + ':'">
                  <NInput type="textarea" :autosize="{ minRows: 2, maxRows: 3 }" v-model:value="form.userAgent" />
                </NFormItem>
                <NFormItem :label="t('task.task-authorization') + ':'">
                  <NInput type="textarea" :autosize="{ minRows: 2, maxRows: 3 }" v-model:value="form.authorization" />
                </NFormItem>
                <NFormItem :label="t('task.task-referer') + ':'">
                  <NInput type="textarea" :autosize="{ minRows: 2, maxRows: 3 }" v-model:value="form.referer" />
                </NFormItem>
                <NFormItem :label="t('task.task-cookie') + ':'">
                  <NInput type="textarea" :autosize="{ minRows: 2, maxRows: 3 }" v-model:value="form.cookie" />
                </NFormItem>
                <NGrid :cols="24" :x-gap="12">
                  <NGridItem :span="16">
                    <NFormItem :label="t('task.task-proxy') + ':'">
                      <NInput placeholder="[http://][USER:PASSWORD@]HOST[:PORT]" v-model:value="form.allProxy" />
                    </NFormItem>
                  </NGridItem>
                </NGrid>
                <NFormItem :show-label="false">
                  <NCheckbox v-model:checked="form.newTaskShowDownloading">
                    {{ t('task.navigate-to-downloading') }}
                  </NCheckbox>
                </NFormItem>
              </div>
            </NCollapseTransition>
          </div>
        </Transition>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="handleClose">{{ t('app.cancel') }}</NButton>
          <NButton type="primary" @click="handleSubmit">{{ t('app.submit') }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.torrent-upload {
  padding: 40px 0;
  text-align: center;
  border: 1px dashed rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s ease;
}
.torrent-upload:hover {
  border-color: var(--color-primary);
}
.torrent-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  margin-bottom: 10px;
}
.torrent-filename {
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
  flex: 1;
  min-width: 0;
}
.torrent-filename span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.torrent-file-list {
  margin-top: 4px;
}

/* Tab slide animation for shared bottom form */
.tab-slide-left-enter-active,
.tab-slide-left-leave-active,
.tab-slide-right-enter-active,
.tab-slide-right-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
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
