<script setup lang="ts">
/** @fileoverview About panel with staggered entrance animations and glass effect. */
import { ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NIcon } from 'naive-ui'
import { LogoGithub, HeartOutline, DocumentTextOutline, RocketOutline } from '@vicons/ionicons5'
import { open } from '@tauri-apps/plugin-shell'
import { getVersion } from '@tauri-apps/api/app'
import { getVersion as getAria2Version } from '@/api/aria2'
import { useAppMessage } from '@/composables/useAppMessage'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const message = useAppMessage()
const appVersion = ref('')
const aria2Version = ref('')
const aria2Loading = ref(true)
const aria2Error = ref(false)
const year = new Date().getFullYear()
const animate = ref(false)

onMounted(async () => {
  appVersion.value = await getVersion()
})

/* Trigger entrance animation and re-fetch aria2 version each time the panel opens. */
watch(
  () => props.show,
  async (visible) => {
    if (visible) {
      animate.value = false
      requestAnimationFrame(() => {
        animate.value = true
      })

      /* Reset state and fetch fresh aria2 version */
      aria2Loading.value = true
      aria2Error.value = false
      aria2Version.value = ''
      try {
        const info = await getAria2Version()
        aria2Version.value = info.version
      } catch {
        aria2Error.value = true
      } finally {
        aria2Loading.value = false
      }
    }
  },
)

const techStack = [
  {
    name: 'Tauri 2',
    color: '#FFC131',
    /* Lucide app-window — desktop application framework */
    svg: '<rect x="2" y="4" width="20" height="16" rx="2"/><line x1="8" y1="4" x2="8" y2="20"/>',
  },
  {
    name: 'Vue 3',
    color: '#42b883',
    /* Lucide layers — layered composition framework */
    svg: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.84Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  },
  {
    name: 'Rust',
    color: '#DE5623',
    /* Lucide shield — memory safety */
    svg: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 .67-.95l7-2.5a1 1 0 0 1 .67 0l7 2.5A1 1 0 0 1 20 6z"/>',
  },
  {
    name: 'Naive UI',
    color: '#63e2b7',
    /* Lucide leaf — nature/green brand identity */
    svg: '<path d="M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 20 .5 20 .5s-4.5 4.5-2.5 10.2A7 7 0 0 1 11 20"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  },
]

const links = [
  {
    key: 'github',
    label: 'GitHub',
    icon: LogoGithub,
    url: 'https://github.com/AnInsomniacy/motrix-next',
  },
  {
    key: 'release',
    i18n: 'about.release',
    icon: RocketOutline,
    url: 'https://github.com/AnInsomniacy/motrix-next/releases',
  },
  {
    key: 'license',
    i18n: 'about.license',
    icon: DocumentTextOutline,
    url: 'https://github.com/AnInsomniacy/motrix-next/blob/main/LICENSE',
  },
  {
    key: 'support',
    i18n: 'about.support',
    icon: HeartOutline,
    url: 'https://github.com/AnInsomniacy/AnInsomniacy/blob/main/SPONSOR.md',
  },
]

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('about.version-copied', { label }))
  } catch {
    /* Clipboard API may fail in some contexts — silently ignore. */
  }
}

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
    <div class="about-glass" :class="{ 'about-enter': animate }">
      <!-- Close button -->
      <button class="about-close" :aria-label="t('about.about')" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>

      <!-- Logo -->
      <div class="about-logo stagger stagger-1">
        <img src="@/assets/logo.png" alt="Motrix Next" width="96" height="96" />
      </div>

      <!-- Title -->
      <div class="about-title stagger stagger-2">Motrix <span class="accent">Next</span></div>

      <!-- Version Badges (stacked, prominent) -->
      <div class="about-versions stagger stagger-2">
        <button
          class="version-badge"
          :title="t('about.click-to-copy')"
          @click="copyToClipboard(`Motrix Next v${appVersion}`, 'Motrix Next')"
        >
          <span class="version-label">{{ t('about.app-version') }}</span>
          <span class="version-value">v{{ appVersion }}</span>
          <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
        <Transition name="version-swap" mode="out-in">
          <!-- Loading -->
          <div v-if="aria2Loading" key="loading" class="version-badge version-badge--loading">
            <span class="version-label">{{ t('about.aria2-version') }}</span>
            <span class="version-loading">
              <svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" opacity="0.2" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
              </svg>
              {{ t('about.loading') }}
            </span>
          </div>
          <!-- Error -->
          <div v-else-if="aria2Error" key="error" class="version-badge version-badge--loading">
            <span class="version-label">{{ t('about.aria2-version') }}</span>
            <span class="version-error">{{ t('about.unavailable') }}</span>
          </div>
          <!-- Success -->
          <button
            v-else
            key="loaded"
            class="version-badge"
            :title="t('about.click-to-copy')"
            @click="copyToClipboard(`aria2 v${aria2Version}`, 'aria2')"
          >
            <span class="version-label">{{ t('about.aria2-version') }}</span>
            <span class="version-value">v{{ aria2Version }}</span>
            <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
            </svg>
          </button>
        </Transition>
      </div>

      <!-- Description -->
      <p class="about-desc stagger stagger-3">{{ t('about.description') }}</p>

      <!-- Tech Stack -->
      <div class="about-section-label stagger stagger-4">Tech Stack</div>
      <div class="about-tags stagger stagger-4">
        <span v-for="tech in techStack" :key="tech.name" class="about-tag" :style="{ '--tag-color': tech.color }">
          <svg
            class="about-tag-icon"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            v-html="tech.svg"
          />
          {{ tech.name }}
        </span>
      </div>

      <!-- Links Grid -->
      <div class="about-links stagger stagger-5">
        <button v-for="link in links" :key="link.key" class="about-link-card" @click="openUrl(link.url)">
          <NIcon :size="18"><component :is="link.icon" /></NIcon>
          <span>{{ link.i18n ? t(link.i18n) : link.label }}</span>
        </button>
      </div>

      <!-- Footer -->
      <div class="about-footer stagger stagger-6">
        <span>
          Developed by
          <a class="about-link" @click="openUrl('https://github.com/AnInsomniacy')">AnInsomniacy</a>
          · Inspired by
          <a class="about-link" @click="openUrl('https://github.com/agalwood/Motrix')">Motrix</a>
        </span>
        <span>&copy; {{ year }} AnInsomniacy</span>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
