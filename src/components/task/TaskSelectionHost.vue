<script setup lang="ts">
/** @fileoverview Coordinates presentation of independent BT and media dialogs. */
import { watch } from 'vue'
import { useMounted } from '@vueuse/core'
import { useTaskSelectionStore } from '@/stores/taskSelection'
import BtSelectionDialog from './BtSelectionDialog.vue'
import MediaSelectionDialog from './MediaSelectionDialog.vue'
const props = defineProps<{ blocked: boolean }>()
const selection = useTaskSelectionStore()
const mounted = useMounted()
watch(
  () => [mounted.value, props.blocked, selection.queue.length, selection.phase],
  () => {
    if (mounted.value && !props.blocked) selection.present()
  },
  { immediate: true },
)
</script>

<template>
  <BtSelectionDialog
    :gid="selection.current?.kind === 'bt' ? selection.current.gid : ''"
    :show="mounted && selection.visible && selection.current?.kind === 'bt'"
    @close="selection.close"
    @after-leave="selection.afterLeave"
  />
  <MediaSelectionDialog
    :gid="selection.current?.kind === 'media' ? selection.current.gid : ''"
    :show="mounted && selection.visible && selection.current?.kind === 'media'"
    @close="selection.close"
    @after-leave="selection.afterLeave"
  />
</template>
