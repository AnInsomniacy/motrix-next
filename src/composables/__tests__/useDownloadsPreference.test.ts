import { describe, expect, it } from 'vitest'
import { createDefaultAppConfig } from '@shared/utils/configHydration'
import { buildDownloadsForm, buildDownloadsSystemConfig, transformDownloadsForStore } from '../useDownloadsPreference'

describe('downloads preference contract', () => {
  it('owns the shared P2P lifecycle policy', () => {
    const form = {
      ...buildDownloadsForm(createDefaultAppConfig()),
      sharingMode: 'manual-stop' as const,
    }

    expect(buildDownloadsSystemConfig(form)).toMatchObject({
      'keep-sharing': 'true',
      'seed-ratio': '0',
      'seed-time': '',
    })
    const stored = transformDownloadsForStore(form)
    expect(stored.keepSharing).toBe(true)
    expect(stored).not.toHaveProperty('sharingMode')
  })
})
