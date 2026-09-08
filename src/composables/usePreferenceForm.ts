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
import { filterHotReloadableKeys } from '@shared/utils/config'
import { changeGlobalOption, isEngineReady } from '@/api/aria2'
import { logger } from '@shared/logger'
import type { AppConfig } from '@shared/types'
import { validateAppConfigCandidate } from '@shared/configConstraints'
import { buildSystemConfigFromAppConfig } from '@shared/utils/systemConfig'

export interface UsePreferenceFormOptions<T extends Record<string, unknown>> {
  /** Build the initial form state from the current preference config. */
  buildForm: () => T

  /**
   * Map form values to the engine option snapshot.
   * Only system-level aria2 config keys belong here.
   */
  buildSystemConfig?: (form: T) => Record<string, string>

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

  /** Persistent progress and rollback messages for saves with visible latency. */
  saveFeedback?:
    | {
        success: string
        restored: string
        rollbackFailed: string
      }
    | ((
        form: T,
        prevConfig: Partial<AppConfig>,
      ) => {
        success: string
        restored: string
        rollbackFailed: string
      } | null)

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
    const initialStoreData: Partial<AppConfig> = options.transformForStore
      ? options.transformForStore(form.value as T)
      : { ...(form.value as T) }
    const initialIssues = validateAppConfigCandidate({ ...preferenceStore.config, ...initialStoreData })
    if (initialIssues.length > 0) {
      const { constraint } = initialIssues[0]
      message.error(t('preferences.value-range-error', { min: constraint.min, max: constraint.max }))
      return
    }

    if (options.beforeSave && !(await options.beforeSave(form.value as T))) {
      return
    }

    const prevConfig = { ...preferenceStore.config }
    const previousSystemConfig = options.buildSystemConfig?.(options.buildForm()) ?? {}

    const storeData: Partial<AppConfig> = options.transformForStore
      ? options.transformForStore(form.value as T)
      : { ...(form.value as T) }
    const candidate = { ...preferenceStore.config, ...storeData }
    const validationIssues = validateAppConfigCandidate(candidate)
    if (validationIssues.length > 0) {
      const { constraint } = validationIssues[0]
      message.error(t('preferences.value-range-error', { min: constraint.min, max: constraint.max }))
      return
    }
    const systemConfig = options.buildSystemConfig?.(form.value as T) ?? {}
    const savedForm = JSON.parse(JSON.stringify(form.value)) as T
    const hotConfig = filterHotReloadableKeys(systemConfig)
    const previousHotConfig = filterHotReloadableKeys(previousSystemConfig)
    const changedHotConfig = Object.fromEntries(
      Object.entries(hotConfig).filter(([key, value]) => previousHotConfig[key] !== value),
    )
    const rollbackHotConfig = Object.fromEntries(
      Object.keys(changedHotConfig)
        .filter((key) => previousHotConfig[key] !== undefined)
        .map((key) => [key, previousHotConfig[key]]),
    )
    const shouldHotReload = isEngineReady() && Object.keys(changedHotConfig).length > 0
    let hotReloadAttempted = false
    let preferencesPersisted = false
    let systemConfigWriteAttempted = false
    const saveFeedback =
      typeof options.saveFeedback === 'function'
        ? options.saveFeedback(form.value as T, prevConfig)
        : options.saveFeedback
    try {
      if (shouldHotReload) {
        hotReloadAttempted = true
        await changeGlobalOption(changedHotConfig as Partial<AppConfig>)
      }

      const saved = await preferenceStore.updateAndSave(storeData)
      if (!saved) {
        throw new Error('Preference persistence failed')
      }
      preferencesPersisted = true

      if (Object.keys(systemConfig).length > 0) {
        systemConfigWriteAttempted = true
        await invoke('replace_system_config', {
          config: buildSystemConfigFromAppConfig(candidate as AppConfig, String(candidate.dir ?? '')),
        })
      }

      await options.afterSave?.(savedForm, prevConfig)
    } catch (error) {
      let rollbackFailed = false
      logger.error('PreferenceForm.save', error)

      if (preferencesPersisted) {
        const restored = await preferenceStore.updateAndSave(prevConfig)
        if (!restored) {
          rollbackFailed = true
          logger.error('PreferenceForm.rollback', 'failed to restore preference config')
        }
      }
      if (systemConfigWriteAttempted && Object.keys(previousSystemConfig).length > 0) {
        try {
          await invoke('replace_system_config', {
            config: buildSystemConfigFromAppConfig(prevConfig as AppConfig, String(prevConfig.dir ?? '')),
          })
        } catch (rollbackError) {
          rollbackFailed = true
          logger.error('PreferenceForm.rollbackSystemConfig', rollbackError)
        }
      }
      if (hotReloadAttempted && Object.keys(rollbackHotConfig).length > 0) {
        try {
          await changeGlobalOption(rollbackHotConfig as Partial<AppConfig>)
        } catch (rollbackError) {
          rollbackFailed = true
          logger.error('PreferenceForm.rollback', rollbackError)
        }
      }
      if (!rollbackFailed) {
        Object.assign(form.value, options.buildForm())
        savedSnapshot.value = JSON.parse(JSON.stringify(form.value)) as T
      }
      message.error(
        saveFeedback
          ? rollbackFailed
            ? saveFeedback.rollbackFailed
            : saveFeedback.restored
          : t('preferences.save-fail-message'),
      )
      throw error
    }

    // Only mark as saved AFTER both stores persist successfully.
    // Moving this earlier would clear the dirty flag prematurely,
    // causing route-leave guards to skip if an async save fails.
    Object.assign(form.value, options.buildForm())
    savedSnapshot.value = JSON.parse(JSON.stringify(form.value)) as T

    if (saveFeedback) message.success(saveFeedback.success)
    message.success(t('preferences.save-success-message'))
  }

  function handleReset(): void {
    const hadChanges = isDirty.value
    Object.assign(form.value as Record<string, unknown>, options.buildForm())
    savedSnapshot.value = JSON.parse(JSON.stringify(form.value)) as T
    if (hadChanges) {
      message.success(t('preferences.changes-restored'))
    }
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
