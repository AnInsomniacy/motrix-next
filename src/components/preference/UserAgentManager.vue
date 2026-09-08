<script setup lang="ts">
/** @fileoverview User-Agent profile and host-rule manager. */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import Sortable from 'sortablejs'
import type { SortableEvent, SortableOptions } from 'sortablejs'
import {
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  NTab,
  NTabs,
  NText,
} from 'naive-ui'
import { AddOutline, ArrowForwardOutline, ReorderThreeOutline } from '@vicons/ionicons5'
import { vMotionAutoAnimate } from '@/directives/motionAutoAnimate'
import { useAppMessage } from '@/composables/useAppMessage'
import { useReducedMotion } from '@/composables/useReducedMotion'
import { useUserAgentManager } from '@/composables/useUserAgentManager'
import type { UserAgentProfile, UserAgentRule } from '@shared/types'
import { isValidUserAgentHostPattern } from '@shared/utils/userAgentPolicy'

const props = defineProps<{
  show: boolean
  profiles: UserAgentProfile[]
  rules: UserAgentRule[]
  recentProfileIds: string[]
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  save: [payload: { profiles: UserAgentProfile[]; rules: UserAgentRule[]; recentProfileIds: string[] }]
}>()

const { t } = useI18n()
const message = useAppMessage()
const reduceMotion = useReducedMotion()
const manager = useUserAgentManager()
type RuleListRefTarget = Element | ComponentPublicInstance | null
const ruleListRef = ref<RuleListRefTarget>(null)
const sortingRules = ref(false)
let sortable: Sortable | null = null
let lastFloatingRect: DOMRect | null = null
let floatingRectFrame = 0

type ManagerView = 'profiles-empty' | 'profiles-workspace' | 'rules-no-profile' | 'rules-empty' | 'rules-workspace'

const activeView = computed<ManagerView>(() => {
  if (manager.activePanel.value === 'profiles') {
    return manager.profiles.value.length === 0 ? 'profiles-empty' : 'profiles-workspace'
  }
  if (manager.profiles.value.length === 0) return 'rules-no-profile'
  return manager.rules.value.length === 0 ? 'rules-empty' : 'rules-workspace'
})

const selectedProfileRuleCount = computed(() =>
  manager.selectedProfile.value ? manager.profileRuleCount(manager.selectedProfile.value.id) : 0,
)
const selectedRuleProfileName = computed(
  () =>
    manager.profileOptions.value.find((option) => option.value === manager.selectedRule.value?.profileId)?.label ?? '',
)
const canDeleteSelected = computed(() =>
  manager.activePanel.value === 'profiles'
    ? Boolean(manager.selectedProfile.value)
    : Boolean(manager.selectedRule.value),
)
const profileNameInvalid = computed(
  () => manager.validationRequested.value && !manager.selectedProfile.value?.name.trim(),
)
const profileValueInvalid = computed(
  () => manager.validationRequested.value && !manager.selectedProfile.value?.value.trim(),
)
const ruleHostInvalid = computed(
  () =>
    manager.validationRequested.value && !isValidUserAgentHostPattern(manager.selectedRule.value?.hostPattern ?? ''),
)
const ruleProfileInvalid = computed(
  () =>
    manager.validationRequested.value &&
    !manager.profileOptions.value.some((option) => option.value === manager.selectedRule.value?.profileId),
)
const pluginBehavior = computed<'preserve' | 'override'>({
  get: () => (manager.selectedRule.value?.overridePlugin ? 'override' : 'preserve'),
  set: (value) => {
    if (manager.selectedRule.value) manager.selectedRule.value.overridePlugin = value === 'override'
  },
})

function profileMeta(profile: UserAgentProfile): string {
  const count = manager.profileRuleCount(profile.id)
  return count > 0 ? t('preferences.ua-profile-rule-count', { count }) : t('preferences.ua-no-rules')
}

function profileName(id: string): string {
  return manager.profiles.value.find((profile) => profile.id === id)?.name ?? id
}

function handlePanelChange(value: string | number): void {
  if (value === 'profiles' || value === 'rules') manager.activePanel.value = value
}

function addProfile(): void {
  manager.addProfile(t('preferences.ua-new-profile'))
}

