<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'

const props = withDefaults(defineProps<{
  bitfield: string
  atomWidth?: number
  atomHeight?: number
  atomGutter?: number
  atomRadius?: number
}>(), {
  bitfield: '',
  atomWidth: 8,
  atomHeight: 8,
  atomGutter: 2,
  atomRadius: 1.5,
})

const container = ref<HTMLElement>()
const containerWidth = ref(300)

function updateWidth() {
  if (container.value) containerWidth.value = container.value.clientWidth
}

let ro: ResizeObserver | null = null
onMounted(() => {
  updateWidth()
  if (container.value) {
    ro = new ResizeObserver(updateWidth)
    ro.observe(container.value)
  }
})
onBeforeUnmount(() => { ro?.disconnect() })

const len = computed(() => props.bitfield.length)
const atomWG = computed(() => props.atomWidth + props.atomGutter)
const atomHG = computed(() => props.atomHeight + props.atomGutter)

const columnCount = computed(() => {
  const cols = Math.floor((containerWidth.value - props.atomWidth) / atomWG.value) + 1
  return Math.max(cols, 1)
})

const rowCount = computed(() => Math.ceil(len.value / columnCount.value))

const svgWidth = computed(() => atomWG.value * (columnCount.value - 1) + props.atomWidth)
const svgHeight = computed(() => atomHG.value * (rowCount.value - 1) + props.atomHeight)

const atoms = computed(() => {
  const result: { id: number; status: number; x: number; y: number }[] = []
  for (let i = 0; i < len.value; i++) {
    const col = i % columnCount.value
    const row = Math.floor(i / columnCount.value)
    result.push({
      id: i,
      status: Math.floor(parseInt(props.bitfield[i], 16) / 4),
      x: col * atomWG.value,
      y: row * atomHG.value,
    })
  }
  return result
})

const statusColors = ['#2a2a2a', '#3a5a3a', '#4a8a4a', '#5aba5a', '#67C23A']
const strokeColor = '#333'
</script>

<template>
  <div ref="container" class="task-graphic-container">
    <svg
      v-if="bitfield"
      class="task-graphic"
      :width="svgWidth"
      :height="svgHeight"
      :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
    >
      <rect
        v-for="atom in atoms"
        :key="atom.id"
        :x="atom.x"
        :y="atom.y"
        :width="atomWidth"
        :height="atomHeight"
        :rx="atomRadius"
        :ry="atomRadius"
        :fill="statusColors[atom.status] || statusColors[0]"
        :stroke="strokeColor"
        stroke-width="0.5"
      />
    </svg>
    <div v-else class="no-bitfield">No piece data</div>
  </div>
</template>

<style scoped>
.task-graphic-container {
  width: 100%;
  padding: 8px 0;
  overflow: hidden;
}
.task-graphic {
  display: block;
}
.no-bitfield {
  color: #666;
  font-size: 12px;
  padding: 8px 0;
}
</style>
