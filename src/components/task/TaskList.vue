<script setup lang="ts">
import { computed } from 'vue'
import { useTaskStore } from '@/stores/task'
import { useI18n } from 'vue-i18n'
import TaskItem from './TaskItem.vue'

const emit = defineEmits<{
  pause: [task: Record<string, unknown>]
  resume: [task: Record<string, unknown>]
  delete: [task: Record<string, unknown>]
  'delete-record': [task: Record<string, unknown>]
  'copy-link': [task: Record<string, unknown>]
  'show-info': [task: Record<string, unknown>]
}>()

const { t } = useI18n()
const taskStore = useTaskStore()

const taskList = computed(() => taskStore.taskList)
const selectedGidList = computed(() => taskStore.selectedGidList)

function isSelected(gid: string) {
  return selectedGidList.value.includes(gid)
}

function handleItemClick(task: Record<string, unknown>, event: MouseEvent) {
  const gid = task.gid as string
  const list = [...selectedGidList.value]
  if (event.metaKey || event.ctrlKey) {
    const idx = list.indexOf(gid)
    if (idx === -1) list.push(gid)
    else list.splice(idx, 1)
  } else {
    list.length = 0
    list.push(gid)
  }
  taskStore.selectTasks(list)
}
</script>

<template>
  <div v-if="taskList.length > 0" class="task-list">
    <TransitionGroup name="task-list" tag="div">
      <div
        v-for="item in taskList"
        :key="(item as Record<string, unknown>).gid as string"
        :class="{ selected: isSelected((item as Record<string, unknown>).gid as string) }"
        class="task-list-item"
        @click="handleItemClick(item as Record<string, unknown>, $event)"
      >
        <TaskItem
          :task="item as Record<string, unknown>"
          @pause="emit('pause', item as Record<string, unknown>)"
          @resume="emit('resume', item as Record<string, unknown>)"
          @delete="emit('delete', item as Record<string, unknown>)"
          @delete-record="emit('delete-record', item as Record<string, unknown>)"
          @copy-link="emit('copy-link', item as Record<string, unknown>)"
          @show-info="emit('show-info', item as Record<string, unknown>)"
        />
      </div>
    </TransitionGroup>
  </div>
  <div v-else class="no-task">
    <div class="no-task-inner">
      <div class="no-task-brand">Motrix Next</div>
      <div class="no-task-text">{{ t('task.no-task') || 'No Task' }}</div>
    </div>
  </div>
</template>

<style scoped>
.task-list {
  padding: 16px 36px 64px;
  min-height: 100%;
  box-sizing: border-box;
}
.selected :deep(.task-item) {
  border-color: var(--task-item-hover-border);
}
.task-list-item {
  margin-bottom: 16px;
}
.task-list-enter-active,
.task-list-leave-active {
  transition: all 0.3s ease;
}
.task-list-enter-from {
  opacity: 0;
  transform: translateY(-20px);
}
.task-list-leave-to {
  opacity: 0;
  transform: translateX(30px);
}
.task-list-move {
  transition: transform 0.3s ease;
}
.no-task {
  display: flex;
  flex: 1;
  text-align: center;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.no-task-inner {
  width: 100%;
}
.no-task-brand {
  font-size: 72px;
  font-weight: 400;
  font-family: Futura, 'Avenir Next', 'SF Pro Display', system-ui, sans-serif;
  letter-spacing: 6px;
  color: rgba(142, 153, 164, 0.4);
  line-height: 1;
  text-transform: uppercase;
  margin-bottom: 16px;
}
.no-task-text {
  font-size: 14px;
  color: #555;
}
</style>
