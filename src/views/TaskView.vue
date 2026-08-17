<script setup lang="ts">
/** @fileoverview Task list view with polling, task actions, and file delete confirmation. */
import { computed, watch, onMounted, onBeforeUnmount, ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useTaskStore } from '@/stores/task'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'
import { useTheme } from '@/composables/useTheme'
import { usePlatform } from '@/composables/usePlatform'

import { isEngineReady } from '@/api/aria2'
import { useTaskActions } from '@/composables/useTaskActions'

import { logger } from '@shared/logger'
import { useDialog } from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import TaskList from '@/components/task/TaskList.vue'
import TaskActions from '@/components/task/TaskActions.vue'
import TaskDetail from '@/components/task/TaskDetail.vue'
import watermarkDark from '@/assets/logo-bolt-dark.png'
import watermarkLight from '@/assets/logo-bolt-light.png'

const props = withDefaults(defineProps<{ status?: string }>(), { status: 'active' })

const { t } = useI18n()
const router = useRouter()
const { isMobile } = usePlatform()
const taskStore = useTaskStore()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const { isDark } = useTheme()
const watermarkSrc = computed(() => (isDark.value ? watermarkLight : watermarkDark))
const showTaskListWatermark = computed(() => preferenceStore.config.taskListWatermark)

const stoppingGids = ref<string[]>([])
provide('stoppingGids', stoppingGids)

const {
  handlePauseTask,
  handleResumeTask,
  handleDeleteTask,
  handleDeleteRecord,
  handleCopyLink,
  handleShowInfo,
  handleShowInFolder,
  handleOpenFile,
  handleStopSharing,
} = useTaskActions({
  taskStore,
  preferenceConfig: () => preferenceStore.config,
  t,
  dialog,
  message,
  stoppingGids,
})

const subnavs = computed(() => [
  { key: 'all', title: t('task.all') || 'All' },
  { key: 'active', title: t('task.active') || 'Active' },
  { key: 'stopped', title: t('task.stopped') || 'Completed' },
])

function switchStatus(key: string) {
  router.push({ path: `/task/${key}` }).catch(() => {
    /* duplicate navigation */
  })
}

const title = computed(() => {
  const sub = subnavs.value.find((s) => s.key === props.status)
  return sub?.title ?? props.status
})

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let pollStopped = true
let isUnmounted = false
let changeRequestId = 0

function startPolling() {
  if (isUnmounted) return
  stopPolling()
  pollStopped = false
  async function tick() {
    if (pollStopped) return
    if (isEngineReady()) {
      await taskStore.fetchList().catch((e) => logger.debug('TaskView.fetchList', e))
    }
    if (pollStopped) return
    refreshTimer = setTimeout(tick, appStore.interval)
  }
  refreshTimer = setTimeout(tick, appStore.interval)
}

function stopPolling() {
  pollStopped = true
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

async function changeCurrentList() {
  stopPolling()
  const requestId = ++changeRequestId
  await taskStore.changeCurrentList(props.status)
  if (isUnmounted || requestId !== changeRequestId) return
  startPolling()
}

watch(
  () => props.status,
  () => {
    void changeCurrentList()
  },
)
onMounted(() => {
  isUnmounted = false
  void changeCurrentList()
})
onBeforeUnmount(() => {
  isUnmounted = true
  changeRequestId += 1
  stopPolling()
})
// Task action handlers are now provided by useTaskActions composable above.
// Magnet file selection is handled at app-level in MainLayout.vue.
</script>

<template>
  <div class="task-view">
    <header class="panel-header" data-tauri-drag-region>
      <h4 :key="status" class="task-title">{{ title }}</h4>
      <TaskActions />
    </header>
    <!-- Mobile: task status tabs (subnav is hidden on phones) -->
    <nav v-if="isMobile" class="mobile-tabs">
      <button
        v-for="sub in subnavs"
        :key="sub.key"
        type="button"
        class="mobile-tab"
        :class="{ active: sub.key === (props.status ?? 'active') }"
        @click="switchStatus(sub.key)"
      >
        {{ sub.title }}
      </button>
    </nav>
    <div class="panel-body">
      <!-- Brand watermark stays outside the scroll container so task cards scroll above it. -->
      <Transition name="watermark-fade">
        <div v-if="showTaskListWatermark" class="watermark" @dragstart.prevent @selectstart.prevent>
          <img :src="watermarkSrc" alt="Motrix Next" class="watermark-brand" draggable="false" />
        </div>
      </Transition>
      <div class="panel-content">
        <TaskList
          @pause="handlePauseTask"
          @resume="handleResumeTask"
          @delete="handleDeleteTask"
          @delete-record="handleDeleteRecord"
          @copy-link="handleCopyLink"
          @show-info="handleShowInfo"
          @folder="handleShowInFolder"
          @open-file="handleOpenFile"
          @stop-sharing="handleStopSharing"
        />
      </div>
    </div>
    <TaskDetail
      :show="taskStore.taskDetailVisible"
      :task="taskStore.currentTaskItem"
      :files="taskStore.currentTaskFiles"
      @close="taskStore.hideTaskDetail()"
    />
  </div>
</template>

<style scoped>
.task-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.panel-header {
  position: relative;
  padding: var(--header-top-offset) 0 12px;
  margin: 0 36px;
  border-bottom: 2px solid var(--panel-border);
  user-select: none;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}
.task-title {
  margin: 0;
  color: var(--panel-title);
  font-size: 16px;
  font-weight: normal;
  line-height: 24px;
  align-self: flex-start;
}
/*
 * .panel-body creates the positioning context for the watermark.
 * The watermark is absolutely positioned here (outside the scroll flow),
 * while .panel-content scrolls independently on top.
 */
.panel-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.panel-content {
  padding: 0;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  /* z-index lifts scrollable content above the watermark layer */
  position: relative;
  z-index: 1;
}
/* ── Mobile status tabs (Android) ───────────────────────────────────── */
.mobile-tabs {
  display: flex;
  gap: 8px;
  margin: 0 16px;
  padding: 8px 0;
  overflow-x: auto;
  flex-shrink: 0;
}
.mobile-tab {
  padding: 6px 16px;
  border-radius: 100px;
  font-size: 13px;
  color: var(--m3-on-surface-variant);
  background: var(--m3-surface-container);
  border: 1px solid var(--m3-outline-variant);
  white-space: nowrap;
  transition:
    background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.mobile-tab.active {
  color: var(--m3-on-primary);
  background: var(--m3-primary);
  border-color: var(--m3-primary);
}
@media (min-width: 601px) {
  .mobile-tabs {
    display: none;
  }
}

/* ── Permanent watermark ────────────────────────────────────────────── */
.watermark {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  user-select: none;
  z-index: 0;
}
.watermark-brand {
  max-width: 480px;
  width: 80%;
  opacity: 0.35;
  user-select: none;
  -webkit-user-drag: none;
}
.watermark-fade-enter-active,
.watermark-fade-leave-active {
  transition: opacity 0.28s cubic-bezier(0.2, 0, 0, 1);
}
.watermark-fade-enter-from,
.watermark-fade-leave-to {
  opacity: 0;
}
</style>
