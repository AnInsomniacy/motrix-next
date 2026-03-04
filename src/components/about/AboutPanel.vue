<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NModal, NCard, NIcon, NButton, NTag, NDivider } from 'naive-ui'
import { LogoGithub, HeartOutline, DocumentTextOutline, RocketOutline } from '@vicons/ionicons5'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const version = '3.0.0'
const year = new Date().getFullYear()

const techStack = [
  { name: 'Tauri v2', color: '#FFC131' },
  { name: 'Vue 3', color: '#42b883' },
  { name: 'aria2', color: '#339af0' },
  { name: 'Naive UI', color: '#63e2b7' },
  { name: 'TypeScript', color: '#3178c6' },
  { name: 'Vite', color: '#bd34fe' },
]

function openUrl(url: string) {
  window.open(url, '_blank')
}
</script>

<template>
  <NModal :show="show" transform-origin="center" @update:show="(v: boolean) => { if (!v) emit('close') }">
    <NCard
      closable
      @close="emit('close')"
      :style="{ maxWidth: '480px', minWidth: '340px', width: '50vw' }"
      :content-style="{ padding: '0' }"
    >
      <div class="about-container">
        <div class="about-header">
          <div class="about-logo">
            <svg xmlns="http://www.w3.org/2000/svg" width="90" height="32" viewBox="0 0 100 36">
              <rect x="1" y="1" width="98" height="34" rx="8" fill="none" stroke="#E0A422" stroke-width="2.5"/>
              <text x="50" y="26" fill="#E0A422" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="22" text-anchor="middle" letter-spacing="3">NEXT</text>
            </svg>
          </div>
          <div class="about-title">Motrix Next</div>
          <div class="about-version">v{{ version }}</div>
        </div>

        <div class="about-desc">
          A full-featured download manager, rebuilt from the ground up<br/>
          with Tauri, Vue 3, and TypeScript.
        </div>

        <NDivider style="margin: 16px 0 12px;" />

        <div class="about-section-title">Tech Stack</div>
        <div class="about-tags">
          <NTag
            v-for="tech in techStack"
            :key="tech.name"
            :bordered="false"
            size="small"
            round
            :style="{ '--n-color': tech.color + '18', '--n-text-color': tech.color }"
          >
            {{ tech.name }}
          </NTag>
        </div>

        <NDivider style="margin: 12px 0;" />

        <div class="about-links">
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next')">
            <template #icon><NIcon :size="16"><LogoGithub /></NIcon></template>
            GitHub
          </NButton>
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next/releases')">
            <template #icon><NIcon :size="16"><RocketOutline /></NIcon></template>
            {{ t('about.release') }}
          </NButton>
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next/blob/main/LICENSE')">
            <template #icon><NIcon :size="16"><DocumentTextOutline /></NIcon></template>
            {{ t('about.license') }}
          </NButton>
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next/issues')">
            <template #icon><NIcon :size="16"><HeartOutline /></NIcon></template>
            {{ t('about.support') }}
          </NButton>
        </div>

        <div class="about-footer">
          <span>Developed by <a class="about-link" @click="openUrl('https://github.com/AnInsomniacy')">AnInsomniacy</a></span>
          <span>Inspired by <a class="about-link" @click="openUrl('https://github.com/agalwood/Motrix')">Motrix</a> — thanks to the original creators</span>
          <span>&copy; {{ year }} AnInsomniacy</span>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.about-container {
  padding: 28px 28px 20px;
  text-align: center;
}
.about-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.about-logo {
  opacity: 0.9;
}
.about-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.5px;
  margin-top: 8px;
}
.about-version {
  font-size: 12px;
  opacity: 0.45;
  font-weight: 500;
  letter-spacing: 1px;
}
.about-desc {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.6;
}
.about-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  opacity: 0.35;
  margin-bottom: 10px;
}
.about-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.about-links {
  display: flex;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
}
.about-footer {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  opacity: 0.35;
}
.about-link {
  color: #E0A422;
  cursor: pointer;
  text-decoration: none;
}
.about-link:hover {
  text-decoration: underline;
}
</style>