function addRule(): void {
  manager.addRule()
}

function removeProfile(): void {
  if (!manager.removeProfile()) message.error(t('preferences.ua-profile-in-use'))
}

function removeRule(): void {
  manager.removeRule()
}

function removeSelected(): void {
  if (manager.activePanel.value === 'profiles') removeProfile()
  else removeRule()
}

function openProfileSetup(): void {
  manager.activePanel.value = 'profiles'
  addProfile()
}

function closeModal(): void {
  destroySortable()
  emit('update:show', false)
}

function handleSave(): void {
  const error = manager.validate()
  if (error) {
    message.error(error.kind === 'profile' ? t('preferences.ua-profile-invalid') : t('preferences.ua-rule-invalid'))
    return
  }
  emit('save', manager.payload())
  closeModal()
}

function trackFloatingRect(): void {
  const floating = document.querySelector<HTMLElement>('.ua-manager-rule-row--floating')
  if (floating?.isConnected) lastFloatingRect = floating.getBoundingClientRect()
  if (sortingRules.value) floatingRectFrame = requestAnimationFrame(trackFloatingRect)
}

function startFloatingRectTracking(): void {
  stopFloatingRectTracking()
  lastFloatingRect = null
  floatingRectFrame = requestAnimationFrame(trackFloatingRect)
}

function stopFloatingRectTracking(): void {
  if (!floatingRectFrame) return
  cancelAnimationFrame(floatingRectFrame)
  floatingRectFrame = 0
}

function animateDropSettle(event: SortableEvent): Promise<void> {
  const item = event.item
  if (!lastFloatingRect || !item.isConnected) return Promise.resolve()
  if (reduceMotion.value) {
    lastFloatingRect = null
    return Promise.resolve()
  }

  const targetRect = item.getBoundingClientRect()
  const deltaX = lastFloatingRect.left - targetRect.left
  const deltaY = lastFloatingRect.top - targetRect.top
  lastFloatingRect = null
  if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return Promise.resolve()

  item.classList.add('ua-manager-rule-row--settling')
  item.style.setProperty('--ua-rule-drop-x', `${deltaX}px`)
  item.style.setProperty('--ua-rule-drop-y', `${deltaY}px`)

  return new Promise((resolve) => {
    requestAnimationFrame(() => item.classList.add('ua-manager-rule-row--settled'))
    window.setTimeout(() => {
      item.classList.remove('ua-manager-rule-row--settling', 'ua-manager-rule-row--settled')
      item.style.removeProperty('--ua-rule-drop-x')
      item.style.removeProperty('--ua-rule-drop-y')
      resolve()
    }, 320)
  })
}

function removeRuleDragArtifacts(): void {
  document.querySelectorAll<HTMLElement>('.ua-manager-rule-row--floating').forEach((element) => element.remove())
}

function destroySortable(): void {
  stopFloatingRectTracking()
  sortable?.destroy()
  sortable = null
  sortingRules.value = false
  lastFloatingRect = null
  removeRuleDragArtifacts()
}

const sortableOptions: SortableOptions = {
  animation: reduceMotion.value ? 0 : 240,
  handle: '.ua-manager-rule-handle',
  draggable: '.ua-manager-rule-row',
  filter: 'button:not(.ua-manager-rule-handle), a, input, textarea, select, [data-no-drag]',
  ghostClass: 'ua-manager-rule-row--ghost',
  chosenClass: 'ua-manager-rule-row--chosen',
  fallbackClass: 'ua-manager-rule-row--floating',
  dragClass: 'ua-manager-rule-row--dragging',
  direction: 'vertical',
  swapThreshold: 0.72,
  invertedSwapThreshold: 0.28,
  invertSwap: false,
  forceFallback: true,
  fallbackOnBody: true,
  fallbackTolerance: 3,
  preventOnFilter: false,
  onStart: () => {
    sortingRules.value = true
    if (!reduceMotion.value) startFloatingRectTracking()
  },
  onUpdate: (event) => {
    if (event.oldIndex === undefined || event.newIndex === undefined) return
    manager.moveRule(event.oldIndex, event.newIndex)
  },
  onEnd: async (event) => {
    stopFloatingRectTracking()
    await nextTick()
    await animateDropSettle(event)
    window.setTimeout(() => {
      sortingRules.value = false
    }, 0)
  },
}

