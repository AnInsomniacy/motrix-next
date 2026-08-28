import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Aria2Task } from '@shared/types'
import type { CompletionToastOptions } from '../useNotificationToast'

const { invokeMock, renderToastMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
  renderToastMock: vi.fn((options: CompletionToastOptions) => () => options.body),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../useNotificationToast', () => ({ renderCompletionToast: renderToastMock }))

import {
  handleTaskComplete,
  handleP2pDownloadComplete,
  handleTaskError,
  handleTaskStart,
} from '../useTaskNotifyHandlers'

const task: Aria2Task = {
  gid: 'task-1',
  status: 'complete',
  totalLength: '100',
  completedLength: '100',
  uploadLength: '0',
  downloadSpeed: '0',
  uploadSpeed: '0',
  connections: '0',
  dir: '/downloads',
  files: [
    { index: '1', path: '/downloads/file.zip', length: '100', completedLength: '100', selected: 'true', uris: [] },
  ],
}
const deps = {
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
  messageInfo: vi.fn(),
  onOpenFile: vi.fn(),
  onShowInFolder: vi.fn(),
  t: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}

beforeEach(() => vi.clearAllMocks())

describe('Task notifications', () => {
  it('shows completion actions for the downloaded task without duplicating native notifications', () => {
    handleTaskComplete(task, deps)
    expect(deps.t).toHaveBeenCalledWith('task.download-complete-message', { taskName: 'file.zip' })
    expect(deps.messageSuccess).toHaveBeenCalledWith(expect.any(Function))
    const options = renderToastMock.mock.calls[0][0]
    options.onOpenFile()
    options.onShowInFolder()
    expect(deps.onOpenFile).toHaveBeenCalledWith(task)
    expect(deps.onShowInFolder).toHaveBeenCalledWith(task)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('excludes metadata-only tasks from completion notifications', () => {
    handleTaskComplete({ ...task, bittorrent: { state: 'downloadingMetadata' } }, deps)
    expect(deps.messageSuccess).not.toHaveBeenCalled()
  })

  it.each([
    ['bt', 'task.bt-download-complete-message'],
    ['ed2k', 'task.ed2k-download-complete-message'],
  ] as const)('uses the %s completion message', (kind, key) => {
    handleP2pDownloadComplete(task, kind, deps)
    expect(deps.t).toHaveBeenCalledWith(key, { taskName: 'file.zip' })
    expect(deps.messageSuccess).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('reports download errors with the task name and reason', () => {
    handleTaskError(task, 'Connection failed', deps)
    expect(deps.t).toHaveBeenCalledWith('task.download-fail-message', {
      taskName: 'file.zip',
      reason: 'Connection failed',
    })
    expect(deps.messageError).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('ignores empty submissions and groups batch start notifications', () => {
    handleTaskStart([], deps)
    expect(deps.messageInfo).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    handleTaskStart(['first.zip', 'second.zip'], deps)
    expect(deps.t).toHaveBeenCalledWith('task.download-batch-start-message', {
      taskName: 'first.zip',
      count: 1,
    })
    // Rust notifies on aria2.onDownloadStart, which also covers tasks added
    // outside the app. Invoking from here as well would notify twice.
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('uses the single-task start message', () => {
    handleTaskStart(['file.zip'], deps)
    expect(deps.t).toHaveBeenCalledWith('task.download-start-message', { taskName: 'file.zip' })
  })
})
