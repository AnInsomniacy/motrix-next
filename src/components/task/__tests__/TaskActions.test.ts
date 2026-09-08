/**
 * @fileoverview Integration tests for TaskActions.vue.
 *
 * Key behaviors under test:
 * - Engine guard: live batch actions block when the engine is unavailable
 * - Refresh loading: duplicate clicks are blocked while native refresh is pending
 * - Confirmation dialogs: all destructive actions require user confirmation
 * - Native batch deletion and P2P sharing termination
 *
 * These are REAL integration tests using @vue/test-utils mount() with Pinia store.
 * All Tauri/Naive UI dependencies are mocked, but component ↔ store interaction is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// ── Mock registry (shared refs for assertion access) ────────────────

const mockIsEngineReady = vi.fn().mockReturnValue(true)
const mockFetchList = vi.fn().mockResolvedValue(undefined)
const mockResumeAllTask = vi.fn().mockResolvedValue({ resumed: 1, blocked: 0 })
const mockPauseAllTask = vi.fn().mockResolvedValue(undefined)
const mockFinishSharingTasks = vi.fn()
const mockPurgeTaskRecord = vi.fn().mockResolvedValue(undefined)
const mockBatchRemoveTask = vi.fn()
const mockDeleteTaskFiles = vi.fn().mockResolvedValue(undefined)

// Dialog mock: captures onPositiveClick so we can invoke it in tests
let lastDialogOptions: Record<string, unknown> | null = null
const mockDialogWarning = vi.fn((opts: Record<string, unknown>) => {
  lastDialogOptions = opts
  return { loading: false, negativeButtonProps: {}, closable: true, maskClosable: true, destroy: vi.fn() }
})

// Message mock: captures calls for assertion
const mockMessageSuccess = vi.fn(() => ({ destroy: vi.fn() }))
const mockMessageWarning = vi.fn(() => ({ destroy: vi.fn() }))
const mockMessageError = vi.fn(() => ({ destroy: vi.fn() }))

function renderDialogText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'function') return ''
  const parts: string[] = []
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (!node || typeof node !== 'object') return
    const children = (node as { children?: unknown }).children
    if (Array.isArray(children)) {
      children.forEach(walk)
      return
    }
    if (typeof children === 'string') {
      parts.push(children)
      return
    }
    if (children && typeof children === 'object') {
      const defaultSlot = (children as { default?: () => unknown }).default
      if (typeof defaultSlot === 'function') walk(defaultSlot())
    }
  }
  walk(value())
  return parts.join(' ')
}

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('@/api/aria2', () => ({
  isEngineReady: () => mockIsEngineReady(),
}))

function translateForTest(key: string, params?: Record<string, unknown>): string {
  const messages: Record<string, string> = {
    'task.delete-all-task': 'Clear Download Queue',
    'task.delete-task-queue': 'Clear Download Queue',
    'task.batch-delete-task-confirm': `This will remove ${params?.count ?? '{count}'} downloading, queued, or paused task(s).`,
    'task.delete-local-files-trash-label': 'Move files to Trash',
    'task.delete-local-files-permanent-label': 'Permanently delete files',
    'task.purge-record': 'Clear History Records',
    'task.purge-record-confirm': 'This will remove all completed, failed, or removed task records.',
    'task.finish-all-sharing': 'Stop All Sharing',
    'task.finish-all-sharing-confirm': `Stop ${params?.count ?? '{count}'} seeding or sharing task(s)? Downloaded files and completed records will be kept.`,
    'task.finish-all-sharing-success': `Stopped ${params?.count ?? '{count}'} seeding or sharing task(s)`,
    'task.finish-all-sharing-partial': `Stopped ${params?.finished ?? '{finished}'} task(s); ${params?.failed ?? '{failed}'} failed`,
    'task.finish-all-sharing-fail': 'Failed to stop seeding or sharing tasks',
    'task.batch-delete-task-partial': `Removed ${params?.removed ?? '{removed}'} task(s); ${params?.failed ?? '{failed}'} failed`,
  }
  return messages[key] ?? key
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: translateForTest }),
}))

vi.mock('naive-ui', () => ({
  NButton: {
    template: '<button :disabled="disabled"><slot /><slot name="icon" /></button>',
    props: ['type', 'circle', 'size', 'quaternary', 'disabled', 'loading'],
  },
  NIcon: { template: '<span :class="$attrs.class"><slot /></span>' },
  NTooltip: { template: '<span><slot /><slot name="trigger" /></span>' },
  NCheckbox: { template: '<label><slot /></label>', props: ['checked'] },
  NPopover: {
    template: '<div><slot name="trigger" /></div>',
    props: ['show', 'trigger', 'placement', 'showArrow', 'raw'],
  },
  useDialog: () => ({
    error: mockDialogWarning,
    info: mockDialogWarning,
    warning: mockDialogWarning,
  }),
  useMessage: () => ({
    success: mockMessageSuccess,
    error: mockMessageError,
    warning: mockMessageWarning,
    info: vi.fn(() => ({ destroy: vi.fn() })),
  }),
}))

vi.mock('@vicons/ionicons5', () => ({
  AddOutline: { template: '<i />' },
  PlayOutline: { template: '<i />' },
  PauseOutline: { template: '<i />' },
  TrashOutline: { template: '<i />' },
  RefreshOutline: { template: '<i />' },
  CloseOutline: { template: '<i />' },
  StopCircleOutline: { template: '<i />' },
  SyncOutline: { template: '<i />' },
  SwapVerticalOutline: { template: '<i />' },
  ArrowUpOutline: { template: '<i />' },
  ArrowDownOutline: { template: '<i />' },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  remove: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => ({
    success: mockMessageSuccess,
    error: mockMessageError,
    warning: mockMessageWarning,
    info: vi.fn(() => ({ destroy: vi.fn() })),
  }),
}))

vi.mock('@/composables/useFileDelete', () => ({
  deleteTaskFiles: (...args: unknown[]) => mockDeleteTaskFiles(...args),
}))

import TaskActions from '../TaskActions.vue'
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'

// ── Helpers ─────────────────────────────────────────────────────────

const createWrapper = () => mount(TaskActions)

/**
 * Click the Nth button in the component (0-indexed).
 * Button order in progress: Add, Sort, Refresh, Resume, Pause, Stop sharing, Delete.
 * Terminal scopes render Add, Sort, Refresh, and Purge.
 */