function resolveRuleListElement(): HTMLElement | null {
  const target = ruleListRef.value
  if (target instanceof Element) return target instanceof HTMLElement ? target : null
  const element = target?.$el
  return element instanceof HTMLElement ? element : null
}

function mountSortable(): void {
  destroySortable()
  const element = resolveRuleListElement()
  if (!element) return
  sortable = Sortable.create(element, sortableOptions)
}

watch(
  () => props.show,
  (show) => {
    if (!show) {
      destroySortable()
      return
    }
    removeRuleDragArtifacts()
    manager.reset({
      profiles: props.profiles,
      rules: props.rules,
      recentProfileIds: props.recentProfileIds,
    })
  },
)

watch(
  ruleListRef,
  async (target) => {
    if (!target) {
      destroySortable()
      return
    }
    await nextTick()
    mountSortable()
  },
  { flush: 'post' },
)

watch(reduceMotion, (enabled) => {
  const duration = enabled ? 0 : 240
  sortableOptions.animation = duration
  sortable?.option('animation', duration)
})

onMounted(removeRuleDragArtifacts)

onUnmounted(() => {
  destroySortable()
})
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="false"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <NCard closable class="ua-manager-card" :bordered="false" @close="closeModal">
      <template #header>
        <div class="ua-manager-heading">
          <strong>{{ t('preferences.ua-manager-title') }}</strong>
          <NText depth="3">{{ t('preferences.ua-manager-description') }}</NText>
        </div>
      </template>

      <NTabs :value="manager.activePanel.value" type="segment" @update:value="handlePanelChange">
        <NTab name="profiles">{{ t('preferences.ua-saved') }} · {{ manager.profiles.value.length }}</NTab>
        <NTab name="rules">{{ t('preferences.ua-rules') }} · {{ manager.rules.value.length }}</NTab>
      </NTabs>

      <div class="ua-manager-content-stage">
        <Transition name="fade-scale" mode="out-in">
          <div v-if="manager.activePanel.value === 'profiles'" :key="activeView" class="ua-manager-pane-stage">
            <div v-if="manager.profiles.value.length === 0" class="ua-manager-full-empty">
              <NEmpty :description="t('task.ua-no-saved')">
                <template #extra>
                  <NButton type="primary" :disabled="!manager.canAddProfile.value" @click="addProfile">
                    <template #icon
                      ><NIcon><AddOutline /></NIcon
                    ></template>
                    {{ t('preferences.ua-add-profile') }}
                  </NButton>
                </template>
              </NEmpty>
            </div>

            <div v-else class="ua-manager-workspace">
              <aside class="ua-manager-sidebar">
                <div class="ua-manager-sidebar-header">
                  <NText depth="3">{{ t('preferences.ua-saved') }}</NText>
                  <NButton size="small" secondary :disabled="!manager.canAddProfile.value" @click="addProfile">
                    <template #icon
                      ><NIcon><AddOutline /></NIcon
                    ></template>
                    {{ t('preferences.ua-add-profile') }}
                  </NButton>
                </div>
                <div v-motion-auto-animate="{ duration: 220, easing: 'ease-out' }" class="ua-manager-list">
                  <NButton
                    v-for="profile in manager.profiles.value"
                    :key="profile.id"
                    block
                    class="ua-manager-list-button"
                    :secondary="manager.selectedProfileId.value === profile.id"
                    :quaternary="manager.selectedProfileId.value !== profile.id"
                    :aria-pressed="manager.selectedProfileId.value === profile.id"
                    @click="manager.selectProfile(profile.id)"
                  >
                    <span class="ua-manager-list-copy">
                      <span class="ua-manager-list-title">{{ profile.name }}</span>
                      <span class="ua-manager-list-meta">{{ profileMeta(profile) }}</span>
                    </span>
                  </NButton>
                </div>
              </aside>

              <section v-motion-auto-animate="{ duration: 200, easing: 'ease-out' }" class="ua-manager-editor">
                <NForm
                  v-if="manager.selectedProfile.value"
                  :key="manager.selectedProfile.value.id"
                  label-placement="top"
                  size="small"
                >
                  <NFormItem
                    :label="t('preferences.ua-profile-name')"
                    :validation-status="profileNameInvalid ? 'error' : undefined"
                    :feedback="profileNameInvalid ? t('preferences.ua-profile-invalid') : undefined"
                  >
                    <NInput v-model:value="manager.selectedProfile.value.name" />
                  </NFormItem>
                  <NFormItem
                    :label="t('preferences.user-agent')"
                    :validation-status="profileValueInvalid ? 'error' : undefined"
                    :feedback="profileValueInvalid ? t('preferences.ua-profile-invalid') : undefined"
                  >
                    <NInput
                      v-model:value="manager.selectedProfile.value.value"
                      type="textarea"
                      :autosize="{ minRows: 5, maxRows: 9 }"
                    />
                  </NFormItem>
                  <NText depth="3" class="ua-manager-editor-note">
                    {{ t('preferences.ua-profile-rule-count', { count: selectedProfileRuleCount }) }}
                  </NText>
                </NForm>
              </section>
            </div>
          </div>

          <div v-else :key="activeView" class="ua-manager-pane-stage">
            <div v-if="manager.profiles.value.length === 0" class="ua-manager-full-empty">
              <NEmpty :description="t('preferences.ua-rules-require-profile')">
                <template #extra>
                  <NButton type="primary" @click="openProfileSetup">
                    <template #icon
                      ><NIcon><AddOutline /></NIcon
                    ></template>
                    {{ t('preferences.ua-add-profile') }}
                  </NButton>
                </template>
              </NEmpty>
            </div>

            <div v-else-if="manager.rules.value.length === 0" class="ua-manager-full-empty">
              <NEmpty :description="t('preferences.ua-no-rules')">
                <template #extra>
                  <NButton type="primary" :disabled="!manager.canAddRule.value" @click="addRule">
                    <template #icon
                      ><NIcon><AddOutline /></NIcon
                    ></template>
                    {{ t('preferences.ua-add-rule') }}
                  </NButton>
                </template>
              </NEmpty>
            </div>

            <div v-else class="ua-manager-workspace">
              <aside class="ua-manager-sidebar">
                <div class="ua-manager-sidebar-header ua-manager-sidebar-header--stacked">
                  <NText depth="3">{{ t('preferences.ua-rule-order-hint') }}</NText>
                  <NButton size="small" secondary :disabled="!manager.canAddRule.value" @click="addRule">
                    <template #icon
                      ><NIcon><AddOutline /></NIcon
                    ></template>
                    {{ t('preferences.ua-add-rule') }}
                  </NButton>
                </div>
                <TransitionGroup
                  ref="ruleListRef"
                  tag="div"
                  name="ua-manager-rule-row"
                  class="ua-manager-list ua-manager-rule-list"
                  :css="!sortingRules"
                >
                  <div
                    v-for="rule in manager.rules.value"
                    :key="rule.id"
                    role="button"
                    tabindex="0"
                    class="ua-manager-rule-row"
                    :class="{ 'ua-manager-rule-row--active': manager.selectedRuleId.value === rule.id }"
                    :aria-pressed="manager.selectedRuleId.value === rule.id"
                    @click="manager.selectRule(rule.id)"
                    @keydown.enter.prevent="manager.selectRule(rule.id)"
                    @keydown.space.prevent="manager.selectRule(rule.id)"
                  >
                    <span
                      class="ua-manager-rule-handle"
                      role="button"
                      tabindex="0"
                      :aria-label="t('preferences.ua-rule-reorder')"
                      @click.stop
                      @pointerdown="manager.selectRule(rule.id)"
                    >
                      <NIcon aria-hidden="true"><ReorderThreeOutline /></NIcon>
                    </span>
                    <span class="ua-manager-list-copy">
                      <span class="ua-manager-list-title">{{ rule.hostPattern || t('preferences.ua-new-rule') }}</span>
                      <span class="ua-manager-list-meta">
                        {{ profileName(rule.profileId) }} ·
                        {{ rule.enabled ? t('preferences.ua-rule-enabled') : t('preferences.ua-rule-disabled') }}
                      </span>
                    </span>
                  </div>
                </TransitionGroup>
              </aside>

              <section v-motion-auto-animate="{ duration: 200, easing: 'ease-out' }" class="ua-manager-editor">
                <NForm
                  v-if="manager.selectedRule.value"
                  :key="manager.selectedRule.value.id"
                  label-placement="top"
                  size="small"
                >
                  <NFormItem :label="t('preferences.ua-rule-enabled')">
                    <NSwitch v-model:value="manager.selectedRule.value.enabled" />
                  </NFormItem>
                  <NFormItem
                    :label="t('preferences.ua-rule-host')"
                    :validation-status="ruleHostInvalid ? 'error' : undefined"
                    :feedback="ruleHostInvalid ? t('preferences.ua-rule-invalid') : t('preferences.ua-rule-host-hint')"
                  >
                    <NInput v-model:value="manager.selectedRule.value.hostPattern" placeholder="*.example.com" />
                  </NFormItem>
                  <NFormItem
                    :label="t('preferences.ua-rule-profile')"
                    :validation-status="ruleProfileInvalid ? 'error' : undefined"
                    :feedback="ruleProfileInvalid ? t('preferences.ua-rule-invalid') : undefined"
                  >
                    <NSelect
                      v-model:value="manager.selectedRule.value.profileId"
                      :options="manager.profileOptions.value"
                    />
                  </NFormItem>
                  <NFormItem :label="t('preferences.ua-browser-user-agent')">
                    <NRadioGroup v-model:value="pluginBehavior" size="small">
                      <NRadioButton value="preserve">{{ t('preferences.ua-override-off') }}</NRadioButton>
                      <NRadioButton value="override">{{ t('preferences.ua-override-on') }}</NRadioButton>
                    </NRadioGroup>
                  </NFormItem>
                  <div class="ua-manager-rule-preview">
                    <div class="ua-manager-rule-flow">
                      <strong>{{ manager.selectedRule.value.hostPattern || '*.example.com' }}</strong>
                      <NIcon aria-hidden="true"><ArrowForwardOutline /></NIcon>
                      <strong>{{ selectedRuleProfileName }}</strong>
                    </div>
                    <NText depth="3">
                      {{
                        manager.selectedRule.value.overridePlugin
                          ? t('preferences.ua-override-on')
                          : t('preferences.ua-override-off')
                      }}
                    </NText>
                  </div>
                </NForm>
              </section>
            </div>
          </div>
        </Transition>
      </div>

      <template #footer>
        <NSpace justify="space-between" align="center">
          <div class="ua-manager-footer-left">
            <Transition name="fade-scale">
              <NButton v-if="canDeleteSelected" size="small" ghost type="error" @click="removeSelected">
                {{ t('app.delete') }}
              </NButton>
            </Transition>
          </div>
          <NSpace>
            <NButton @click="closeModal">{{ t('app.cancel') }}</NButton>
            <NButton type="primary" @click="handleSave">{{ t('app.save') }}</NButton>
          </NSpace>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.ua-manager-card {
  width: min(820px, calc(100vw - 32px));
  max-height: min(740px, calc(100vh - 32px));
}

