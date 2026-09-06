<script setup lang="ts">
/** @fileoverview Scrollable task list container with SortableJS drag ordering and Vue list transitions. */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import Sortable from 'sortablejs'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useReducedMotion } from '@/composables/useReducedMotion'
import TaskItem from './TaskItem.vue'
import TaskCompactItem from './TaskCompactItem.vue'
import type { ComponentPublicInstance } from 'vue'
import type { SortableEvent, SortableOptions } from 'sortablejs'
import type { Aria2Task } from '@shared/types'

const emit = defineEmits<{
  pause: [task: Aria2Task]
  resume: [task: Aria2Task]
  retry: [task: Aria2Task]
  redownload: [task: Aria2Task]
  'finish-sharing': [task: Aria2Task]
  delete: [task: Aria2Task]
  'delete-record': [task: Aria2Task]
  'copy-link': [task: Aria2Task]
  'show-info': [task: Aria2Task]
  folder: [task: Aria2Task]
  'open-file': [task: Aria2Task]
  'select-files': [task: Aria2Task]
}>()

const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const reduceMotion = useReducedMotion()
const { t } = useI18n()

type ListRefTarget = HTMLElement | ComponentPublicInstance | null

const taskList = ref<Aria2Task[]>(taskStore.taskList)
const listRef = ref<ListRefTarget>(null)
const sorting = ref(false)
const containerTransitioning = ref(false)
let lastFloatingRect: DOMRect | null = null
let floatingRectFrame = 0
let sortable: Sortable | null = null
let renderedTransitionRevision = taskStore.taskListTransitionRevision
const taskCardComponent = computed(() =>
  preferenceStore.config.taskCardMode === 'compact' ? TaskCompactItem : TaskItem,
)
const taskPage = computed(() => taskStore.taskPagination[taskStore.currentList].page)
const pageSize = computed(() => taskStore.taskPagination.pageSize)
/**
 * While a filename search is active the list shows a filtered subset, so
 * drag-to-reorder is disabled: saving a manual order from a subset would
 * discard the stored order of hidden tasks.
 */
const searchActive = computed(() => Boolean(taskStore.taskSearchKeywords[taskStore.currentList]?.trim()))
const pageTransitionKey = computed(
  () => `${taskStore.currentList}:${taskPage.value}:${pageSize.value}:${taskStore.taskListTransitionRevision}`,
)
const visibleTaskList = computed<Aria2Task[]>({
  get() {
    const start = (taskPage.value - 1) * pageSize.value
    return taskList.value.slice(start, start + pageSize.value)
  },
  set(nextPageList) {
    const start = (taskPage.value - 1) * pageSize.value
    taskList.value = [
      ...taskList.value.slice(0, start),
      ...nextPageList,
      ...taskList.value.slice(start + nextPageList.length),
    ]
  },
})

onBeforeUnmount(() => {
  stopFloatingRectTracking()
  destroySortable()
  lastFloatingRect = null
})

onMounted(() => {
  void nextTick(mountSortable)
})

function trackFloatingRect() {
  const floating = document.querySelector<HTMLElement>('.task-list-item--floating')
  if (floating?.isConnected) {
    lastFloatingRect = floating.getBoundingClientRect()
  }

  if (sorting.value) {
    floatingRectFrame = requestAnimationFrame(trackFloatingRect)
  }
}

function startFloatingRectTracking() {
  stopFloatingRectTracking()
  lastFloatingRect = null
  floatingRectFrame = requestAnimationFrame(trackFloatingRect)
}

function stopFloatingRectTracking() {
  if (!floatingRectFrame) return
  cancelAnimationFrame(floatingRectFrame)
  floatingRectFrame = 0
}

