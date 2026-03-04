<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { ADD_TASK_TYPE } from '@shared/constants'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import AsideBar from '@/components/layout/AsideBar.vue'
import TaskSubnav from '@/components/layout/TaskSubnav.vue'
import PreferenceSubnav from '@/components/layout/PreferenceSubnav.vue'
import Speedometer from '@/components/layout/Speedometer.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import AboutPanel from '@/components/about/AboutPanel.vue'
import AddTask from '@/components/task/AddTask.vue'

const route = useRoute()
const appStore = useAppStore()

const isTaskPage = computed(() => route.path.startsWith('/task'))
const isPreferencePage = computed(() => route.path.startsWith('/preference'))
const showAbout = ref(false)

let unlistenDragDrop: (() => void) | null = null

onMounted(async () => {
  const webview = getCurrentWebview()
  unlistenDragDrop = await webview.onDragDropEvent((event) => {
    if (event.payload.type === 'drop') {
      const paths = event.payload.paths
      const torrentPaths = paths?.filter((p: string) => p.endsWith('.torrent')) || []
      if (torrentPaths.length > 0) {
        appStore.showAddTaskDialog(ADD_TASK_TYPE.TORRENT, torrentPaths)
      }
    }
  })
})

onUnmounted(() => {
  if (unlistenDragDrop) unlistenDragDrop()
})
</script>

<template>
  <div id="container">
    <AsideBar @show-about="showAbout = true" />
    <div class="subnav-slot">
      <Transition name="fade" mode="out-in">
        <TaskSubnav v-if="isTaskPage" key="task-subnav" />
        <PreferenceSubnav v-else-if="isPreferencePage" key="pref-subnav" />
      </Transition>
    </div>
    <main class="content">
      <router-view v-slot="{ Component, route: viewRoute }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" :key="viewRoute.path" />
        </Transition>
      </router-view>
    </main>
    <WindowControls class="window-controls" />
    <Speedometer />
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask
      :show="appStore.addTaskVisible"
      :type="appStore.addTaskType"
      @close="appStore.hideAddTaskDialog()"
    />
  </div>
</template>

<style scoped>
#container {
  display: flex;
  height: 100vh;
  position: relative;
  border-radius: 12px;
  overflow: hidden;
}
.subnav-slot {
  width: var(--subnav-width);
  flex-shrink: 0;
  background-color: var(--subnav-bg);
}
.content {
  flex: 1;
  overflow-y: auto;
  background-color: var(--main-bg);
}
.window-controls {
  position: fixed;
  top: 6px;
  right: 12px;
  z-index: 100;
}
</style>
