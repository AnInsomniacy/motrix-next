import { beforeEach, describe, expect, it, vi } from 'vitest'

interface RestartDialogOptions {
  onPositiveClick: () => void
  onAfterLeave: () => void
}

const infoMock = vi.fn<(options: RestartDialogOptions) => void>()
const restartMock = vi.fn<(cause: string) => Promise<void>>()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({ useDialog: () => ({ info: infoMock }) }))
vi.mock('@/stores/engine', () => ({ useEngineStore: () => ({ restart: restartMock }) }))

import { useEngineRestart } from '@/composables/useEngineRestart'

describe('useEngineRestart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    restartMock.mockResolvedValue(undefined)
  })

  it('starts the engine restart only after the confirmation dialog leaves', () => {
    const { confirmManualRestart } = useEngineRestart()
    confirmManualRestart()
    const options = infoMock.mock.calls[0]?.[0]
    expect(options).toBeDefined()
    if (!options) throw new Error('Restart confirmation was not opened')

    expect(options.onPositiveClick()).toBeUndefined()
    expect(restartMock).not.toHaveBeenCalled()

    options.onAfterLeave()
    expect(restartMock).toHaveBeenCalledWith('manualRestart')
  })

  it('does nothing when the confirmation dialog closes without acceptance', () => {
    const { confirmManualRestart } = useEngineRestart()
    confirmManualRestart()
    const options = infoMock.mock.calls[0]?.[0]
    expect(options).toBeDefined()
    if (!options) throw new Error('Restart confirmation was not opened')

    options.onAfterLeave()
    expect(restartMock).not.toHaveBeenCalled()
  })
})