function animateDropSettle(event: SortableEvent | undefined): Promise<void> {
  const item = event?.item
  if (!lastFloatingRect || !item?.isConnected) return Promise.resolve()

  if (reduceMotion.value) {
    lastFloatingRect = null
    return Promise.resolve()
  }

  const targetRect = item.getBoundingClientRect()
  const deltaX = lastFloatingRect.left - targetRect.left
  const deltaY = lastFloatingRect.top - targetRect.top
  lastFloatingRect = null

  if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return Promise.resolve()

  item.classList.add('task-list-item--settling')
  item.style.setProperty('--task-drop-x', `${deltaX}px`)
  item.style.setProperty('--task-drop-y', `${deltaY}px`)

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      item.classList.add('task-list-item--settled')
    })

    window.setTimeout(() => {
      item.classList.remove('task-list-item--settling', 'task-list-item--settled')
      item.style.removeProperty('--task-drop-x')
      item.style.removeProperty('--task-drop-y')
      resolve()
    }, 320)
  })
}

watch(
  () => taskStore.taskList,
  (v) => {
    if (sorting.value) return
    if (renderedTransitionRevision !== taskStore.taskListTransitionRevision) return
    taskList.value = v
    taskStore.clampCurrentTaskPage()
  },
  { immediate: true },
)

watch(
  () => taskStore.taskListTransitionRevision,
  async (revision) => {
    renderedTransitionRevision = revision
    await nextTick()
    if (sorting.value) return
    taskList.value = taskStore.taskList
    taskStore.clampCurrentTaskPage()
  },
)

watch([taskPage, pageSize], () => {
  if (sorting.value) return
  taskStore.clampCurrentTaskPage()
})

watch(
  pageTransitionKey,
  () => {
    if (sorting.value) return
    containerTransitioning.value = true
  },
  { flush: 'sync' },
)

const sortableOptions: SortableOptions = {
  animation: reduceMotion.value ? 0 : 240,
  handle: '.task-drag-handle',
  draggable: '.task-list-item',
  filter: '.task-item-actions, button, a, input, textarea, select, [data-no-drag]',
  ghostClass: 'task-list-item--ghost',
  chosenClass: 'task-list-item--chosen',
  fallbackClass: 'task-list-item--floating',
  dragClass: 'task-list-item--dragging',
  direction: 'vertical',
  swapThreshold: 0.72,
  invertedSwapThreshold: 0.28,
  invertSwap: false,
  forceFallback: true,
  fallbackOnBody: true,
  fallbackTolerance: 3,
  preventOnFilter: false,
  onStart: () => {
    sorting.value = true
    if (!reduceMotion.value) startFloatingRectTracking()
  },
  onUpdate: (event) => {
    if (event.oldIndex === undefined || event.newIndex === undefined || event.oldIndex === event.newIndex) return
    const nextPageList = [...visibleTaskList.value]
    const [task] = nextPageList.splice(event.oldIndex, 1)
    if (!task) return
    nextPageList.splice(event.newIndex, 0, task)
    visibleTaskList.value = nextPageList
  },
  onEnd: async (event) => {
    stopFloatingRectTracking()
    await nextTick()
    await animateDropSettle(event)
    await taskStore.saveVisiblePageManualOrder(visibleTaskList.value)
    window.setTimeout(() => {
      sorting.value = false
    }, 0)
  },
}

watch(reduceMotion, (enabled) => {
  const duration = enabled ? 0 : 240
  sortableOptions.animation = duration
  sortable?.option('animation', duration)
})

function destroySortable() {
  sortable?.destroy()
  sortable = null
}

function resolveListElement() {
  const target = listRef.value
  if (target instanceof HTMLElement) return target
  const element = target?.$el
  return element instanceof HTMLElement ? element : null
}

function mountSortable() {
  destroySortable()
  const element = resolveListElement()
  if (!element) return
  sortable = Sortable.create(element, sortableOptions)
}

function handlePageSwapBeforeLeave() {
  containerTransitioning.value = true
  destroySortable()
}

function handlePageSwapAfterEnter() {
  containerTransitioning.value = false
  void nextTick(mountSortable)
}

function handleCardBeforeLeave(element: Element) {
  if (containerTransitioning.value) return
  if (!(element instanceof HTMLElement)) return
  const height = Math.ceil(element.getBoundingClientRect().height || element.offsetHeight)
  element.classList.add('task-list-item--collapsing')
  element.style.setProperty('--task-list-card-leave-height', `${height}px`)
}
</script>

