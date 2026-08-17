<script setup lang="ts">
/**
 * @fileoverview Smart Capsule Speedometer — always-visible status bar with
 * integrated speed limit toggle and configuration.
 *
 * Fixed-width capsule (205px) — never shrinks:
 *   IDLE (muted)     — no active tasks, lock-open + ∞
 *   ACTIVE (primary)  — active tasks, lock-open + ∞
 *   LIMITED (tertiary) — limit active, lock-closed + values
 *
 * Interactions:
 *   Left-click  — toggle speed limit on/off (toast hint if unconfigured)
 *   Right-click — open speed limit configuration popover
 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { usePreferenceStore } from '@/stores/preference'
import { changeGlobalOption, isEngineReady } from '@/api/aria2'
import { bytesToSize } from '@shared/utils'
import { NIcon, NPopover, NInputNumber, NSelect, NButton, NSwitch, NDivider, NText } from 'naive-ui'
import {
  SpeedometerOutline,
  ArrowUpOutline,
  ArrowDownOutline,
  LockClosedOutline,
  TimerOutline,
} from '@vicons/ionicons5'
import {
  formatLimitBadge,
  parseSpeedLimitValue,
  buildSpeedLimitString,
  toggleSpeedLimit,
  applyCustomLimit,
} from '@/composables/useSpeedLimiter'
import { useAppMessage } from '@/composables/useAppMessage'
import { logger } from '@shared/logger'

const { t } = useI18n()
const appStore = useAppStore()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()

const stat = computed(() => appStore.stat)
const isIdle = computed(() => stat.value.numActive === 0)
const isLimited = computed(() => !!preferenceStore.config.speedLimitEnabled)
const isScheduleActive = computed(() => !!preferenceStore.config.speedScheduleEnabled)
/** Clock badge only when schedule is actually effective (both switches ON). */
const isScheduleEffective = computed(() => isLimited.value && isScheduleActive.value)
const downloadSpeed = computed(() => bytesToSize(String(stat.value.downloadSpeed)))
const uploadSpeed = computed(() => bytesToSize(String(stat.value.uploadSpeed)))

// ── Limit badge display ─────────────────────────────────────────────

const dlLimitBadge = computed(() => formatLimitBadge(preferenceStore.config.maxOverallDownloadLimit))
const ulLimitBadge = computed(() => formatLimitBadge(preferenceStore.config.maxOverallUploadLimit))

// ── Adaptive width (grow instant, shrink debounced) ─────────────────
// The outer capsule (.speedometer) uses a JS-driven `width` so that CSS
// `transition: width` animates both expansion and contraction smoothly.
// A separate inner wrapper (.capsule-content) is observed by
// ResizeObserver — it has NO width constraint, so its borderBoxSize
// always reflects true content width (no circular dependency).
// Shrinking is debounced (800 ms) to prevent jitter from speed fluctuations.

const capsuleRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const capsuleWidth = ref(0)
let shrinkTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null

const SHRINK_DELAY_MS = 1000

const capsuleStyle = computed(() => (capsuleWidth.value > 0 ? { width: `${capsuleWidth.value}px` } : undefined))

function cancelShrink() {
  if (shrinkTimer !== null) {
    clearTimeout(shrinkTimer)
    shrinkTimer = null
  }
}

onMounted(() => {
  if (!contentRef.value || !capsuleRef.value) return
  const capsuleEl = capsuleRef.value

  resizeObserver = new ResizeObserver((entries) => {
    // Compute padding+border each tick so CSS changes are reflected immediately
    const cs = getComputedStyle(capsuleEl)
    const hPad =
      parseFloat(cs.paddingLeft) +
      parseFloat(cs.paddingRight) +
      parseFloat(cs.borderLeftWidth) +
      parseFloat(cs.borderRightWidth)

    for (const entry of entries) {
      const contentWidth = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
      const totalWidth = Math.ceil(contentWidth + hPad)

      if (totalWidth > capsuleWidth.value) {
        // Growing — apply immediately
        cancelShrink()
        capsuleWidth.value = totalWidth
      } else if (totalWidth < capsuleWidth.value - 2 && shrinkTimer === null) {
        // Shrinking — debounce to prevent jitter (2px hysteresis)
        const target = totalWidth
        shrinkTimer = setTimeout(() => {
          capsuleWidth.value = target
          shrinkTimer = null
        }, SHRINK_DELAY_MS)
      }
    }
  })
  resizeObserver.observe(contentRef.value)
})

