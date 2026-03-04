<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'
import { bytesToSize } from '@shared/utils'
import { NIcon } from 'naive-ui'
import { SpeedometerOutline } from '@vicons/ionicons5'

const appStore = useAppStore()
const preferenceStore = usePreferenceStore()

const stat = computed(() => appStore.stat)
const isStopped = computed(() => stat.value.numActive === 0)
const engineMode = computed(() => preferenceStore.engineMode)
const downloadSpeed = computed(() => bytesToSize(String(stat.value.downloadSpeed)))
const uploadSpeed = computed(() => bytesToSize(String(stat.value.uploadSpeed)))
</script>

<template>
  <div :class="['speedometer', { stopped: isStopped }]">
    <div class="mode">
      <i>
        <NIcon :size="20"><SpeedometerOutline /></NIcon>
      </i>
    </div>
    <div class="value" v-if="!isStopped">
      <em>{{ uploadSpeed }}/s</em>
      <span>{{ downloadSpeed }}/s</span>
    </div>
  </div>
</template>

<style scoped>
.speedometer {
  font-size: 12px;
  position: fixed;
  right: 36px;
  bottom: 24px;
  z-index: 20;
  display: inline-block;
  box-sizing: border-box;
  width: 115px;
  height: 40px;
  padding: 5px 10px 5px 40px;
  border-radius: 100px;
  transition: all .25s cubic-bezier(.645, .045, .355, 1);
  border: 1px solid var(--speedometer-border);
  background: var(--speedometer-bg);
}
.speedometer:hover {
  border-color: var(--speedometer-hover-border);
}
.speedometer.stopped {
  width: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.speedometer.stopped .mode {
  position: static;
}
.speedometer.stopped .mode em {
  display: none;
}
.speedometer.stopped .mode i {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--speedometer-stopped);
}
.speedometer em {
  font-style: normal;
}
.mode {
  font-size: 0;
  position: absolute;
  top: 5px;
  left: 5px;
}
.mode i {
  font-size: 20px;
  font-style: normal;
  line-height: 28px;
  display: inline-block;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  padding: 2px;
  text-align: center;
  vertical-align: top;
  color: var(--speedometer-primary);
}
.mode em {
  display: inline-block;
  width: 0;
  height: 8px;
  margin-left: 4px;
  font-size: 16px;
  line-height: 15px;
  transform: scale(.5);
  vertical-align: top;
  color: var(--speedometer-primary);
}
.value {
  font-size: 0;
  overflow: hidden;
  width: 100%;
  text-align: right;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.value em {
  font-size: 16px;
  line-height: 12px;
  display: block;
  width: 120%;
  transform: scale(.625);
  color: var(--speedometer-text);
}
.value span {
  font-size: 13px;
  line-height: 14px;
  display: block;
  margin-top: 2px;
  color: var(--speedometer-primary);
}
</style>
