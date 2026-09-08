import { describe, expect, it } from 'vitest'
import {
  buildNetworkForm,
  buildNetworkSystemConfig,
  transformNetworkForStore,
  validateNetworkForm,
} from '../useNetworkPreference'
import { PROXY_SCOPES } from '@shared/constants'
import { createDefaultAppConfig } from '@shared/utils/configHydration'

describe('Network preference contract', () => {
  it('maps persisted transfer and proxy values into the form', () => {
    const form = buildNetworkForm({
      ...createDefaultAppConfig(),
      connectTimeout: 30,
      timeout: 60,
      fileAllocation: 'prealloc',
      userAgent: 'Custom/1.0',
      proxy: {
        mode: 'manual',
        server: 'http://proxy.example.com:8080',
        username: 'user',
        password: 'pass',
        bypass: '*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    })

    expect(form).toMatchObject({
      connectTimeout: 30,
      timeout: 60,
      fileAllocation: 'prealloc',
      userAgent: 'Custom/1.0',
      proxy: {
        mode: 'manual',
        server: 'http://proxy.example.com:8080',
        username: 'user',
        password: 'pass',
        bypass: '*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    })
  })

  it('builds authenticated proxy and transfer engine options', () => {
    const form = buildNetworkForm(createDefaultAppConfig())
    form.connectTimeout = 30
    form.timeout = 60
    form.fileAllocation = 'prealloc'
    form.userAgent = 'Custom/1.0'
    form.proxy = {
      mode: 'manual',
      server: 'http://proxy.example.com:8080',
      username: 'user',
      password: 'pass',
      bypass: '*.local',
      scope: [PROXY_SCOPES.DOWNLOAD],
    }

    expect(buildNetworkSystemConfig(form)).toMatchObject({
      'connect-timeout': '30',
      timeout: '60',
      'file-allocation': 'prealloc',
      'user-agent': 'Custom/1.0',
      'all-proxy': 'http://proxy.example.com:8080',
      'all-proxy-user': 'user',
      'all-proxy-passwd': 'pass',
      'no-proxy': '*.local',
    })
  })

  it('clears engine proxy options when direct mode is active', () => {
    const form = buildNetworkForm(createDefaultAppConfig())
    expect(buildNetworkSystemConfig(form)).toMatchObject({
      'all-proxy': '',
      'all-proxy-user': '',
      'all-proxy-passwd': '',
      'no-proxy': '',
    })
  })

  it('persists the form-owned network settings', () => {
    const form = buildNetworkForm(createDefaultAppConfig())
    form.portConflictRecovery.enabled = false
    const stored = transformNetworkForStore(form)

    expect(stored.autoChangeConflictingPorts).toBe(false)
    expect(stored.portConflictRecovery).toEqual(form.portConflictRecovery)
    expect(stored.proxy).toEqual(form.proxy)
    expect(stored).not.toHaveProperty('listenPort')
  })

  it('validates active proxy and port recovery settings', () => {
    const form = buildNetworkForm(createDefaultAppConfig())
    expect(validateNetworkForm(form)).toBeNull()

    form.portConflictRecovery.rangeStart = 29999
    form.portConflictRecovery.rangeEnd = 29000
    expect(validateNetworkForm(form)).toBe('preferences.port-conflict-recovery-invalid-range')

    form.portConflictRecovery.enabled = false
    form.proxy.mode = 'manual'
    form.proxy.server = 'socks5://127.0.0.1:1080'
    expect(validateNetworkForm(form)).toBe('preferences.proxy-unsupported-protocol')
  })
})