.ua-manager-card :deep(.n-card__content) {
  min-height: 0;
  overflow: hidden;
}

.ua-manager-heading {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ua-manager-heading strong {
  font-size: 18px;
  font-weight: 600;
}

.ua-manager-heading .n-text {
  font-size: 12px;
  font-weight: 400;
}

.ua-manager-content-stage {
  height: clamp(340px, 55vh, 490px);
  min-height: 0;
  margin-top: 16px;
}

.ua-manager-pane-stage {
  height: 100%;
  min-height: 0;
}

.ua-manager-workspace {
  display: grid;
  grid-template-columns: minmax(220px, 270px) minmax(0, 1fr);
  gap: 20px;
  height: 100%;
  min-height: 0;
}

.ua-manager-sidebar,
.ua-manager-editor {
  min-width: 0;
  min-height: 0;
}

.ua-manager-sidebar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 16px;
  border-right: 1px solid var(--m3-outline-variant);
}

.ua-manager-sidebar-header {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ua-manager-sidebar-header--stacked {
  align-items: flex-start;
}

.ua-manager-sidebar-header .n-text {
  font-size: 12px;
  line-height: 1.4;
}

.ua-manager-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ua-manager-list-button {
  height: auto;
  min-height: 56px;
  padding: 8px 10px;
  justify-content: flex-start;
}

.ua-manager-list-button :deep(.n-button__content) {
  width: 100%;
  min-width: 0;
  justify-content: flex-start;
}

.ua-manager-list-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  text-align: left;
}

