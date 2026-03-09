/**
 * @fileoverview Tests for the usePreferenceForm composable.
 *
 * Key behaviors under test:
 * - isDirty tracks shallow and deep changes via isEqual snapshot comparison
 * - handleSave persists to store and invokes save_system_config IPC
 * - handleReset restores form to initial state and clears dirty flag
 * - beforeSave returning false aborts the save
 * - afterSave receives previous config snapshot
 * - patchSnapshot partially updates the baseline without clearing other dirty fields
 * - resetSnapshot sets current form as clean baseline
 *
 * HONESTY NOTE: All tests use withSetup() to execute the composable inside
 * a real Vue component's setup context, ensuring onMounted/onUnmounted
 * hooks fire correctly. No lifecycle warnings should be emitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

// ── Mock Tauri invoke ───────────────────────────────────────────────
const mockInvoke = vi.fn().mockResolvedValue(undefined)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// ── Mock naive-ui (useMessage + useNotification needed by composables) ──
vi.mock('naive-ui', () => ({
  useMessage: () => ({
    success: vi.fn(() => ({ destroy: vi.fn() })),
    error: vi.fn(() => ({ destroy: vi.fn() })),
    warning: vi.fn(() => ({ destroy: vi.fn() })),
    info: vi.fn(() => ({ destroy: vi.fn() })),
  }),
  useNotification: () => ({
    error: vi.fn(() => ({ destroy: vi.fn() })),
    warning: vi.fn(() => ({ destroy: vi.fn() })),
    info: vi.fn(() => ({ destroy: vi.fn() })),
    success: vi.fn(() => ({ destroy: vi.fn() })),
  }),
}))

// ── Mock vue-i18n ───────────────────────────────────────────────────
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, te: () => false }),
}))

import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '../usePreferenceForm'

interface TestForm extends Record<string, unknown> {
  dir: string
  maxConcurrentDownloads: number
  locale: string
}

function makeOptions(overrides: Partial<Parameters<typeof usePreferenceForm<TestForm>>[0]> = {}) {
  return {
    buildForm: () => ({
      dir: '/downloads',
      maxConcurrentDownloads: 5,
      locale: 'en-US',
    }),
    buildSystemConfig: (f: TestForm) => ({
      dir: f.dir,
      'max-concurrent-downloads': String(f.maxConcurrentDownloads),
    }),
    ...overrides,
  }
}

/**
 * Mounts a wrapper component that calls the composable in setup context,
 * eliminating Vue lifecycle warnings from onMounted/onUnmounted.
 */
function withSetup<T>(composableFn: () => T): { result: T; unmount: () => void } {
  let result!: T
  const wrapper = mount(
    defineComponent({
      setup() {
        result = composableFn()
        return {}
      },
      template: '<div />',
    }),
    {
      global: {
        plugins: [],
      },
    },
  )
  return { result, unmount: () => wrapper.unmount() }
}

describe('usePreferenceForm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('initialises form with buildForm values and isDirty=false', () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, isDirty } = result

    expect(form.value.dir).toBe('/downloads')
    expect(form.value.maxConcurrentDownloads).toBe(5)
    expect(isDirty.value).toBe(false)

    unmount()
  })

  it('marks isDirty=true when a form field is changed', async () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, isDirty } = result

    form.value.dir = '/new-downloads'
    await nextTick()

    expect(isDirty.value).toBe(true)

    unmount()
  })

  it('marks isDirty=false after resetSnapshot', async () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, isDirty, resetSnapshot } = result

    form.value.dir = '/changed'
    await nextTick()
    expect(isDirty.value).toBe(true)

    resetSnapshot()
    await nextTick()
    expect(isDirty.value).toBe(false)

    unmount()
  })

  it('handleReset restores form to initial values and clears dirty', async () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, isDirty, handleReset } = result

    form.value.dir = '/modified'
    form.value.maxConcurrentDownloads = 10
    await nextTick()
    expect(isDirty.value).toBe(true)

    handleReset()
    await nextTick()

    expect(form.value.dir).toBe('/downloads')
    expect(form.value.maxConcurrentDownloads).toBe(5)
    expect(isDirty.value).toBe(false)

    unmount()
  })

  it('handleSave persists to store and calls save_system_config IPC', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleSave, isDirty } = result

    form.value.maxConcurrentDownloads = 8
    await handleSave()

    expect(store.updateAndSave).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentDownloads: 8 }))
    expect(mockInvoke).toHaveBeenCalledWith('save_system_config', {
      config: expect.objectContaining({ 'max-concurrent-downloads': '8' }),
    })
    expect(isDirty.value).toBe(false)

    unmount()
  })

  it('aborts save when beforeSave returns false', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions({ beforeSave: () => false })))
    const { handleSave } = result

    await handleSave()

    expect(store.updateAndSave).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()

    unmount()
  })

  it('calls afterSave with the previous config snapshot', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    store.config.locale = 'zh-CN'

    const afterSave = vi.fn()
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions({ afterSave })))
    const { handleSave, form } = result

    form.value.locale = 'ja'
    await handleSave()

    expect(afterSave).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ja' }),
      expect.objectContaining({ locale: 'zh-CN' }),
    )

    unmount()
  })

  it('patchSnapshot updates only specified fields in the baseline', async () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, isDirty, patchSnapshot, resetSnapshot } = result

    resetSnapshot()

    // Change two fields
    form.value.locale = 'ja'
    form.value.dir = '/new-dir'
    await nextTick()
    expect(isDirty.value).toBe(true)

    // Patch only locale — dir should remain dirty
    patchSnapshot({ locale: 'ja' })
    await nextTick()
    expect(isDirty.value).toBe(true) // dir is still different

    // Now patch dir too
    patchSnapshot({ dir: '/new-dir' })
    await nextTick()
    expect(isDirty.value).toBe(false) // both match

    unmount()
  })

  it('throws when store persistence fails', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(false)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { handleSave } = result

    await expect(handleSave()).rejects.toThrow('Preference persistence failed')

    unmount()
  })
})