<template>
  <div class="task-list" :class="{ 'task-list--searching': searchActive }">
    <Transition
      name="task-page-swap"
      mode="out-in"
      appear
      @before-leave="handlePageSwapBeforeLeave"
      @after-enter="handlePageSwapAfterEnter"
      @enter-cancelled="handlePageSwapAfterEnter"
      @leave-cancelled="handlePageSwapAfterEnter"
    >
      <TransitionGroup
        :key="pageTransitionKey"
        ref="listRef"
        tag="div"
        :css="!sorting && !containerTransitioning"
        name="task-list-card"
        class="task-list-inner"
        @before-leave="handleCardBeforeLeave"
      >
        <div v-for="item in visibleTaskList" :key="item.gid" class="task-list-item">
          <component
            :is="taskCardComponent"
            :task="item"
            :action-pending="taskStore.resubmittingGids.includes(item.gid)"
            @pause="emit('pause', item)"
            @resume="emit('resume', item)"
            @retry="emit('retry', item)"
            @redownload="emit('redownload', item)"
            @finish-sharing="emit('finish-sharing', item)"
            @delete="emit('delete', item)"
            @delete-record="emit('delete-record', item)"
            @copy-link="emit('copy-link', item)"
            @show-info="emit('show-info', item)"
            @folder="emit('folder', item)"
            @open-file="emit('open-file', item)"
            @select-files="emit('select-files', item)"
          />
        </div>
      </TransitionGroup>
    </Transition>
    <div v-if="searchActive && visibleTaskList.length === 0" class="task-search-empty">
      {{ t('task.search-no-results') }}
    </div>
  </div>
</template>

<style scoped>
.task-list {
  --task-list-bottom-safety: 54px;
  padding: 16px 36px 16px;
  min-height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
/* A filtered subset cannot be reordered without corrupting the saved order. */
.task-list--searching :deep(.task-drag-handle) {
  display: none;
}
.task-search-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--m3-outline);
  font-size: var(--font-size-sm);
  user-select: none;
}
/*
 * Speedometer bottom safety area — only when cards are present.
 * A ::after pseudo-element participates in flex layout, reliably
 * letting the final card scroll above the fixed Speedometer widget without
 * forcing short lists to show a scrollbar.
 */
.task-list-inner:not(:empty)::after {
  content: '';
  display: block;
  height: var(--task-list-bottom-safety);
}

/* ── Task card layer ─────────────────────────────────────────────────── */
.task-list-inner {
  flex: 1;
  position: relative;
  z-index: 1;
}
.task-page-swap-enter-active {
  transition:
    opacity 0.2s cubic-bezier(0.2, 0, 0, 1),
    transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.task-page-swap-leave-active {
  pointer-events: none;
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.task-page-swap-enter-from,
.task-page-swap-leave-to {
  opacity: 0;
  transform: scale(0.98);
}
.task-list-item {
  position: relative;
  margin-bottom: 16px;
}
.task-list-card-move,
.task-list-card-enter-active {
  transition:
    transform 260ms ease,
    opacity 180ms ease;
}
.task-list-card-enter-from {
  opacity: 0;
  transform: scale(0.98);
}
.task-list-card-leave-to {
  opacity: 0;
  transform: scale(0.995);
}
.task-list-card-leave-active {
  transition:
    transform 260ms ease,
    opacity 180ms ease;
  pointer-events: none;
}
.task-list-card-leave-active.task-list-item--collapsing {
  height: var(--task-list-card-leave-height);
  overflow: hidden;
  transition:
    height 260ms ease,
    margin-bottom 260ms ease,
    opacity 180ms ease;
  transform: none;
}
.task-list-card-leave-to.task-list-item--collapsing {
  height: 0;
  margin-bottom: 0;
  transform: none;
}
.task-list-item--ghost {
  overflow: hidden;
  opacity: 0;
}
.task-list-item--floating {
  opacity: 1 !important;
  filter: none !important;
  pointer-events: none;
  transition: none !important;
}
.task-list-item--dragging {
  opacity: 1 !important;
}
.task-list-item--settling {
  z-index: 3;
  transform: translate3d(var(--task-drop-x), var(--task-drop-y), 0);
  will-change: transform;
}
.task-list-item--settling.task-list-item--settled {
  transform: translate3d(0, 0, 0);
  transition: transform 300ms ease;
}
</style>