onBeforeUnmount(() => {
  cancelShrink()
  resizeObserver?.disconnect()
  resizeObserver = null
})

// ── Popover state ───────────────────────────────────────────────────

const showPopover = ref(false)
const popoverDlValue = ref(0)
const popoverDlUnit = ref('K')
const popoverUlValue = ref(0)
const popoverUlUnit = ref('K')

const speedUnitOptions = [
  { label: 'KB/s', value: 'K' },
  { label: 'MB/s', value: 'M' },
]

function openPopover() {
  const dl = parseSpeedLimitValue(preferenceStore.config.maxOverallDownloadLimit)
  const ul = parseSpeedLimitValue(preferenceStore.config.maxOverallUploadLimit)
  popoverDlValue.value = dl.num
  popoverDlUnit.value = dl.unit
  popoverUlValue.value = ul.num
  popoverUlUnit.value = ul.unit
  showPopover.value = true
}

// ── Dependency injection for composable calls ───────────────────────

function makeDeps() {
  return {
    changeGlobalOption,
    updateAndSave: (partial: Partial<typeof preferenceStore.config>) => preferenceStore.updateAndSave(partial),
  }
}

// ── Left-click: toggle speed limit ──────────────────────────────────

async function handleClick() {
  if (!isEngineReady()) return

  const result = await toggleSpeedLimit(preferenceStore.config, makeDeps())

  switch (result) {
    case 'enabled':
      message.success(t('app.speedometer-limit-applied'))
      break
    case 'disabled':
      message.success(t('app.speedometer-limit-removed'))
      break
    case 'needs-config':
      message.info(t('app.speedometer-needs-config'))
      break
  }
}

// ── Right-click: open configuration popover ─────────────────────────

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  openPopover()
}

// ── Apply custom limit from popover ─────────────────────────────────

async function handleApply() {
  if (!isEngineReady()) return

  // Reject 0/0 — at least one direction must have a non-zero limit
  if (popoverDlValue.value === 0 && popoverUlValue.value === 0) {
    message.warning(t('app.speedometer-enter-values'))
    return
  }

  const dlStr = buildSpeedLimitString(popoverDlValue.value, popoverDlUnit.value)
  const ulStr = buildSpeedLimitString(popoverUlValue.value, popoverUlUnit.value)

  try {
    await applyCustomLimit(dlStr, ulStr, makeDeps())
    showPopover.value = false
    message.success(t('app.speedometer-limit-applied'))
  } catch (e) {
    logger.error('Speedometer.applyLimit', e)
  }
}

// ── Schedule toggle from popover ───────────────────────────────────────
async function handleScheduleToggle(enabled: boolean) {
  await preferenceStore.updateAndSave({ speedScheduleEnabled: enabled })
  message.success(t(enabled ? 'app.schedule-enabled' : 'app.schedule-disabled'))
}
</script>