/* ── Glass Container ──────────────────────────────────────────────── */
.about-glass {
  position: relative;
  max-width: 440px;
  min-width: 320px;
  width: 50vw;
  padding: 32px 28px 24px;
  text-align: center;
  border-radius: 16px;
  border: 1px solid var(--m3-outline-variant);
  background: var(--about-glass-bg);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  box-shadow:
    0 8px 32px var(--m3-shadow),
    0 0 0 1px var(--about-glass-ring);
}

/* ── Close Button ─────────────────────────────────────────────────── */
.about-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--m3-on-surface-variant);
  cursor: pointer;
  transition: var(--transition-all);
}
.about-close:hover {
  background: var(--m3-surface-container-highest);
  color: var(--m3-on-surface);
}

/* ── Logo ─────────────────────────────────────────────────────────── */
.about-logo img {
  border-radius: 22px;
  box-shadow: 0 4px 20px var(--m3-shadow);
}

/* ── Title ────────────────────────────────────────────────────────── */
.about-title {
  margin-top: 16px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--m3-on-surface);
}
.about-title .accent {
  color: var(--color-primary);
}

/* ── Version Badges (stacked, prominent) ──────────────────────────── */
.about-versions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  padding: 0 12px;
}
.version-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 10px;
  background: var(--about-card-bg);
  cursor: pointer;
  transition: var(--transition-all);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
}
.version-badge:hover {
  border-color: var(--color-primary);
  background: var(--about-card-hover-bg);
}
.version-badge:hover .copy-icon {
  opacity: 1;
  color: var(--color-primary);
}
.version-badge:active {
  transform: scale(0.98);
}
.version-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-on-surface-variant);
  letter-spacing: 0.3px;
}
.version-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--m3-on-surface);
  letter-spacing: 0.5px;
  margin-left: auto;
}
.copy-icon {
  opacity: 0.3;
  color: var(--m3-outline);
  transition: var(--transition-all);
  flex-shrink: 0;
}

/* ── Description ──────────────────────────────────────────────────── */
.about-desc {
  margin: 16px auto 0;
  max-width: 320px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--m3-on-surface-variant);
}

/* ── Section Label ────────────────────────────────────────────────── */
.about-section-label {
  margin-top: 20px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--m3-outline);
}

/* ── Tech Tags ────────────────────────────────────────────────────── */
.about-tags {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.about-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 12px;
  color: var(--tag-color);
  background: color-mix(in srgb, var(--tag-color) 12%, transparent);
  letter-spacing: 0.3px;
}
.about-tag svg {
  flex-shrink: 0;
}
.about-tag-icon {
  opacity: 0.7;
}

/* ── Link Cards (2×2 Grid) ────────────────────────────────────────── */
.about-links {
  margin-top: 20px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.about-link-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 0;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 10px;
  background: var(--about-card-bg);
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition-all);
}
.about-link-card:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--about-card-hover-bg);
}

/* ── Footer ───────────────────────────────────────────────────────── */
.about-footer {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--m3-outline);
}
.about-link {
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: none;
}
.about-link:hover {
  text-decoration: underline;
}
.version-error {
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.3px;
}

/* ── Staggered Entrance Animation ─────────────────────────────────── */
.stagger {
  opacity: 0;
  transform: translateY(12px);
}
.about-enter .stagger {
  animation: about-fade-up 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}
.about-enter .stagger-1 {
  animation-delay: 0.05s;
}
.about-enter .stagger-2 {
  animation-delay: 0.12s;
}
.about-enter .stagger-3 {
  animation-delay: 0.18s;
}
.about-enter .stagger-4 {
  animation-delay: 0.24s;
}
.about-enter .stagger-5 {
  animation-delay: 0.3s;
}
.about-enter .stagger-6 {
  animation-delay: 0.36s;
}

@keyframes about-fade-up {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ── Spinner ──────────────────────────────────────────────────────── */
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.spinner {
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
  will-change: transform;
  contain: layout style paint;
}
.version-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.3px;
}
.version-badge--loading {
  cursor: default;
}
.version-badge--loading:hover {
  border-color: var(--m3-outline-variant);
  background: var(--about-card-bg);
}

/* ── Version Swap Transition ──────────────────────────────────────── */
.version-swap-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.version-swap-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.version-swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.version-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
