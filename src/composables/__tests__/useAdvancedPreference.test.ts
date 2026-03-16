/**
 * @fileoverview Tests for useAdvancedPreference pure functions.
 *
 * HONESTY NOTE: These test REAL pure functions — no mocks of the module
 * under test. Only crypto.getRandomValues is validated via output properties.
 */
import { describe, it, expect } from 'vitest'
import {
  generateSecret,
  buildAdvancedForm,
  buildAdvancedSystemConfig,
  transformAdvancedForStore,
  validateAdvancedForm,
  randomRpcPort,
  randomBtPort,
  randomDhtPort,
  type AdvancedForm,
} from '../useAdvancedPreference'
import { ENGINE_RPC_PORT, PROXY_SCOPES } from '@shared/constants'
import { diffConfig } from '@shared/utils/config'
import type { AppConfig } from '@shared/types'

// ── generateSecret ──────────────────────────────────────────────────

describe('generateSecret', () => {
  it('returns a 16-character string', () => {
    const secret = generateSecret()
    expect(secret).toHaveLength(16)
  })

  it('contains only alphanumeric characters', () => {
    const secret = generateSecret()
    expect(secret).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('generates different values on successive calls', () => {
    const s1 = generateSecret()
    const s2 = generateSecret()
    // Cryptographic randomness: extremely unlikely to be equal
    expect(s1).not.toBe(s2)
  })
})

// ── buildAdvancedForm ───────────────────────────────────────────────

describe('buildAdvancedForm', () => {
  const emptyConfig = {} as AppConfig

  it('returns defaults for empty config', () => {
    const { form } = buildAdvancedForm(emptyConfig)
    expect(form.proxy.enable).toBe(false)
    expect(form.proxy.server).toBe('')
    expect(form.proxy.scope).toEqual([])
    expect(form.rpcListenPort).toBe(ENGINE_RPC_PORT)
    expect(form.listenPort).toBe(21301)
    expect(form.dhtListenPort).toBe(26701)
    expect(form.logLevel).toBe('info')
    expect(form.enableUpnp).toBe(false)
  })

  it('generates a secret and flags it when none exists', () => {
    const { form, generatedSecret } = buildAdvancedForm(emptyConfig)
    expect(form.rpcSecret).toHaveLength(16)
    expect(generatedSecret).toBe(form.rpcSecret)
  })

  it('uses existing secret and does not flag it', () => {
    const config = { rpcSecret: 'myExistingSecret' } as AppConfig
    const { form, generatedSecret } = buildAdvancedForm(config)
    expect(form.rpcSecret).toBe('myExistingSecret')
    expect(generatedSecret).toBeNull()
  })

  it('preserves proxy configuration', () => {
    const config = {
      proxy: { enable: true, server: 'socks5://127.0.0.1:1080', bypass: '*.local', scope: ['download'] },
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.proxy.enable).toBe(true)
    expect(form.proxy.server).toBe('socks5://127.0.0.1:1080')
    expect(form.proxy.bypass).toBe('*.local')
    expect(form.proxy.scope).toEqual(['download'])
  })

  it('converts comma-separated trackers to newline format', () => {
    const config = { btTracker: 'udp://t1.org:6969,udp://t2.org:6969' } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.btTracker).toContain('\n')
    expect(form.btTracker).toContain('udp://t1.org:6969')
  })

  it('handles enableUpnp=false explicitly', () => {
    const config = { enableUpnp: false } as unknown as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.enableUpnp).toBe(false)
  })

  it('coerces string port values to numbers', () => {
    const config = { listenPort: '12345' as unknown, dhtListenPort: '54321' as unknown } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.listenPort).toBe(12345)
    expect(form.dhtListenPort).toBe(54321)
  })
})

// ── buildAdvancedSystemConfig ───────────────────────────────────────