<template>
  <NPopover
    :show="showPopover"
    trigger="manual"
    placement="top-end"
    :show-arrow="true"
    @update:show="(v: boolean) => (showPopover = v)"
    @clickoutside="showPopover = false"
  >
    <template #trigger>
      <div
        ref="capsuleRef"
        :class="['speedometer', { idle: isIdle, limited: isLimited }]"
        :style="capsuleStyle"
        @click="handleClick"
        @contextmenu="handleContextMenu"
      >
        <Transition name="lock-pop" appear>
          <div v-if="isScheduleEffective" class="clock-pill">
            <NIcon :size="12"><TimerOutline /></NIcon>
          </div>
        </Transition>
        <Transition name="lock-pop" appear>
          <div v-if="isLimited && !isScheduleEffective" class="lock-pill">
            <NIcon :size="12"><LockClosedOutline /></NIcon>
          </div>
        </Transition>
        <div ref="contentRef" class="capsule-content">
          <div class="mode">
            <i>
              <NIcon :size="22"><SpeedometerOutline /></NIcon>
            </i>
          </div>
          <div class="value">
            <div class="speed-row upload">
              <div class="speed-text">
                <NIcon :size="10" class="speed-arrow"><ArrowUpOutline /></NIcon>
                <em>{{ uploadSpeed }}/s</em>
              </div>
              <div class="limit-zone">
                <span class="limit-sep">┊</span>
                <Transition name="limit-fade" mode="out-in">
                  <span v-if="isLimited" :key="'ul-' + ulLimitBadge" class="limit-value">{{ ulLimitBadge }}</span>
                  <span v-else key="ul-inf" class="limit-value limit-inf">∞</span>
                </Transition>
              </div>
            </div>
            <div class="speed-row download">
              <div class="speed-text">
                <NIcon :size="10" class="speed-arrow"><ArrowDownOutline /></NIcon>
                <span>{{ downloadSpeed }}/s</span>
              </div>
              <div class="limit-zone">
                <span class="limit-sep">┊</span>
                <Transition name="limit-fade" mode="out-in">
                  <span v-if="isLimited" :key="'dl-' + dlLimitBadge" class="limit-value">{{ dlLimitBadge }}</span>
                  <span v-else key="dl-inf" class="limit-value limit-inf">∞</span>
                </Transition>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Speed limit configuration panel -->
    <div class="limit-panel">
      <div class="limit-panel-title">{{ t('app.speedometer-set-limit') }}</div>

      <div class="limit-panel-row">
        <div class="limit-panel-label">
          <NIcon :size="12"><ArrowUpOutline /></NIcon>
          <span>{{ t('app.speedometer-upload-limit') }}</span>
        </div>
        <div class="limit-panel-inputs">
          <NInputNumber
            v-model:value="popoverUlValue"
            :min="0"
            :max="65535"
            :step="1"
            size="small"
            style="width: 100px"
          />
          <NSelect v-model:value="popoverUlUnit" :options="speedUnitOptions" size="small" style="width: 88px" />
        </div>
      </div>

      <div class="limit-panel-row">
        <div class="limit-panel-label">
          <NIcon :size="12"><ArrowDownOutline /></NIcon>
          <span>{{ t('app.speedometer-download-limit') }}</span>
        </div>
        <div class="limit-panel-inputs">
          <NInputNumber
            v-model:value="popoverDlValue"
            :min="0"
            :max="65535"
            :step="1"
            size="small"
            style="width: 100px"
          />
          <NSelect v-model:value="popoverDlUnit" :options="speedUnitOptions" size="small" style="width: 88px" />
        </div>
      </div>

      <NDivider style="margin: 12px 0 8px" />
      <div class="limit-panel-row">
        <div class="limit-panel-label">
          <NIcon :size="12"><TimerOutline /></NIcon>
          <span>{{ t('preferences.speed-schedule-enabled') }}</span>
        </div>
        <NSwitch :value="isScheduleActive" size="small" @update:value="handleScheduleToggle" />
      </div>
      <Transition name="hint-slide">
        <NText
          v-if="isScheduleActive && !isLimited"
          depth="3"
          type="warning"
          style="font-size: 11px; margin-top: 4px; display: block"
        >
          {{ t('preferences.schedule-needs-limit') }}
        </NText>
      </Transition>

      <NButton type="primary" size="small" block style="margin-top: 12px" @click="handleApply">
        {{ t('app.speedometer-apply') }}
      </NButton>
    </div>
  </NPopover>
</template>

<style scoped>
/* ── Base: capsule (outer shell receives min-width) ───────────────── */
.speedometer {
  font-size: 12px;
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 20;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  min-width: 56px;
  height: 46px;
  padding: 6px 14px 6px 10px;
  border-radius: 100px;
  cursor: pointer;
  user-select: none;
  transition:
    width 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.2s ease,
    background 0.2s ease;
  border: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface-container);
  overflow: visible;
}

/* Mobile (Android): hide the floating speed capsule — it overlaps the
   bottom navigation bar and its right-click popover is desktop-only. */
@media (max-width: 600px) {
  .speedometer {
    display: none;
  }
}
.speedometer:hover {
  border-color: var(--m3-outline);
}
.speedometer:active {
  transform: scale(0.97);
}

/* ── Inner content wrapper (observed by ResizeObserver, no min-width) ─ */
.capsule-content {
  display: flex;
  align-items: center;
  width: fit-content;
  gap: 4px;
  padding-right: 2px;
}

/* ── IDLE — compact capsule ────────────────────────────────────── */
.speedometer.idle .mode i {
  color: var(--m3-outline);
  transform: rotate(-15deg);
}
.speedometer.idle .value {
  opacity: 0.55;
}
.speedometer.idle .speed-text {
  flex: 0;
  width: 0;
  opacity: 0;
  gap: 0;
}
.speedometer.idle .speed-row.download {
  color: var(--m3-outline);
}
.speedometer.idle .speed-row.download .speed-arrow {
  color: var(--m3-outline);
}

