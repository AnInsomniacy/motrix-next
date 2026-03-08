<script setup lang="ts">
/** @fileoverview About panel showing application version and system info. */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NCard, NIcon, NButton, NTag, NDivider } from 'naive-ui'
import { LogoGithub, HeartOutline, DocumentTextOutline, RocketOutline } from '@vicons/ionicons5'
import { open } from '@tauri-apps/plugin-shell'
import { getVersion } from '@tauri-apps/api/app'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const version = ref('')
const year = new Date().getFullYear()

onMounted(async () => {
  version.value = await getVersion()
})

const techStack = [
  { name: 'Tauri v2', color: '#FFC131' },
  { name: 'Vue 3', color: '#42b883' },
  { name: 'aria2', color: '#339af0' },
  { name: 'Naive UI', color: '#63e2b7' },
  { name: 'TypeScript', color: '#3178c6' },
  { name: 'Vite', color: '#bd34fe' },
]

function openUrl(url: string) {
  open(url)
}
</script>

<template>
  <NModal
    :show="show"
    transform-origin="center"
    @update:show="
      (v: boolean) => {
        if (!v) emit('close')
      }
    "
  >
    <NCard
      closable
      :style="{ maxWidth: '480px', minWidth: '340px', width: '50vw' }"
      :content-style="{ padding: '0' }"
      @close="emit('close')"
    >
      <div class="about-container">
        <div class="about-header">
          <div class="about-logo">
            <img src="@/assets/logo.png" alt="Motrix Next" width="100" height="100" style="border-radius: 20px" />
          </div>
          <div class="about-title">Motrix <span class="about-title-accent">Next</span></div>
          <div class="about-version">v{{ version }}</div>
        </div>

        <div class="about-desc">
          A full-featured download manager, rebuilt from the ground up<br />
          with Tauri, Vue 3, and TypeScript.
        </div>

        <NDivider style="margin: 16px 0 12px" />

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

        <NDivider style="margin: 12px 0" />

        <div class="about-links">
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next')">
            <template #icon>
              <NIcon :size="16"><LogoGithub /></NIcon>
            </template>
            GitHub
          </NButton>
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next/releases')">
            <template #icon>
              <NIcon :size="16"><RocketOutline /></NIcon>
            </template>
            {{ t('about.release') }}
          </NButton>
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next/blob/main/LICENSE')">
            <template #icon>
              <NIcon :size="16"><DocumentTextOutline /></NIcon>
            </template>
            {{ t('about.license') }}
          </NButton>
          <NButton text @click="openUrl('https://github.com/AnInsomniacy/motrix-next/issues')">
            <template #icon>
              <NIcon :size="16"><HeartOutline /></NIcon>
            </template>
            {{ t('about.support') }}
          </NButton>
        </div>

        <div class="about-footer">
          <span
            >Developed by
            <a class="about-link" @click="openUrl('https://github.com/AnInsomniacy')">AnInsomniacy</a></span
          >
          <span
            >Inspired by <a class="about-link" @click="openUrl('https://github.com/agalwood/Motrix')">Motrix</a> —
            thanks to the original creators</span
          >
          <span>&copy; {{ year }} AnInsomniacy</span>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.about-container {
  padding: 16px 28px 20px;
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
.about-title-accent {
  color: var(--color-primary);
}
.about-version {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 1.5px;
  padding: 3px 14px;
  border-radius: 6px;
  border: 1px solid var(--m3-outline-variant);
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
  opacity: 0.5;
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
  opacity: 0.5;
}
.about-link {
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: none;
}
.about-link:hover {
  text-decoration: underline;
}
</style>
