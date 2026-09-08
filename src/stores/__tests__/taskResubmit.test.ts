import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resubmitTask } from '../task/resubmit'
import type { Aria2Task, TaskStatus } from '@shared/types'

const makeTask = (status: TaskStatus, extra: Partial<Aria2Task> = {}): Aria2Task => ({
  gid: 'old-gid',
  status,
  totalLength: '100',
  completedLength: status === 'complete' ? '100' : '50',
  uploadLength: '0',
  downloadSpeed: '0',
  uploadSpeed: '0',
  connections: '0',
  dir: '/downloads',
  files: [
    {
      index: '1',
      path: '/downloads/file.zip',
      length: '100',
      completedLength: status === 'complete' ? '100' : '50',
      selected: 'true',
      uris: [
        { uri: 'https://example.com/file.zip', status: 'used' },
        { uri: 'https://example.com/file.zip', status: 'waiting' },
      ],
    },
  ],
  ...extra,
})

function createApi() {
  return {
    addUriAtomic: vi.fn().mockResolvedValue('new-gid'),
    fetchTaskItem: vi.fn().mockResolvedValue(makeTask('active', { gid: 'new-gid' })),
    getOption: vi.fn().mockResolvedValue({ dir: '/downloads', continue: 'true' }),
    removeTask: vi.fn().mockResolvedValue('OK'),
    removeTaskRecord: vi.fn().mockResolvedValue('OK'),
  }
}

const history = { removeRecord: vi.fn().mockResolvedValue(undefined) }

describe('resubmitTask', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retries an errored task with continuation and deduplicated mirrors', async () => {
    const api = createApi()
    await resubmitTask(makeTask('error'), 'retry', api, history, 'prompt')

    expect(api.addUriAtomic).toHaveBeenCalledWith({
      uris: ['https://example.com/file.zip'],
      options: {
        dir: '/downloads',
        continue: 'true',
        allowOverwrite: 'false',
        autoFileRenaming: 'false',
      },
    })
    expect(api.removeTaskRecord).toHaveBeenCalledWith({ gid: 'old-gid' })
  })

  it('re-downloads a completed stream task as a fresh auto-renamed file', async () => {
    const api = createApi()
    await resubmitTask(makeTask('complete'), 'redownload', api, history, 'prompt')

    expect(api.addUriAtomic.mock.calls[0][0].options).toMatchObject({
      continue: 'false',
      allowOverwrite: 'false',
      autoFileRenaming: 'true',
    })
  })

  it('keeps the old record and rolls back when the submitted task is already terminal', async () => {
    const api = createApi()
    api.fetchTaskItem.mockResolvedValue(makeTask('error', { gid: 'new-gid', errorMessage: 'rejected' }))

    await expect(resubmitTask(makeTask('complete'), 'redownload', api, history, 'prompt')).rejects.toThrow('rejected')
    expect(api.removeTask).toHaveBeenCalledWith({ gid: 'new-gid' })
    expect(api.removeTaskRecord).not.toHaveBeenCalled()
    expect(history.removeRecord).not.toHaveBeenCalled()
  })
})