/* ── LIMITED — tertiary color accent ─────────────────────────────── */
.speedometer.limited {
  border-color: color-mix(in srgb, var(--m3-tertiary) 32%, transparent);
}
.speedometer.limited:hover {
  border-color: var(--m3-tertiary);
}
.speedometer.limited .mode i {
  color: var(--m3-tertiary);
}
.speedometer.limited .speed-row.download {
  color: var(--m3-tertiary);
}
.speedometer.limited .speed-row.download .speed-arrow {
  color: var(--m3-tertiary);
}

/* ── Common ──────────────────────────────────────────────────────── */
.speedometer em {
  font-style: normal;
}
.mode {
  flex-shrink: 0;
}
.mode i {
  font-size: 22px;
  font-style: normal;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  padding: 2px;
  position: relative;
  color: var(--m3-primary);
  transition:
    transform 0.35s ease,
    color 0.2s ease;
  transform: rotate(0deg);
}
.value {
  overflow: hidden;
  width: 100%;
  white-space: nowrap;
  text-overflow: ellipsis;
  opacity: 1;
  transition: opacity 0.3s ease;
}
.speed-row {
  display: flex;
  align-items: center;
}
.speed-text {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  overflow: hidden;
  min-width: 0;
  transition:
    width 0.4s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.3s ease,
    gap 0.3s ease;
}
.speed-arrow {
  flex-shrink: 0;
  opacity: 0.7;
}
.speed-row.upload {
  color: var(--m3-outline);
}
.speed-row.upload em {
  font-style: normal;
  font-size: 11px;
  line-height: 14px;
}
.speed-row.upload .speed-arrow {
  color: var(--m3-outline);
}
.speed-row.download {
  color: var(--m3-primary);
}
.speed-row.download .speed-text span {
  font-size: 13px;
  line-height: 16px;
  font-weight: 500;
}
.speed-row.download .speed-arrow {
  color: var(--m3-primary);
}
.speed-row.download .limit-value {
  font-size: 13px;
  font-weight: 500;
}

/* ── Lock pill (top-right corner badge, visible when limited) ──────── */
.lock-pill {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--m3-tertiary) 22%, var(--m3-surface-container));
  color: var(--m3-tertiary);
  font-size: 10px;
  border: 1px solid color-mix(in srgb, var(--m3-tertiary) 30%, transparent);
}

/* ── Clock pill (top-right badge, visible when schedule is active) ── */
.clock-pill {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--m3-primary) 22%, var(--m3-surface-container));
  color: var(--m3-primary);
  font-size: 10px;
  border: 1px solid color-mix(in srgb, var(--m3-primary) 30%, transparent);
}

/* Lock pill pop animation — bouncy enter, smooth exit */
.lock-pop-enter-active {
  transition:
    transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 0.2s ease;
}
.lock-pop-leave-active {
  transition:
    transform 0.25s cubic-bezier(0.4, 0, 1, 1),
    opacity 0.2s ease;
  pointer-events: none;
}
.lock-pop-enter-from,
.lock-pop-leave-to {
  transform: scale(0);
  opacity: 0;
}

/* ── Limit zone (auto width, never truncates) ──────────────────────── */
.limit-zone {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.limit-sep {
  opacity: 0.3;
  font-size: 11px;
  flex-shrink: 0;
}
.limit-value {
  font-size: 11px;
  opacity: 0.65;
  flex-shrink: 0;
  font-weight: 400;
}
.limit-inf {
  opacity: 0.35;
  flex-shrink: 0;
}

/* ── Limit value crossfade transition ────────────────────────────── */
.limit-fade-enter-active,
.limit-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.2, 0, 0, 1);
}
.limit-fade-enter-from,
.limit-fade-leave-to {
  opacity: 0;
}

/* ── Popover panel ────────────────────────────────────────────────── */
.limit-panel {
  padding: 4px 0;
  min-width: 290px;
}
.limit-panel-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--m3-on-surface);
}
.limit-panel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.limit-panel-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  min-width: 90px;
  flex-shrink: 0;
  opacity: 0.8;
}
.limit-panel-inputs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

/* ── Hint slide-fade transition ───────────────────────────────────── */
.hint-slide-enter-active,
.hint-slide-leave-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1),
    max-height 0.25s cubic-bezier(0.2, 0, 0, 1);
  overflow: hidden;
}
.hint-slide-enter-from,
.hint-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
  max-height: 0;
}
.hint-slide-enter-to,
.hint-slide-leave-from {
  max-height: 40px;
}
</style>
