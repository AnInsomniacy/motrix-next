<script setup lang="ts">
import { ref, computed, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { ADD_TASK_TYPE } from '@shared/constants'
import { remove } from '@tauri-apps/plugin-fs'
import { getTaskName } from '@shared/utils'
import { NButton, NIcon, NTooltip, NCheckbox, useMessage, useDialog } from 'naive-ui'
import {
  AddOutline, PlayOutline, PauseOutline, TrashOutline,
  RefreshOutline, CloseOutline
} from '@vicons/ionicons5'

const { t } = useI18n()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const message = useMessage()
const dialog = useDialog()

const refreshing = ref(false)
let refreshTimer: ReturnType<typeof setTimeout> | null = null

const currentList = computed(() => taskStore.currentList)
const allGids = computed(() => taskStore.taskList.map((t: { gid: string }) => t.gid))

function showAddTask() {
  appStore.showAddTaskDialog(ADD_TASK_TYPE.URI)
}

function onRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshing.value = true
  refreshTimer = setTimeout(() => { refreshing.value = false }, 500)
  taskStore.fetchList().catch(console.error)
}

function onDeleteAll() {
  if (allGids.value.length === 0) return
  const gids = [...allGids.value]
  const deleteFiles = ref(false)
  dialog.warning({
    title: t('task.delete-task'),
    content: () => h('div', {}, [
      h('p', { style: 'margin: 0 0 12px;' }, `${t('task.batch-delete-task-confirm').replace('{{count}}', String(gids.length))}`),
      h(NCheckbox, {
        checked: deleteFiles.value,
        'onUpdate:checked': (v: boolean) => { deleteFiles.value = v },
      }, { default: () => t('task.delete-task-label') }),
    ]),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      if (deleteFiles.value) {
        const tasks = taskStore.taskList.filter(t => gids.includes(t.gid))
        for (const task of tasks) {
          const files = ((task as Record<string, unknown>).files || []) as { path: string }[]
          for (const f of files) {
            if (f.path) {
              try { await remove(f.path) } catch {}
              try { await remove(f.path + '.aria2') } catch {}
            }
          }
          const dir = (task as Record<string, unknown>).dir as string
          if (dir) {
            const name = getTaskName(task as never, { defaultName: '', maxLen: -1 })
            if (name) {
              const taskDir = dir.endsWith('/') ? dir + name : dir + '/' + name
              try { await remove(taskDir, { recursive: true }) } catch {}
            }
          }
        }
      }
      await taskStore.batchRemoveTask(gids)
    },
  })
}

function resumeAll() {
  taskStore.resumeAllTask()
    .then(() => message.success(t('task.resume-all-task-success') || 'Resumed'))
    .catch(() => message.error(t('task.resume-all-task-fail') || 'Failed'))
}

function pauseAll() {
  taskStore.pauseAllTask()
    .then(() => message.success(t('task.pause-all-task-success') || 'Paused'))
    .catch(() => message.error(t('task.pause-all-task-fail') || 'Failed'))
}

function purgeRecord() {
  taskStore.purgeTaskRecord()
    .then(() => message.success(t('task.purge-record-success') || 'Purged'))
    .catch(() => message.error(t('task.purge-record-fail') || 'Failed'))
}
</script>

<template>
  <div class="task-actions">
    <NTooltip>
      <template #trigger>
        <NButton type="primary" circle size="small" @click="showAddTask">
          <template #icon><NIcon><AddOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.new-task') || 'New Task' }}
    </NTooltip>
    <NTooltip v-if="currentList !== 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" :disabled="allGids.length === 0" @click="onDeleteAll">
          <template #icon><NIcon><CloseOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.delete-all-task') }}
    </NTooltip>
    <NTooltip>
      <template #trigger>
        <NButton quaternary circle size="small" @click="onRefresh">
          <template #icon>
            <NIcon :class="{ spinning: refreshing }"><RefreshOutline /></NIcon>
          </template>
        </NButton>
      </template>
      {{ t('task.refresh-list') || 'Refresh' }}
    </NTooltip>
    <NTooltip>
      <template #trigger>
        <NButton quaternary circle size="small" @click="resumeAll">
          <template #icon><NIcon><PlayOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.resume-all-task') || 'Resume All' }}
    </NTooltip>
    <NTooltip>
      <template #trigger>
        <NButton quaternary circle size="small" @click="pauseAll">
          <template #icon><NIcon><PauseOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.pause-all-task') || 'Pause All' }}
    </NTooltip>
    <NTooltip v-if="currentList === 'stopped'">
      <template #trigger>
        <NButton quaternary circle size="small" @click="purgeRecord">
          <template #icon><NIcon><TrashOutline /></NIcon></template>
        </NButton>
      </template>
      {{ t('task.purge-record') || 'Purge Records' }}
    </NTooltip>
  </div>
</template>

<style scoped>
.task-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.spinning {
  animation: spin 0.5s linear;
}
</style>