describe('buildAdvancedSystemConfig', () => {
  const baseForm: AdvancedForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    trackerSource: [],
    btTracker: 'udp://t1.org:6969\nudp://t2.org:6969',
    autoSyncTracker: false,
    lastSyncTrackerTime: 0,
    rpcListenPort: 16800,
    rpcSecret: 'testSecret',
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    userAgent: '',
    logLevel: 'warn',
  }

  it('maps all required aria2 config keys', () => {
    const config = buildAdvancedSystemConfig(baseForm)
    expect(config['rpc-listen-port']).toBe('16800')
    expect(config['rpc-secret']).toBe('testSecret')
    expect(config['enable-dht']).toBe('true')
    expect(config['enable-peer-exchange']).toBe('true')
    expect(config['listen-port']).toBe('21301')
    expect(config['dht-listen-port']).toBe('26701')
    expect(config['log-level']).toBe('warn')
  })

  it('converts newline trackers to comma-separated', () => {
    const config = buildAdvancedSystemConfig(baseForm)
    expect(config['bt-tracker']).toBe('udp://t1.org:6969,udp://t2.org:6969')
  })

  it('sets proxy when enabled for downloads', () => {
    const proxyForm: AdvancedForm = {
      ...baseForm,
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    }
    const config = buildAdvancedSystemConfig(proxyForm)
    expect(config['all-proxy']).toBe('http://proxy:8080')
    expect(config['no-proxy']).toBe('*.local')
  })

  it('clears proxy when not enabled for downloads', () => {
    const noProxyForm: AdvancedForm = {
      ...baseForm,
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '*.local', scope: ['app'] },
    }
    const config = buildAdvancedSystemConfig(noProxyForm)
    expect(config['all-proxy']).toBe('')
    expect(config['no-proxy']).toBe('')
  })

  it('clears proxy when proxy is disabled', () => {
    const disabledForm: AdvancedForm = {
      ...baseForm,
      proxy: { enable: false, server: 'http://proxy:8080', bypass: '', scope: [PROXY_SCOPES.DOWNLOAD] },
    }
    const config = buildAdvancedSystemConfig(disabledForm)
    expect(config['all-proxy']).toBe('')
  })
})

// ── transformAdvancedForStore ────────────────────────────────────────

describe('transformAdvancedForStore', () => {
  it('converts trackers back to comma format', () => {
    const form: AdvancedForm = {
      proxy: { enable: false, server: '', bypass: '', scope: [] },
      trackerSource: [],
      btTracker: 'udp://a\nudp://b',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'warn',
    }
    const result = transformAdvancedForStore(form)
    expect(result.btTracker).toBe('udp://a,udp://b')
  })

  it('preserves port numbers as numbers (not strings)', () => {
    const form: AdvancedForm = {
      proxy: { enable: false, server: '', bypass: '', scope: [] },
      trackerSource: [],
      btTracker: '',
      autoSyncTracker: false,
      lastSyncTrackerTime: 0,
      rpcListenPort: 16800,
      rpcSecret: 'x',
      enableUpnp: true,
      listenPort: 21301,
      dhtListenPort: 26701,
      userAgent: '',
      logLevel: 'warn',
    }
    const result = transformAdvancedForStore(form)
    expect(result.listenPort).toBe(21301)
    expect(typeof result.listenPort).toBe('number')
    expect(result.dhtListenPort).toBe(26701)
    expect(typeof result.dhtListenPort).toBe('number')
  })

  it('round-trip: buildAdvancedForm → transformAdvancedForStore produces no phantom diff', () => {
    // This is the exact scenario that caused the bug: config → form → store → diffConfig
    // should report ZERO changes when the user didn't touch anything.
    const config = {
      listenPort: 21301,
      dhtListenPort: 26701,
      rpcListenPort: 16800,
      rpcSecret: 'existingSecret',
      enableUpnp: false,
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    const stored = transformAdvancedForStore(form)
    const diff = diffConfig(config as Record<string, unknown>, stored)
    // None of the restart-relevant keys should appear in the diff
    expect(diff).not.toHaveProperty('listenPort')
    expect(diff).not.toHaveProperty('dhtListenPort')
    expect(diff).not.toHaveProperty('rpcListenPort')
    expect(diff).not.toHaveProperty('rpcSecret')
  })
})

// ── validateAdvancedForm ────────────────────────────────────────────

describe('validateAdvancedForm', () => {
  const validForm: AdvancedForm = {
    proxy: { enable: false, server: '', bypass: '', scope: [] },
    trackerSource: [],
    btTracker: '',
    autoSyncTracker: false,
    lastSyncTrackerTime: 0,
    rpcListenPort: 16800,
    rpcSecret: 'validSecret',
    enableUpnp: true,
    listenPort: 21301,
    dhtListenPort: 26701,
    userAgent: '',
    logLevel: 'warn',
  }

  it('returns null for valid form', () => {
    expect(validateAdvancedForm(validForm)).toBeNull()
  })

  it('returns null when rpcSecret is empty (security warning handled by UI dialog)', () => {
    expect(validateAdvancedForm({ ...validForm, rpcSecret: '' })).toBeNull()
  })
})

// ── Port Randomizers ────────────────────────────────────────────────

describe('port randomizers', () => {
  it('randomRpcPort stays within [ENGINE_RPC_PORT, 20000)', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomRpcPort()
      expect(port).toBeGreaterThanOrEqual(ENGINE_RPC_PORT)
      expect(port).toBeLessThan(20000)
    }
  })

  it('randomBtPort stays within [20000, 24999)', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomBtPort()
      expect(port).toBeGreaterThanOrEqual(20000)
      expect(port).toBeLessThan(24999)
    }
  })

  it('randomDhtPort stays within [25000, 29999)', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomDhtPort()
      expect(port).toBeGreaterThanOrEqual(25000)
      expect(port).toBeLessThan(29999)
    }
  })
})
