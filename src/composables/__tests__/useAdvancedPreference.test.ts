import { describe, expect, it } from 'vitest'
import { buildAdvancedForm, buildAdvancedSystemConfig, transformAdvancedForStore } from '../useAdvancedPreference'
import { createDefaultAppConfig } from '@shared/utils/configHydration'

describe('Advanced preference ownership', () => {
  it('defaults to an independent window and preserves an explicitly disabled setting', () => {
    const config = createDefaultAppConfig()
    expect(buildAdvancedForm(config).useIndependentDownloadWindow).toBe(true)
    const form = buildAdvancedForm({ ...config, useIndependentDownloadWindow: false })
    expect(form.useIndependentDownloadWindow).toBe(false)
    expect(transformAdvancedForStore(form).useIndependentDownloadWindow).toBe(false)
  })

  it('sends only RPC options and persists flattened clipboard switches', () => {
    const form = buildAdvancedForm(createDefaultAppConfig())
    expect(buildAdvancedSystemConfig(form)).toEqual({
      'rpc-listen-port': String(form.rpcListenPort),
      'allow-remote-access': String(form.allowRemoteAccess),
      'rpc-secret': form.rpcSecret,
    })
    const stored = transformAdvancedForStore({ ...form, clipboardSftp: false })
    expect(stored.clipboard).toMatchObject({ sftp: false })
    expect(stored).not.toHaveProperty('clipboardSftp')
    expect(stored).not.toHaveProperty('proxy')
    expect(stored).not.toHaveProperty('connectTimeout')
  })
})
