import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Aria2Task, TaskStatus } from '@shared/types'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NIcon: { template: '<span><slot /></span>' },
  NTooltip: { template: '<span><slot name="trigger" /><slot /></span>' },
}))
vi.mock('@vicons/ionicons5', () => {
  const icon = { template: '<i />' }
  return {
    PauseOutline: icon,
    PlayOutline: icon,
    StopCircleOutline: icon,
    RefreshOutline: icon,
    CloseOutline: icon,
    TrashOutline: icon,
    LinkOutline: icon,
    InformationCircleOutline: icon,
    FolderOpenOutline: icon,
    OpenOutline: icon,
    ListOutline: icon,
  }
})

import TaskItemActions from '../TaskItemActions.vue'

function makeTask(status: TaskStatus, overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'gid',
    status,
    totalLength: '1024',
    completedLength: '512',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/tmp',
    files: [],
    ...overrides,
  }
}

function mountActions(task: Aria2Task) {
  return mount(TaskItemActions, { props: { task } })
}

describe('TaskItemActions', () => {
  it('renders standard pause and resume actions', async () => {
    const active = mountActions(makeTask('active'))
    await active.find('[aria-label="task.pause-task"]').trigger('click')
    expect(active.emitted('pause')).toBeTruthy()

    const paused = mountActions(makeTask('paused'))
    await paused.find('[aria-label="task.resume-task"]').trigger('click')
    expect(paused.emitted('resume')).toBeTruthy()
  })

  it('renders an icon-only file-selection action for pending magnets', async () => {
    const wrapper = mountActions(
      makeTask('paused', {
        bittorrent: { state: 'paused', fileSelectionState: 'awaiting', info: { name: 'Torrent' } },
      }),
    )

    const action = wrapper.find('[aria-label="task.select-files"]')
    expect(action.text()).toBe('')
    expect(action.classes()).toContain('task-item-action--emphasis')
    await action.trigger('click')
    expect(wrapper.emitted('select-files')).toBeTruthy()
    expect(wrapper.emitted('resume')).toBeFalsy()
  })

  it('supports pause, resume, and terminal seeding actions', async () => {
    const seeding = mountActions(
      makeTask('active', {
        completedLength: '1024',
        seeder: 'true',
        bittorrent: { state: 'seeding' },
      }),
    )
    await seeding.find('[aria-label="task.pause-seeding"]').trigger('click')
    expect(seeding.emitted('pause')).toBeTruthy()
    await seeding.find('[aria-label="task.finish-seeding"]').trigger('click')
    expect(seeding.emitted('finish-sharing')).toBeTruthy()

    const paused = mountActions(
      makeTask('paused', {
        completedLength: '1024',
        seeder: 'true',
        bittorrent: { state: 'paused' },
      }),
    )
    await paused.find('[aria-label="task.resume-seeding"]').trigger('click')
    expect(paused.emitted('resume')).toBeTruthy()
    expect(paused.find('[aria-label="task.finish-seeding"]').exists()).toBe(true)
  })

  it('supports the complete ED2K sharing lifecycle', async () => {
    const active = mountActions(
      makeTask('active', {
        completedLength: '1024',
        seeder: 'true',
        ed2k: { hash: 'ed2k-hash' },
      }),
    )
    expect(active.find('[aria-label="task.pause-sharing"]').exists()).toBe(true)
    await active.find('[aria-label="task.finish-sharing"]').trigger('click')
    expect(active.emitted('finish-sharing')).toBeTruthy()

    const paused = mountActions(
      makeTask('paused', {
        completedLength: '1024',
        seeder: 'true',
        ed2k: { hash: 'ed2k-hash' },
      }),
    )
    expect(paused.find('[aria-label="task.resume-sharing"]').exists()).toBe(true)
    expect(paused.find('[aria-label="task.finish-sharing"]').exists()).toBe(true)
  })

  it('limits recovery actions to details and deletion', () => {
    const wrapper = mountActions(
      makeTask('active', {
        completedLength: '1024',
        seeder: 'false',
        bittorrent: { state: 'recovering' },
      }),
    )

    expect(wrapper.find('[aria-label="task.finish-seeding"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="task.delete-task"]').exists()).toBe(true)
  })

  it('offers retry for terminal BitTorrent failures', async () => {
    const wrapper = mountActions(
      makeTask('error', {
        bittorrent: {
          state: 'error',
          error: {
            code: 'network',
            kind: 'network',
            category: 'network',
            recoverable: 'true',
            message: 'network failure',
          },
        },
      }),
    )
    await wrapper.find('[aria-label="task.retry-task"]').trigger('click')
    expect(wrapper.emitted('retry')).toBeTruthy()
  })

  it('keeps terminal actions accessible', () => {
    const wrapper = mountActions(makeTask('complete'))
    const actions = wrapper.findAll('.task-item-action')
    expect(actions).toHaveLength(6)
    expect(actions.every((action) => Boolean(action.attributes('aria-label')))).toBe(true)
  })

  it('separates retry, resume, and re-download actions', async () => {
    const failed = mountActions(makeTask('error'))
    await failed.find('[aria-label="task.retry-task"]').trigger('click')
    expect(failed.emitted('retry')).toBeTruthy()

    const complete = mountActions(makeTask('complete'))
    await complete.find('[aria-label="task.restart-task"]').trigger('click')
    expect(complete.emitted('redownload')).toBeTruthy()
    expect(complete.emitted('resume')).toBeFalsy()
  })
})
