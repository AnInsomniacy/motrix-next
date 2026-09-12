/**
 * @fileoverview Tests for the usePreferenceForm composable.
 *
 * Key behaviors under test:
 * - isDirty tracks shallow and deep changes via isEqual snapshot comparison
 * - handleSave persists to store and replaces the generated engine snapshot
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

const mockMessage = vi.hoisted(() => {
  const createMessageFn = () => vi.fn((_message?: unknown, _options?: unknown) => ({ destroy: vi.fn() }))
  return {
    success: createMessageFn(),
    error: createMessageFn(),
    warning: createMessageFn(),
    info: createMessageFn(),
  }
})

// ── Mock Tauri invoke ───────────────────────────────────────────────
const mockInvoke = vi.fn().mockResolvedValue(undefined)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// ── Mock naive-ui (useMessage needed by useAppMessage) ──────────────
vi.mock('naive-ui', () => ({
  useMessage: () => mockMessage,
}))

// ── Mock vue-i18n ───────────────────────────────────────────────────
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

// ── Mock aria2 API ──────────────────────────────────────────────────
const mockChangeGlobalOption = vi.fn().mockResolvedValue(undefined)
const mockChangeOption = vi.fn().mockResolvedValue(undefined)
const mockFetchTaskList = vi.fn().mockResolvedValue([])
const mockSaveSession = vi.fn().mockResolvedValue('OK')
const mockIsEngineReady = vi.fn().mockReturnValue(true)
vi.mock('@/api/aria2', () => ({
  changeGlobalOption: (...args: unknown[]) => mockChangeGlobalOption(...args),
  changeOption: (...args: unknown[]) => mockChangeOption(...args),
  fetchTaskList: (...args: unknown[]) => mockFetchTaskList(...args),
  saveSession: (...args: unknown[]) => mockSaveSession(...args),
  isEngineReady: () => mockIsEngineReady(),
}))

import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '../usePreferenceForm'

function extractMessageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'function') {
    const vnode = value()
    return typeof vnode === 'object' && vnode !== null && 'children' in vnode ? String(vnode.children) : String(value)
  }
  return String(value)
}

interface TestForm extends Record<string, unknown> {
  dir: string
  maxConcurrentDownloads: number
  streamMaxConnections?: number
  locale: string
}

function makeOptions(overrides: Partial<Parameters<typeof usePreferenceForm<TestForm>>[0]> = {}) {
  return {
    buildForm: () => ({
      dir: '/downloads',
      maxConcurrentDownloads: 6,
      streamMaxConnections: 64,
      locale: 'en-US',
    }),
    buildSystemConfig: (f: TestForm) => ({
      dir: f.dir,
      'max-concurrent-downloads': String(f.maxConcurrentDownloads),
      ...(f.streamMaxConnections !== undefined ? { 'stream-max-connections': String(f.streamMaxConnections) } : {}),
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
    mockIsEngineReady.mockReturnValue(true)
  })

  it('initialises form with buildForm values and isDirty=false', () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, isDirty } = result

    expect(form.value.dir).toBe('/downloads')
    expect(form.value.maxConcurrentDownloads).toBe(6)
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
    expect(form.value.maxConcurrentDownloads).toBe(6)
    expect(isDirty.value).toBe(false)

    unmount()
  })

  it('handleReset shows a restored toast only when changes existed', async () => {
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleReset } = result

    handleReset()
    expect(mockMessage.success).not.toHaveBeenCalled()

    form.value.dir = '/modified'
    await nextTick()

    handleReset()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockMessage.success).toHaveBeenCalledTimes(1)
    const [message, options] = mockMessage.success.mock.calls[0]
    expect(extractMessageText(message)).toBe('preferences.changes-restored')
    expect(options).toEqual(expect.objectContaining({ closable: true }))

    unmount()
  })

  it('handleSave persists to store and replaces the engine snapshot', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleSave, isDirty } = result

    form.value.maxConcurrentDownloads = 8
    await handleSave()

    expect(store.updateAndSave).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentDownloads: 8 }))
    expect(mockInvoke).toHaveBeenCalledWith('replace_system_config', {
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

  it('runs afterSave before showing the save-success toast', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    const events: string[] = []
    mockMessage.success.mockImplementation((message?: unknown) => {
      events.push(`success:${extractMessageText(message)}`)
      return { destroy: vi.fn() }
    })

    const afterSave = vi.fn(async () => {
      events.push('afterSave')
    })
    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions({ afterSave })))

    await result.handleSave()

    expect(events).toEqual(['afterSave', 'success:preferences.save-success-message'])

    unmount()
  })

  it('shows the specific and standard success messages', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    const { result, unmount } = withSetup(() =>
      usePreferenceForm(
        makeOptions({
          saveFeedback: {
            success: 'Settings applied',
            restored: 'Previous settings restored',
            rollbackFailed: 'Rollback failed',
          },
        }),
      ),
    )

    result.form.value.maxConcurrentDownloads = 8
    await result.handleSave()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const successMessages = mockMessage.success.mock.calls.map(([content]) => extractMessageText(content))
    expect(successMessages).toContain('Settings applied')
    expect(successMessages).toContain('preferences.save-success-message')

    unmount()
  })

  it('restores every completed save stage when a post-save side effect fails', async () => {
    const store = usePreferenceStore()
    store.config.maxConcurrentDownloads = 6
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    const afterSave = vi.fn().mockRejectedValue(new Error('mapping failed'))
    const { result, unmount } = withSetup(() =>
      usePreferenceForm(
        makeOptions({
          afterSave,
          saveFeedback: {
            success: 'Settings applied',
            restored: 'Previous settings restored',
            rollbackFailed: 'Rollback failed',
          },
        }),
      ),
    )

    result.form.value.maxConcurrentDownloads = 8
    await expect(result.handleSave()).rejects.toThrow('mapping failed')

    expect(store.updateAndSave).toHaveBeenCalledTimes(2)
    expect(mockInvoke).toHaveBeenCalledWith('replace_system_config', {
      config: expect.objectContaining({ 'max-concurrent-downloads': '6' }),
    })
    expect(mockChangeGlobalOption).toHaveBeenLastCalledWith({ 'max-concurrent-downloads': '6' })
    expect(result.form.value.maxConcurrentDownloads).toBe(6)
    expect(result.isDirty.value).toBe(false)
    expect(extractMessageText(mockMessage.error.mock.calls[mockMessage.error.mock.calls.length - 1]?.[0])).toBe(
      'Previous settings restored',
    )

    unmount()
  })

  it('reports rollback failure without claiming the form was restored', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    mockChangeGlobalOption.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rollback failed'))
    const { result, unmount } = withSetup(() =>
      usePreferenceForm(
        makeOptions({
          afterSave: () => Promise.reject(new Error('apply failed')),
          saveFeedback: {
            success: 'Settings applied',
            restored: 'Previous settings restored',
            rollbackFailed: 'Rollback failed',
          },
        }),
      ),
    )

    result.form.value.maxConcurrentDownloads = 8
    await expect(result.handleSave()).rejects.toThrow('apply failed')

    expect(result.form.value.maxConcurrentDownloads).toBe(8)
    expect(result.isDirty.value).toBe(true)
    expect(extractMessageText(mockMessage.error.mock.calls[mockMessage.error.mock.calls.length - 1]?.[0])).toBe(
      'Rollback failed',
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

  it('hot-reloads changeable keys to aria2 via changeGlobalOption on save', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    mockIsEngineReady.mockReturnValue(true)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleSave } = result

    form.value.maxConcurrentDownloads = 8
    await handleSave()

    expect(mockChangeGlobalOption).toHaveBeenCalledWith({ 'max-concurrent-downloads': '8' })
    expect(mockChangeGlobalOption.mock.invocationCallOrder[0]).toBeLessThan(
      (store.updateAndSave as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    )

    unmount()
  })

  it('aborts persistence when the engine rejects a live option', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    mockIsEngineReady.mockReturnValue(true)
    mockChangeGlobalOption.mockRejectedValueOnce(new Error('bind failed'))

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    result.form.value.maxConcurrentDownloads = 8

    await expect(result.handleSave()).rejects.toThrow('bind failed')

    expect(store.updateAndSave).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalledWith('replace_system_config', expect.anything())
    expect(mockChangeGlobalOption).toHaveBeenLastCalledWith({ 'max-concurrent-downloads': '6' })
    expect(result.form.value.maxConcurrentDownloads).toBe(6)
    expect(result.isDirty.value).toBe(false)

    unmount()
  })

  it('skips hot-reload when engine is not ready', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    mockIsEngineReady.mockReturnValue(false)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleSave } = result

    form.value.maxConcurrentDownloads = 8
    await handleSave()

    expect(mockChangeGlobalOption).not.toHaveBeenCalled()

    unmount()
  })

  it('propagates stream-max-connections changes to active tasks and persists session', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    mockFetchTaskList.mockResolvedValueOnce([{ gid: 'task-1' }, { gid: 'task-2' }])

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleSave } = result

    form.value.streamMaxConnections = 16
    await handleSave()

    expect(mockChangeGlobalOption).toHaveBeenCalledWith(expect.objectContaining({ 'stream-max-connections': '16' }))
    expect(mockFetchTaskList).toHaveBeenCalledWith({ type: 'active' })
    expect(mockChangeOption).toHaveBeenCalledTimes(2)
    expect(mockChangeOption).toHaveBeenCalledWith({
      gid: 'task-1',
      options: { 'stream-max-connections': '16' },
    })
    expect(mockChangeOption).toHaveBeenCalledWith({
      gid: 'task-2',
      options: { 'stream-max-connections': '16' },
    })
    expect(mockSaveSession).toHaveBeenCalled()

    unmount()
  })

  it('does not fetch tasks or call changeOption when changed options are not task-propagatable', async () => {
    const store = usePreferenceStore()
    store.updateAndSave = vi.fn().mockResolvedValue(true)

    const { result, unmount } = withSetup(() => usePreferenceForm(makeOptions()))
    const { form, handleSave } = result

    form.value.maxConcurrentDownloads = 8
    await handleSave()

    expect(mockChangeGlobalOption).toHaveBeenCalledWith({ 'max-concurrent-downloads': '8' })
    expect(mockFetchTaskList).not.toHaveBeenCalled()
    expect(mockChangeOption).not.toHaveBeenCalled()
    expect(mockSaveSession).not.toHaveBeenCalled()

    unmount()
  })

  it('restores task options and session during rollback when save fails', async () => {
    const store = usePreferenceStore()
    store.config.streamMaxConnections = 64
    store.updateAndSave = vi.fn().mockResolvedValue(true)
    mockFetchTaskList.mockResolvedValue([{ gid: 'task-1' }])

    const { result, unmount } = withSetup(() =>
      usePreferenceForm(
        makeOptions({
          afterSave: () => Promise.reject(new Error('post-save failure')),
        }),
      ),
    )

    result.form.value.streamMaxConnections = 16
    await expect(result.handleSave()).rejects.toThrow('post-save failure')

    // During rollback, should revert active task options to 64
    expect(mockChangeOption).toHaveBeenLastCalledWith({
      gid: 'task-1',
      options: { 'stream-max-connections': '64' },
    })
    expect(mockSaveSession).toHaveBeenCalled()

    unmount()
  })
})