.ua-manager-list-title,
.ua-manager-list-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ua-manager-list-title {
  font-size: 13px;
  font-weight: 500;
}

.ua-manager-list-meta {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
}

.ua-manager-rule-list {
  position: relative;
  gap: 0;
}

.ua-manager-rule-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  width: 100%;
  min-height: 56px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 8px;
  color: var(--m3-on-surface);
  background: var(--m3-surface-container-low);
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.ua-manager-rule-row:hover,
.ua-manager-rule-row--active {
  border-color: var(--m3-primary);
}

.ua-manager-rule-row--active {
  background: var(--m3-surface-container-high);
}

.ua-manager-rule-handle {
  display: inline-flex;
  min-width: 24px;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--m3-on-surface-variant);
  cursor: grab;
  touch-action: none;
  transition:
    color 0.18s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.18s cubic-bezier(0.2, 0, 0, 1);
}

.ua-manager-rule-handle:hover {
  color: var(--m3-primary);
  background: var(--m3-surface-container-highest);
}

.ua-manager-rule-handle:active {
  cursor: grabbing;
}

.ua-manager-rule-row--ghost {
  overflow: hidden;
  opacity: 0;
}

.ua-manager-rule-row--floating,
.ua-manager-rule-row--dragging {
  opacity: 1 !important;
  filter: none !important;
  pointer-events: none;
  transition: none !important;
}

