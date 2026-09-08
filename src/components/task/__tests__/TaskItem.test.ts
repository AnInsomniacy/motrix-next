import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Aria2Task } from '@shared/types'

const invokeMock = vi.fn()

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('naive-ui', () => ({
  NProgress: { template: '<div class="progress-stub" />' },
  NIcon: { template: '<span><slot /></span>' },
  NTooltip: { template: '<span><slot name="trigger" /><slot /></span>' },
}))

vi.mock('@vicons/ionicons5', () => ({
  ArrowUpOutline: { template: '<i />' },
  ArrowDownOutline: { template: '<i />' },
  GitNetworkOutline: { template: '<i />' },
  MagnetOutline: { template: '<i />' },
  AlertCircleOutline: { template: '<i />' },
  CloudUploadOutline: { template: '<i />' },
  CheckmarkCircleOutline: { template: '<i />' },
  TrashOutline: { template: '<i />' },
  RadioOutline: { template: '<i />' },
  PauseOutline: { template: '<i />' },
  TimeOutline: { template: '<i />' },
}))

vi.mock('../TaskItemActions.vue', () => ({
  default: { template: '<div class="task-item-actions-stub" />' },
}))

import TaskItem from '../TaskItem.vue'
import TaskCompactItem from '../TaskCompactItem.vue'

function createTask(path: string): Aria2Task {
  return {
    gid: 'gid-1',
    status: 'complete',
    totalLength: '100',
    completedLength: '100',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/ignored.bin',
        length: '10',
        completedLength: '0',
        selected: 'false',
        uris: [],
      },
      {
        index: '2',
        path,
        length: '90',
        completedLength: '90',
        selected: 'true',
        uris: [],
      },
    ],
    bittorrent: { info: { name: 'archive.zip' } },
    numSeeders: '0',
    errorMessage: '',
  }
}

describe('TaskItem', () => {
  it.each([TaskItem, TaskCompactItem])('transitions semantic text changes, not progress updates', async (component) => {
    const task = createTask('/downloads/file.bin')
    const wrapper = mount(component, { props: { task } })
    const surface = wrapper.element
    const name = wrapper.findAll('.task-text-transition-content')[0].element
    const status = wrapper.findAll('.task-text-transition-content')[1].element
    await wrapper.setProps({ task: { ...task, completedLength: '50' } })
    expect(wrapper.findAll('.task-text-transition-content')[0].element).toBe(name)
    expect(wrapper.findAll('.task-text-transition-content')[1].element).toBe(status)
    await wrapper.setProps({
      task: { ...task, status: 'active', bittorrent: { state: 'seeding', info: { name: 'renamed.zip' } } },
    })
    expect(wrapper.findAll('.task-text-transition-content')[0].element).not.toBe(name)
    expect(wrapper.findAll('.task-text-transition-content')[1].element).not.toBe(status)
    expect(wrapper.element).toBe(surface)
    wrapper.unmount()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes file existence when the selected target path changes', async () => {
    const wrapper = mount(TaskItem, {
      props: {
        task: createTask('/downloads/first.bin'),
      },
    })

    await vi.advanceTimersByTimeAsync(200)
    expect(invokeMock).toHaveBeenLastCalledWith('check_path_exists', {
      path: '/downloads/first.bin',
    })

    invokeMock.mockClear()

    await wrapper.setProps({
      task: createTask('/downloads/second.bin'),
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('check_path_exists', {
      path: '/downloads/second.bin',
    })
  })

  it('coalesces rapid target path changes into a single file check for the latest path', async () => {
    const wrapper = mount(TaskItem, {
      props: {
        task: createTask('/downloads/first.bin'),
      },
    })

    await vi.advanceTimersByTimeAsync(200)
    invokeMock.mockClear()

    await wrapper.setProps({
      task: createTask('/downloads/second.bin'),
    })
    await vi.advanceTimersByTimeAsync(50)
    await wrapper.setProps({
      task: createTask('/downloads/third.bin'),
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('check_path_exists', {
      path: '/downloads/third.bin',
    })
  })

  it('shows queued status for waiting tasks', () => {
    const task = {
      ...createTask('/downloads/waiting.bin'),
      status: 'waiting',
      completedLength: '0',
      totalLength: '100',
    } satisfies Aria2Task

    const wrapper = mount(TaskItem, {
      props: {
        task,
      },
    })

    expect(wrapper.text()).toContain('task.status-waiting')
  })

  it('shows progress percentage in full and compact cards', () => {
    const task = {
      ...createTask('/downloads/active.bin'),
      status: 'active',
      completedLength: '25',
      totalLength: '100',
    } satisfies Aria2Task

    const full = mount(TaskItem, { props: { task } })
    const compact = mount(TaskCompactItem, { props: { task } })

    expect(full.find('.progress-left').text()).toContain('25%')
    expect(compact.find('.compact-meta').text()).toContain('25%')
  })

  it('does not show a status tag for paused tasks', () => {
    const task = {
      ...createTask('/downloads/paused.bin'),
      status: 'paused',
      completedLength: '25',
      totalLength: '100',
    } satisfies Aria2Task

    const wrapper = mount(TaskItem, {
      props: {
        task,
      },
    })

    expect(wrapper.text()).not.toContain('task.status-paused')
    expect(wrapper.find('.task-status-slot').classes()).not.toContain('task-status-slot--visible')
  })

  it('keeps the status slot mounted when no status tag is visible', () => {
    const task = {
      ...createTask('/downloads/active.bin'),
      status: 'active',
      completedLength: '25',
      totalLength: '100',
    } satisfies Aria2Task

    const wrapper = mount(TaskItem, {
      props: {
        task,
      },
    })

    expect(wrapper.find('.task-status-slot').exists()).toBe(true)
    expect(wrapper.find('.task-tags').exists()).toBe(true)
    expect(wrapper.find('.task-status-slot').classes()).not.toContain('task-status-slot--visible')
  })

  it('shows torrent metadata fetching status once', () => {
    const task = {
      ...createTask(''),
      status: 'active',
      totalLength: '0',
      completedLength: '0',
      files: [],
      bittorrent: { state: 'downloadingMetadata' },
    } satisfies Aria2Task

    const wrapper = mount(TaskItem, {
      props: {
        task,
      },
    })

    expect(wrapper.text().match(/task\.bt-metadata-fetching/g)).toHaveLength(1)
    expect(wrapper.find('.progress-left').classes()).toContain('info-hidden')
  })

  it('keeps the full card surface non-interactive', async () => {
    const wrapper = mount(TaskItem, {
      props: {
        task: { ...createTask('/downloads/active.bin'), status: 'active' },
      },
    })

    await wrapper.trigger('pointerdown')
    await wrapper.trigger('click')
    await wrapper.trigger('dblclick')

    expect(wrapper.classes()).not.toContain('pressed')
    expect(wrapper.emitted('pause')).toBeUndefined()
    expect(wrapper.emitted('resume')).toBeUndefined()
    expect(wrapper.emitted('open-file')).toBeUndefined()
  })

  it('keeps the compact card surface non-interactive', async () => {
    const wrapper = mount(TaskCompactItem, {
      props: {
        task: createTask('/downloads/complete.bin'),
      },
    })

    await wrapper.trigger('pointerdown')
    await wrapper.trigger('click')
    await wrapper.trigger('dblclick')

    expect(wrapper.classes()).not.toContain('pressed')
    expect(wrapper.emitted('pause')).toBeUndefined()
    expect(wrapper.emitted('resume')).toBeUndefined()
    expect(wrapper.emitted('open-file')).toBeUndefined()
  })
})
