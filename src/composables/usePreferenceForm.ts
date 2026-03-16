/**
 * @fileoverview Composable that centralizes dirty-tracking, save/reset lifecycle,
 * and `saveBeforeLeave` registration for preference form pages (Basic / Advanced).
 *
 * Eliminates duplicated boilerplate across preference sub-route components and
 * fixes the silent-discard bug when switching between Basic ↔ Advanced tabs.
 */
import { ref, computed, onMounted, onUnmounted, watchSyncEffect, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { isEqual } from 'lodash-es'
import { invoke } from '@tauri-apps/api/core'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import type { AppConfig } from '@shared/types'

export interface UsePreferenceFormOptions<T extends Record<string, unknown>> {
  /** Build the initial form state from the current preference config. */
  buildForm: () => T

  /**
   * Map form values to the key-value pairs sent to `save_system_config`.
   * Only system-level aria2 config keys belong here.
   */
  buildSystemConfig: (form: T) => Record<string, string>

  /**
   * Optional pre-save hook. Return `false` to abort the save (e.g. validation failure).
   * May return a Promise for async confirmation dialogs (e.g. security warnings).
   * The hook is responsible for displaying its own error messages.
   */
  beforeSave?: (form: T) => boolean | Promise<boolean>

  /**
   * Optional post-save hook for side-effects that depend on the saved values
   * (e.g. showing a "restart required" dialog when the locale changes).
   */
  afterSave?: (form: T, prevConfig: Partial<AppConfig>) => void | Promise<void>

  /**
   * Optional transform applied to the form data before passing it to
   * `preferenceStore.updateAndSave`. Defaults to spreading the form as-is.
   */
  transformForStore?: (form: T) => Partial<AppConfig>
}

/**
 * Manages the full lifecycle of a preference form page:
 * - Reactive `form` ref with dirty detection against a saved snapshot
 * - Synchronizes `preferenceStore.pendingChanges` via `watchSyncEffect`
 * - Registers/unregisters `saveBeforeLeave` callback for the route-guard dialog
 * - Provides `handleSave` / `handleReset` functions wired to the action bar
 */
export function usePreferenceForm<T extends Record<string, unknown>>(options: UsePreferenceFormOptions<T>) {
  const { t } = useI18n()
  const preferenceStore = usePreferenceStore()
  const message = useAppMessage()

  // ── Reactive State ──────────────────────────────────────────────────

  const form: Ref<T> = ref(options.buildForm()) as Ref<T>
  const savedSnapshot: Ref<T> = ref(JSON.parse(JSON.stringify(options.buildForm()))) as Ref<T>

  const isDirty = computed(() => !isEqual(JSON.parse(JSON.stringify(form.value)), savedSnapshot.value))

  // ── Store Synchronization ───────────────────────────────────────────

  watchSyncEffect(() => {
    preferenceStore.pendingChanges = isDirty.value
  })

  // ── Save & Reset ────────────────────────────────────────────────────

  async function handleSave(): Promise<void> {
    if (options.beforeSave && !(await options.beforeSave(form.value as T))) {
      return
    }

    // Snapshot previous config BEFORE mutating the store,
    // so afterSave hooks can compare old vs new values.
    const prevConfig = { ...preferenceStore.config }

    const storeData: Partial<AppConfig> = options.transformForStore
      ? options.transformForStore(form.value as T)
      : { ...(form.value as T) }

    const saved = await preferenceStore.updateAndSave(storeData)
    if (!saved) {
      message.error(t('preferences.save-fail-message'))
      throw new Error('Preference persistence failed')
    }

    const systemConfig = options.buildSystemConfig(form.value as T)
    if (Object.keys(systemConfig).length > 0) {
      await invoke('save_system_config', { config: systemConfig })
    }

    // Only mark as saved AFTER both stores persist successfully.
    // Moving this earlier would clear the dirty flag prematurely,
    // causing route-leave guards to skip if an async save fails.
    savedSnapshot.value = JSON.parse(JSON.stringify(form.value)) as T

    message.success(t('preferences.save-success-message'))

    await options.afterSave?.(form.value as T, prevConfig)
  }

  function handleReset(): void {
    Object.assign(form.value as Record<string, unknown>, options.buildForm())
    savedSnapshot.value = JSON.parse(JSON.stringify(form.value)) as T
  }

  /** Marks the current form state as the saved baseline (clears dirty flag). */
  function resetSnapshot(): void {
    savedSnapshot.value = JSON.parse(JSON.stringify(form.value)) as T
  }

  /**
   * Partially update the saved snapshot without marking the entire form clean.
   * Use this when a single field is persisted immediately (e.g. update channel
   * radio) but other unsaved edits must retain their dirty state.
   */
  function patchSnapshot(patch: Partial<T>): void {
    savedSnapshot.value = { ...savedSnapshot.value, ...patch } as T
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  onMounted(() => {
    preferenceStore.saveBeforeLeave = handleSave
  })

  onUnmounted(() => {
    // Only clear the callback — do NOT reset pendingChanges here.
    // The route guard is responsible for clearing pendingChanges when the
    // user confirms navigation. Resetting here would silently discard
    // unsaved changes when switching between Basic ↔ Advanced tabs.
    preferenceStore.saveBeforeLeave = null
  })

  return {
    form,
    isDirty,
    handleSave,
    handleReset,
    resetSnapshot,
    patchSnapshot,
  }
}