.ua-manager-rule-row--settling {
  z-index: 3;
  transform: translate3d(var(--ua-rule-drop-x), var(--ua-rule-drop-y), 0);
  will-change: transform;
}

.ua-manager-rule-row--settling.ua-manager-rule-row--settled {
  transform: translate3d(0, 0, 0);
  transition: transform 300ms ease;
}

.ua-manager-rule-row-move,
.ua-manager-rule-row-enter-active {
  transition:
    transform 260ms ease,
    opacity 180ms ease;
}

.ua-manager-rule-row-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.99);
}

.ua-manager-rule-row-leave-active {
  position: absolute;
  width: 100%;
  pointer-events: none;
  transition:
    transform 260ms ease,
    opacity 180ms ease;
}

.ua-manager-rule-row-leave-to {
  opacity: 0;
  transform: scale(0.995);
}

.ua-manager-editor {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px 4px 8px 0;
}

.ua-manager-editor :deep(.n-form-item) {
  margin-bottom: 10px;
}

.ua-manager-editor-note {
  display: block;
  font-size: 12px;
}

.ua-manager-rule-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 10px;
  background: var(--m3-surface-container-low);
}

.ua-manager-rule-flow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.ua-manager-rule-flow strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ua-manager-rule-flow strong:last-child {
  text-align: right;
}

.ua-manager-rule-preview .n-text {
  font-size: 12px;
}

.ua-manager-full-empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.ua-manager-footer-left {
  min-width: 88px;
  min-height: 34px;
}

@media (max-width: 720px) {
  .ua-manager-card {
    width: calc(100vw - 20px);
    max-height: calc(100vh - 20px);
  }

  .ua-manager-content-stage {
    height: min(570px, calc(100vh - 240px));
    min-height: 300px;
  }

  .ua-manager-workspace {
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
  }

  .ua-manager-sidebar {
    max-height: 210px;
    flex: 0 0 auto;
    padding-right: 0;
    padding-bottom: 14px;
    border-right: 0;
    border-bottom: 1px solid var(--m3-outline-variant);
  }

  .ua-manager-list {
    min-height: 96px;
  }

  .ua-manager-editor {
    flex: 0 0 auto;
    overflow: visible;
  }
}
</style>