async function clickButton(wrapper: ReturnType<typeof createWrapper>, index: number) {
  const buttons = wrapper.findAll('button')
  await buttons[index].trigger('click')
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('TaskActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockIsEngineReady.mockReturnValue(true)
    useTaskStore().currentList = 'progress'
    lastDialogOptions = null

    // Patch store methods so we can track calls without real IPC
    const taskStore = useTaskStore()
    taskStore.fetchList = mockFetchList
    taskStore.resumeAllTask = mockResumeAllTask
    taskStore.pauseAllTask = mockPauseAllTask
    taskStore.finishSharingTasks = mockFinishSharingTasks
    taskStore.purgeTaskRecord = mockPurgeTaskRecord
    taskStore.batchRemoveTask = mockBatchRemoveTask
    mockFinishSharingTasks.mockImplementation(async (gids: string[]) => ({ succeeded: gids, failed: [] }))
    mockBatchRemoveTask.mockImplementation(async (gids: string[]) => ({ succeeded: gids, failed: [] }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Smoke ───────────────────────────────────────────────────────

  it('mounts without errors', () => {
    const wrapper = createWrapper()
    expect(wrapper.find('.task-actions').exists()).toBe(true)
  })

  it('renders all seven progress actions', () => {
    const wrapper = createWrapper()
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBe(7)
  })

  // ── Engine Guard ────────────────────────────────────────────────

  describe('engine guard', () => {
    it('shows warning when resumeAll is clicked and engine is not ready', async () => {
      mockIsEngineReady.mockReturnValue(false)
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'p1', status: 'paused' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3) // Resume All

      expect(mockMessageWarning).toHaveBeenCalledOnce()
      expect(mockDialogWarning).not.toHaveBeenCalled() // Dialog should NOT open
    })

    it('shows warning when pauseAll is clicked and engine is not ready', async () => {
      mockIsEngineReady.mockReturnValue(false)
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'a1', status: 'active' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 4) // Pause All

      expect(mockMessageWarning).toHaveBeenCalledOnce()
      expect(mockDialogWarning).not.toHaveBeenCalled()
    })

    it('opens purgeRecord dialog even when engine is not ready (purge operates on DB only)', async () => {
      mockIsEngineReady.mockReturnValue(false)
      const taskStore = useTaskStore()
      taskStore.currentList = 'completed'
      taskStore.taskList = [{ gid: 'done', status: 'complete' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3) // Purge (index 2 when in stopped list)

      // No engine gate — dialog should open regardless
      expect(mockMessageWarning).not.toHaveBeenCalled()
      expect(mockDialogWarning).toHaveBeenCalledOnce()
    })

    it('opens confirmation dialog for resumeAll when engine IS ready', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'p1', status: 'paused' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3) // Resume All

      expect(mockMessageWarning).not.toHaveBeenCalled()
      expect(mockDialogWarning).toHaveBeenCalledOnce()
    })

    it('opens confirmation dialog for pauseAll when engine IS ready', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'a1', status: 'active' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 4) // Pause All

      expect(mockMessageWarning).not.toHaveBeenCalled()
      expect(mockDialogWarning).toHaveBeenCalledOnce()
    })

    it('opens confirmation dialog for purgeRecord when engine IS ready', async () => {
      const taskStore = useTaskStore()
      taskStore.currentList = 'completed'
      taskStore.taskList = [{ gid: 'done', status: 'complete' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3) // Purge

      expect(mockMessageWarning).not.toHaveBeenCalled()
      expect(mockDialogWarning).toHaveBeenCalledOnce()
    })
  })

  // ── Disabled State Guards ──────────────────────────────────────

  describe('disabled state guards', () => {
    it('Resume All button is disabled when taskList is empty', () => {
      const wrapper = createWrapper()
      const resumeBtn = wrapper.findAll('button')[3]
      expect(resumeBtn.attributes('disabled')).toBeDefined()
    })

    it('Pause All button is disabled when taskList is empty', () => {
      const wrapper = createWrapper()
      const pauseBtn = wrapper.findAll('button')[4]
      expect(pauseBtn.attributes('disabled')).toBeDefined()
    })

    it('Resume All button is disabled when only active tasks exist (none paused)', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'a1', status: 'active' },
        { gid: 'a2', status: 'active' },
      ] as never
      const wrapper = createWrapper()
      const resumeBtn = wrapper.findAll('button')[3]
      expect(resumeBtn.attributes('disabled')).toBeDefined()
    })

    it('Pause All button is disabled when only paused tasks exist (none active)', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'p1', status: 'paused' },
        { gid: 'p2', status: 'paused' },
      ] as never
      const wrapper = createWrapper()
      const pauseBtn = wrapper.findAll('button')[4]
      expect(pauseBtn.attributes('disabled')).toBeDefined()
    })

    it('Resume All button is enabled when at least one paused task exists', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'a1', status: 'active' },
        { gid: 'p1', status: 'paused' },
      ] as never
      const wrapper = createWrapper()
      const resumeBtn = wrapper.findAll('button')[3]
      expect(resumeBtn.attributes('disabled')).toBeUndefined()
    })

    it('Pause All button is enabled when at least one active task exists', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'a1', status: 'active' },
        { gid: 'p1', status: 'paused' },
      ] as never
      const wrapper = createWrapper()
      const pauseBtn = wrapper.findAll('button')[4]
      expect(pauseBtn.attributes('disabled')).toBeUndefined()
    })

    it('Pause All button is enabled when waiting tasks exist', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'w1', status: 'waiting' }] as never
      const wrapper = createWrapper()
      const pauseBtn = wrapper.findAll('button')[4]
      expect(pauseBtn.attributes('disabled')).toBeUndefined()
    })

    it('Resume All button remains disabled with completed/error/sharing tasks', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'c1', status: 'complete' },
        { gid: 'e1', status: 'error' },
        { gid: 's1', status: 'active', bittorrent: { info: { name: 'x' } }, seeder: 'true' },
      ] as never
      const wrapper = createWrapper()
      const resumeBtn = wrapper.findAll('button')[3]
      expect(resumeBtn.attributes('disabled')).toBeDefined()
    })

    it('disabled Resume All does not open a dialog when clicked', async () => {
      // Empty task list → Resume All should be disabled
      const wrapper = createWrapper()
      await clickButton(wrapper, 3) // Resume All
      expect(mockDialogWarning).not.toHaveBeenCalled()
    })

    it('disabled Pause All does not open a dialog when clicked', async () => {
      // Empty task list → Pause All should be disabled
      const wrapper = createWrapper()
      await clickButton(wrapper, 4) // Pause All
      expect(mockDialogWarning).not.toHaveBeenCalled()
    })

    it('Stop All Sharing is enabled only for live P2P sharing tasks', () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'download', status: 'active', seeder: 'false' },
        { gid: 'bt', status: 'paused', seeder: 'true', bittorrent: { info: { name: 'x' } } },
      ] as never
      const wrapper = createWrapper()
      expect(wrapper.findAll('button')[5].attributes('disabled')).toBeUndefined()
    })
  })

  // ── Refresh Loading ─────────────────────────────────────────────

  describe('refresh loading', () => {
    it('calls fetchList on refresh click', async () => {
      const wrapper = createWrapper()

      await clickButton(wrapper, 2) // Refresh

      expect(mockFetchList).toHaveBeenCalledOnce()
    })

    it('blocks duplicate refresh clicks while the request is pending', async () => {
      let resolveFetch: (() => void) | undefined
      mockFetchList.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFetch = resolve
          }),
      )
      const wrapper = createWrapper()

      await clickButton(wrapper, 2)
      await clickButton(wrapper, 2)
      expect(mockFetchList).toHaveBeenCalledOnce()
      expect(wrapper.findAll('button')[2].attributes('disabled')).toBeDefined()

      resolveFetch?.()
      await Promise.resolve()
      await wrapper.vm.$nextTick()
      expect(wrapper.findAll('button')[2].attributes('disabled')).toBeUndefined()
    })

    it('shows success message when fetchList succeeds', async () => {
      mockFetchList.mockResolvedValueOnce(undefined)
      const wrapper = createWrapper()

      await clickButton(wrapper, 2)
      await Promise.resolve()

      expect(mockMessageSuccess).toHaveBeenCalled()
    })
  })

  // ── Confirmation Dialogs ────────────────────────────────────────

  describe('confirmation dialogs', () => {
    it('resumeAll dialog calls resumeAllTask on positive click', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'p1', status: 'paused' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3) // Resume All
      expect(lastDialogOptions).not.toBeNull()

      // Simulate user clicking "Yes"
      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockResumeAllTask).toHaveBeenCalledOnce()
    })

    it('resumeAll shows success message after execution', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'p1', status: 'paused' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3)
      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockMessageSuccess).toHaveBeenCalled()
    })

    it('resumeAll shows error message on failure', async () => {
      mockResumeAllTask.mockRejectedValueOnce(new Error('rpc fail'))
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'p1', status: 'paused' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3)
      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockMessageError).toHaveBeenCalled()
    })

    it('pauseAll dialog calls pauseAllTask on positive click', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'a1', status: 'active' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 4) // Pause All
      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockPauseAllTask).toHaveBeenCalledOnce()
    })

    it('purgeRecord dialog calls purgeTaskRecord on positive click', async () => {
      const taskStore = useTaskStore()
      taskStore.currentList = 'completed'
      taskStore.taskList = [{ gid: 'done', status: 'complete' }] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 3) // Purge
      expect(lastDialogOptions?.title).toBe('Clear History Records')
      expect(renderDialogText(lastDialogOptions?.content)).toContain(
        'This will remove all completed, failed, or removed task records.',
      )
      expect(renderDialogText(lastDialogOptions?.content)).toContain('Move files to Trash')
      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockPurgeTaskRecord).toHaveBeenCalledOnce()
    })

    it('stops active and paused BT and ED2K sharing tasks after confirmation', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [
        { gid: 'bt', status: 'active', seeder: 'true', bittorrent: { info: { name: 'bt' } } },
        { gid: 'ed2k', status: 'paused', seeder: 'true', ed2k: { name: 'ed2k' } },
        { gid: 'download', status: 'active', seeder: 'false' },
      ] as never
      const wrapper = createWrapper()

      await clickButton(wrapper, 5)
      expect(lastDialogOptions?.title).toBe('Stop All Sharing')
      expect(renderDialogText(lastDialogOptions?.content)).toContain('Stop 2 seeding or sharing task(s)')
      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockFinishSharingTasks).toHaveBeenCalledWith(['bt', 'ed2k'])
      expect(mockMessageSuccess).toHaveBeenCalledWith('Stopped 2 seeding or sharing task(s)')
    })
  })

  // ── Delete All ──────────────────────────────────────────────────

  describe('delete all', () => {
    it('does nothing when task list is empty', async () => {
      const wrapper = createWrapper()
      // taskList is empty by default — the delete-all button should be disabled
      const deleteBtn = wrapper.findAll('button')[6]
      expect(deleteBtn.attributes('disabled')).toBeDefined()
    })

    it('opens dialog with batch count when tasks exist', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'g1' }, { gid: 'g2' }] as never

      const wrapper = createWrapper()
      await clickButton(wrapper, 6) // Delete All

      expect(mockDialogWarning).toHaveBeenCalledOnce()
      expect(lastDialogOptions?.title).toBe('Clear Download Queue')
      expect(renderDialogText(lastDialogOptions?.content)).toContain(
        'This will remove 2 downloading, queued, or paused task(s).',
      )
      expect(renderDialogText(lastDialogOptions?.content)).toContain('Move files to Trash')
    })

    it('shows the permanent deletion action when configured', async () => {
      const preferenceStore = usePreferenceStore()
      preferenceStore.config.fileDeletionMode = 'permanent'
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'g1' }] as never

      const wrapper = createWrapper()
      await clickButton(wrapper, 6)

      expect(renderDialogText(lastDialogOptions?.content)).toContain('Permanently delete files')
    })

    it('calls batchRemoveTask with all gids on confirmation', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'g1' }, { gid: 'g2' }, { gid: 'g3' }] as never

      const wrapper = createWrapper()
      await clickButton(wrapper, 6) // Delete All

      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockBatchRemoveTask).toHaveBeenCalledWith(['g1', 'g2', 'g3'])
    })

    it('shows success message after batch deletion', async () => {
      const taskStore = useTaskStore()
      taskStore.taskList = [{ gid: 'g1' }] as never

      const wrapper = createWrapper()
      await clickButton(wrapper, 6)

      const onPositiveClick = lastDialogOptions!.onPositiveClick as () => Promise<false>
      await onPositiveClick()

      expect(mockMessageSuccess).toHaveBeenCalled()
    })
  })
})
