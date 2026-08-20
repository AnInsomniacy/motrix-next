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
  isValidAria2ProxyUrl,
  randomRpcPort,
  type AdvancedForm,
} from '../useAdvancedPreference'
import {
  ENGINE_RPC_PORT,
  PROXY_SCOPES,
  PROXY_SCOPE_OPTIONS,
  DEFAULT_APP_CONFIG,
  PORT_RECOVERY_RANGE_START,
  PORT_RECOVERY_RANGE_END,
} from '@shared/constants'
import { diffConfig } from '@shared/utils/config'
import { createDefaultAppConfig } from '@shared/utils/configHydration'
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
    expect(form.proxy.mode).toBe('direct')
    expect(form.proxy.server).toBe('')
    // Default scope must include ALL scopes so proxy works on first enable
    // (legacy Motrix behavior — scope defaults to PROXY_SCOPE_OPTIONS)
    expect(form.proxy.scope).toEqual(expect.arrayContaining([PROXY_SCOPES.DOWNLOAD]))
    expect(form.proxy.scope).toHaveLength(PROXY_SCOPE_OPTIONS.length)
    expect(form.rpcListenPort).toBe(ENGINE_RPC_PORT)
    expect(form.allowRemoteAccess).toBe(false)
    expect(form.logLevel).toBe('warn')
    expect(form.aria2LogLevel).toBe('warn')
    expect(form.enableUpnp).toBe(true)
    expect(form.useIndependentDownloadWindow).toBe(true)
  })

  it('uses the runtime secrets already created by config hydration', () => {
    const config = createDefaultAppConfig()
    const { form } = buildAdvancedForm(config)
    expect(form.rpcSecret).toBe(config.rpcSecret)
    expect(form.extensionApiSecret).toBe(config.extensionApiSecret)
  })

  it('uses existing secret and does not flag it', () => {
    const config = { rpcSecret: 'myExistingSecret' } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.rpcSecret).toBe('myExistingSecret')
  })

  it('preserves explicitly empty secret without regenerating', () => {
    const config = { rpcSecret: '' } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.rpcSecret).toBe('')
  })

  it('preserves proxy configuration', () => {
    const config = {
      proxy: {
        mode: 'manual',
        server: 'socks5://127.0.0.1:1080',
        bypass: '*.local',
        scope: ['download'],
      },
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.proxy.mode).toBe('manual')
    expect(form.proxy.server).toBe('socks5://127.0.0.1:1080')
    expect(form.proxy.bypass).toBe('*.local')
    expect(form.proxy.scope).toEqual(['download'])
  })

  it('handles enableUpnp=false explicitly', () => {
    const config = { enableUpnp: false } as unknown as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.enableUpnp).toBe(false)
  })

  it('preserves a disabled independent download window', () => {
    const config = { useIndependentDownloadWindow: false } as unknown as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.useIndependentDownloadWindow).toBe(false)
  })
})

// ── buildAdvancedSystemConfig ───────────────────────────────────────

describe('buildAdvancedSystemConfig', () => {
  const baseForm: AdvancedForm = {
    proxy: { mode: 'direct', server: '', bypass: '', scope: [] },
    rpcListenPort: 29100,
    rpcSecret: 'testSecret',
    enableUpnp: true,
    userAgent: '',
    logLevel: 'warn',
    aria2LogLevel: 'info',
    tempFilesDir: '',
    hardwareRendering: false,
    extensionApiPort: 29110,
    extensionApiSecret: 'test-api-secret',
    allowRemoteAccess: false,
    useIndependentDownloadWindow: true,
    autoSubmitFromExtension: false,
    autoSelectAllBtFilesFromExtension: false,
    silentAutoSubmitFromExtension: true,
    autoChangeConflictingPorts: true,
    clipboardEnable: true,
    clipboardHttp: true,
    clipboardFtp: false,
    clipboardMagnet: true,
    clipboardEd2k: true,
    clipboardThunder: false,
    clipboardBtHash: true,
    connectTimeout: 60,
    timeout: 60,
    fileAllocation: 'prealloc',
  }

  it('maps all required aria2 config keys', () => {
    const config = buildAdvancedSystemConfig(baseForm)
    expect(config['rpc-listen-port']).toBe('29100')
    expect(config['allow-remote-access']).toBe('false')
    expect(config['rpc-secret']).toBe('testSecret')
    expect(config).not.toHaveProperty('enable-dht')
    expect(config).not.toHaveProperty('enable-peer-exchange')
    expect(config).not.toHaveProperty('listen-port')
    expect(config).not.toHaveProperty('dht-listen-port')
    expect(config).not.toHaveProperty('log-level')
  })

  it('enables remote access only when requested', () => {
    const config = buildAdvancedSystemConfig({ ...baseForm, allowRemoteAccess: true })
    expect(config['allow-remote-access']).toBe('true')
  })

  it('sets manual proxy options when enabled for downloads', () => {
    const proxyForm: AdvancedForm = {
      ...baseForm,
      proxy: {
        mode: 'manual',
        server: 'http://proxy:8080',
        bypass: '*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    }
    const config = buildAdvancedSystemConfig(proxyForm)
    expect(config['proxy-mode']).toBeUndefined()
    expect(config['all-proxy']).toBe('http://proxy:8080')
    expect(config['no-proxy']).toBe('*.local')
  })

  it('clears proxy options when download scope is excluded', () => {
    const noProxyForm: AdvancedForm = {
      ...baseForm,
      proxy: { mode: 'manual', server: 'http://proxy:8080', bypass: '*.local', scope: ['app'] },
    }
    const config = buildAdvancedSystemConfig(noProxyForm)
    expect(config['proxy-mode']).toBeUndefined()
    expect(config['all-proxy']).toBe('')
    expect(config['no-proxy']).toBe('')
  })

  it('clears proxy options when proxy is direct', () => {
    const disabledForm: AdvancedForm = {
      ...baseForm,
      proxy: { mode: 'direct', server: 'http://proxy:8080', bypass: '', scope: [PROXY_SCOPES.DOWNLOAD] },
    }
    const config = buildAdvancedSystemConfig(disabledForm)
    expect(config['proxy-mode']).toBeUndefined()
    expect(config['all-proxy']).toBe('')
  })
})

// ── transformAdvancedForStore ────────────────────────────────────────

describe('transformAdvancedForStore', () => {
  it('persists ED2K clipboard toggle', () => {
    const form: AdvancedForm = {
      proxy: { mode: 'direct', server: '', bypass: '', scope: [] },
      rpcListenPort: 29100,
      rpcSecret: 'x',
      enableUpnp: true,
      userAgent: '',
      logLevel: 'warn',
      aria2LogLevel: 'info',
      tempFilesDir: '',
      hardwareRendering: false,
      extensionApiPort: 29110,
      extensionApiSecret: 'test-api-secret',
      allowRemoteAccess: false,
      useIndependentDownloadWindow: true,
      autoSubmitFromExtension: false,
      autoSelectAllBtFilesFromExtension: false,
      silentAutoSubmitFromExtension: true,
      autoChangeConflictingPorts: true,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardEd2k: false,
      clipboardThunder: false,
      clipboardBtHash: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }

    const result = transformAdvancedForStore(form)

    expect(result.clipboard).toMatchObject({ ed2k: false })
  })

  it('preserves automatic conflicting port switching preference', () => {
    const form = buildAdvancedForm({ ...createDefaultAppConfig(), autoChangeConflictingPorts: false } as AppConfig).form
    const result = transformAdvancedForStore(form)
    expect(result.autoChangeConflictingPorts).toBe(false)
  })

  it('preserves remote access preference', () => {
    const form = buildAdvancedForm({ ...createDefaultAppConfig(), allowRemoteAccess: true } as AppConfig).form
    const result = transformAdvancedForStore(form)
    expect(result.allowRemoteAccess).toBe(true)
  })

  it('round-trip: buildAdvancedForm → transformAdvancedForStore produces no phantom diff', () => {
    // This is the exact scenario that caused the bug: config → form → store → diffConfig
    // should report ZERO changes when the user didn't touch anything.
    const config = {
      rpcListenPort: 29100,
      rpcSecret: 'existingSecret',
      enableUpnp: false,
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    const stored = transformAdvancedForStore(form)
    const diff = diffConfig(config as Record<string, unknown>, stored)
    // None of the restart-relevant keys should appear in the diff
    expect(diff).not.toHaveProperty('rpcListenPort')
    expect(diff).not.toHaveProperty('rpcSecret')
  })
})

// ── isValidAria2ProxyUrl ────────────────────────────────────────────

describe('isValidAria2ProxyUrl', () => {
  // ── Valid inputs ──────────────────────────────────────────────────

  it('accepts empty string (clears proxy)', () => {
    expect(isValidAria2ProxyUrl('')).toBe(true)
  })

  it('accepts whitespace-only string', () => {
    expect(isValidAria2ProxyUrl('   ')).toBe(true)
  })

  it('accepts http:// proxy', () => {
    expect(isValidAria2ProxyUrl('http://127.0.0.1:8080')).toBe(true)
  })

  it('accepts https:// proxy', () => {
    expect(isValidAria2ProxyUrl('https://proxy.example.com:443')).toBe(true)
  })

  it('accepts ftp:// proxy', () => {
    expect(isValidAria2ProxyUrl('ftp://proxy.example.com:21')).toBe(true)
  })

  it('accepts http:// with user:password', () => {
    expect(isValidAria2ProxyUrl('http://user:pass@proxy.example.com:8080')).toBe(true)
  })

  it('accepts bare HOST:PORT (no scheme)', () => {
    expect(isValidAria2ProxyUrl('127.0.0.1:8080')).toBe(true)
  })

  it('accepts bare hostname (no port, no scheme)', () => {
    expect(isValidAria2ProxyUrl('proxy.example.com')).toBe(true)
  })

  it('accepts URL with leading/trailing whitespace', () => {
    expect(isValidAria2ProxyUrl('  http://proxy:8080  ')).toBe(true)
  })

  // ── Rejected inputs ───────────────────────────────────────────────

  it('rejects socks5:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks5://127.0.0.1:1080')).toBe(false)
  })

  it('rejects socks4:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks4://127.0.0.1:1080')).toBe(false)
  })

  it('rejects socks5h:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks5h://127.0.0.1:1080')).toBe(false)
  })

  it('rejects socks4a:// proxy', () => {
    expect(isValidAria2ProxyUrl('socks4a://127.0.0.1:1080')).toBe(false)
  })

  it('rejects SOCKS5:// (case-insensitive)', () => {
    expect(isValidAria2ProxyUrl('SOCKS5://127.0.0.1:1080')).toBe(false)
  })

  it('rejects ws:// scheme', () => {
    expect(isValidAria2ProxyUrl('ws://proxy:8080')).toBe(false)
  })

  it('rejects custom:// scheme', () => {
    expect(isValidAria2ProxyUrl('custom://proxy:8080')).toBe(false)
  })
})

// ── validateAdvancedForm ────────────────────────────────────────────

describe('validateAdvancedForm', () => {
  const validForm: AdvancedForm = {
    proxy: { mode: 'direct', server: '', bypass: '', scope: [] },
    rpcListenPort: 29100,
    rpcSecret: 'validSecret',
    enableUpnp: true,
    userAgent: '',
    logLevel: 'warn',
    aria2LogLevel: 'info',
    tempFilesDir: '',
    hardwareRendering: false,
    extensionApiPort: 29110,
    extensionApiSecret: 'test-api-secret',
    allowRemoteAccess: false,
    useIndependentDownloadWindow: true,
    autoSubmitFromExtension: false,
    autoSelectAllBtFilesFromExtension: false,
    silentAutoSubmitFromExtension: true,
    autoChangeConflictingPorts: true,
    clipboardEnable: true,
    clipboardHttp: true,
    clipboardFtp: false,
    clipboardMagnet: true,
    clipboardEd2k: true,
    clipboardThunder: false,
    clipboardBtHash: true,
    connectTimeout: 60,
    timeout: 60,
    fileAllocation: 'prealloc',
  }

  it('returns null for valid form', () => {
    expect(validateAdvancedForm(validForm)).toBeNull()
  })

  it('returns null when rpcSecret is empty (security warning handled by UI dialog)', () => {
    expect(validateAdvancedForm({ ...validForm, rpcSecret: '' })).toBeNull()
  })

  it('allows remote access with empty secrets', () => {
    expect(validateAdvancedForm({ ...validForm, allowRemoteAccess: true, rpcSecret: '' })).toBeNull()
    expect(validateAdvancedForm({ ...validForm, allowRemoteAccess: true, extensionApiSecret: '' })).toBeNull()
  })

  it('returns null for valid proxy URL in manual mode', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, mode: 'manual', server: 'http://proxy.example.com:8080' },
      }),
    ).toBeNull()
  })

  it('returns invalid-proxy-url for malformed URL in manual mode', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, mode: 'manual', server: 'http://:invalid:url:' },
      }),
    ).toBe('preferences.invalid-proxy-url')
  })

  it('returns proxy-unsupported-protocol for socks5 in manual mode', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, mode: 'manual', server: 'socks5://127.0.0.1:1080' },
      }),
    ).toBe('preferences.proxy-unsupported-protocol')
  })

  it('returns proxy-unsupported-protocol for socks4 in manual mode', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, mode: 'manual', server: 'socks4://127.0.0.1:1080' },
      }),
    ).toBe('preferences.proxy-unsupported-protocol')
  })

  it('returns null for invalid proxy URL in direct mode', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, mode: 'direct', server: 'socks5://127.0.0.1:1080' },
      }),
    ).toBeNull()
  })

  it('returns null for empty proxy server in manual mode', () => {
    expect(
      validateAdvancedForm({
        ...validForm,
        proxy: { ...validForm.proxy, mode: 'manual', server: '' },
      }),
    ).toBeNull()
  })
})

// ── Port Randomizers ────────────────────────────────────────────────

describe('port randomizers', () => {
  it('randomRpcPort stays within the port recovery range', () => {
    for (let i = 0; i < 20; i++) {
      const port = randomRpcPort()
      expect(port).toBeGreaterThanOrEqual(PORT_RECOVERY_RANGE_START)
      expect(port).toBeLessThanOrEqual(PORT_RECOVERY_RANGE_END)
    }
  })
})

// ── Proxy Configuration Invariants ──────────────────────────────────

describe('proxy configuration invariants', () => {
  it('DEFAULT_APP_CONFIG.proxy.scope includes all PROXY_SCOPE_OPTIONS', () => {
    // Regression guard: the root cause of #81 was scope defaulting to []
    // instead of PROXY_SCOPE_OPTIONS, which silently disabled all proxy routing.
    const { form } = buildAdvancedForm({} as AppConfig)
    expect(form.proxy.scope).toEqual([...PROXY_SCOPE_OPTIONS])
  })

  it('buildAdvancedForm preserves user-selected subset of scopes', () => {
    const config = {
      proxy: {
        mode: 'manual',
        server: 'http://127.0.0.1:7890',
        bypass: '',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
    } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.proxy.scope).toEqual([PROXY_SCOPES.DOWNLOAD])
  })

  it('manual proxy with default scope produces non-empty all-proxy', () => {
    // End-to-end: the exact user flow from issue #81.
    // 1. Fresh install → buildAdvancedForm({}) → form with default scope
    // 2. User selects manual mode and enters server
    // 3. buildAdvancedSystemConfig → standard aria2 all-proxy
    const { form } = buildAdvancedForm({} as AppConfig)
    form.proxy.mode = 'manual'
    form.proxy.server = 'http://127.0.0.1:7890'
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['proxy-mode']).toBeUndefined()
    expect(systemConfig['all-proxy']).toBe('http://127.0.0.1:7890')
    expect(systemConfig['no-proxy']).toBeUndefined()
  })

  it('direct proxy mode emits direct without all-proxy', () => {
    const form: AdvancedForm = {
      proxy: {
        mode: 'direct',
        server: 'http://127.0.0.1:7890',
        bypass: '',
        scope: [...PROXY_SCOPE_OPTIONS],
      },
      rpcListenPort: 29100,
      rpcSecret: 'x',
      enableUpnp: true,
      userAgent: '',
      logLevel: 'debug',
      aria2LogLevel: 'info',
      tempFilesDir: '',
      hardwareRendering: false,
      extensionApiPort: 29110,
      extensionApiSecret: 'test-api-secret',
      allowRemoteAccess: false,
      useIndependentDownloadWindow: true,
      autoSubmitFromExtension: false,
      autoSelectAllBtFilesFromExtension: false,
      silentAutoSubmitFromExtension: true,
      autoChangeConflictingPorts: true,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardEd2k: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['proxy-mode']).toBeUndefined()
    expect(systemConfig['all-proxy']).toBe('')
    expect(systemConfig['no-proxy']).toBe('')
  })

  it('proxy with download scope excluded emits direct mode', () => {
    const form: AdvancedForm = {
      proxy: {
        mode: 'manual',
        server: 'http://127.0.0.1:7890',
        bypass: '',
        scope: [PROXY_SCOPES.UPDATE_APP, PROXY_SCOPES.UPDATE_TRACKERS],
      },
      rpcListenPort: 29100,
      rpcSecret: 'x',
      enableUpnp: true,
      userAgent: '',
      logLevel: 'debug',
      aria2LogLevel: 'info',
      tempFilesDir: '',
      hardwareRendering: false,
      extensionApiPort: 29110,
      extensionApiSecret: 'test-api-secret',
      allowRemoteAccess: false,
      useIndependentDownloadWindow: true,
      autoSubmitFromExtension: false,
      autoSelectAllBtFilesFromExtension: false,
      silentAutoSubmitFromExtension: true,
      autoChangeConflictingPorts: true,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardEd2k: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['proxy-mode']).toBeUndefined()
    expect(systemConfig['all-proxy']).toBe('')
  })

  it('proxy bypass value is forwarded to no-proxy when download scope active', () => {
    const form: AdvancedForm = {
      proxy: {
        mode: 'manual',
        server: 'http://proxy:8080',
        bypass: '192.168.0.0/16,*.local',
        scope: [PROXY_SCOPES.DOWNLOAD],
      },
      rpcListenPort: 29100,
      rpcSecret: 'x',
      enableUpnp: true,
      userAgent: '',
      logLevel: 'debug',
      aria2LogLevel: 'info',
      tempFilesDir: '',
      hardwareRendering: false,
      extensionApiPort: 29110,
      extensionApiSecret: 'test-api-secret',
      allowRemoteAccess: false,
      useIndependentDownloadWindow: true,
      autoSubmitFromExtension: false,
      autoSelectAllBtFilesFromExtension: false,
      silentAutoSubmitFromExtension: true,
      autoChangeConflictingPorts: true,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardEd2k: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const systemConfig = buildAdvancedSystemConfig(form)
    expect(systemConfig['proxy-mode']).toBeUndefined()
    expect(systemConfig['all-proxy']).toBe('http://proxy:8080')
    expect(systemConfig['no-proxy']).toBe('192.168.0.0/16,*.local')
  })
})

// ── hardwareRendering — Linux GPU toggle ────────────────────────────

describe('buildAdvancedForm — hardwareRendering', () => {
  it('defaults hardwareRendering to false (software rendering)', () => {
    const { form } = buildAdvancedForm({} as AppConfig)
    expect(form.hardwareRendering).toBe(false)
  })

  it('preserves hardwareRendering=true from config', () => {
    const config = { hardwareRendering: true } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.hardwareRendering).toBe(true)
  })

  it('preserves hardwareRendering=false from config', () => {
    const config = { hardwareRendering: false } as AppConfig
    const { form } = buildAdvancedForm(config)
    expect(form.hardwareRendering).toBe(false)
  })
})

describe('transformAdvancedForStore — hardwareRendering', () => {
  it('preserves hardwareRendering in store output', () => {
    const form: AdvancedForm = {
      proxy: { mode: 'direct', server: '', bypass: '', scope: [] },
      rpcListenPort: 29100,
      rpcSecret: 'x',
      enableUpnp: true,
      userAgent: '',
      logLevel: 'warn',
      aria2LogLevel: 'info',
      tempFilesDir: '',
      hardwareRendering: true,
      extensionApiPort: 29110,
      extensionApiSecret: 'test-api-secret',
      allowRemoteAccess: false,
      useIndependentDownloadWindow: true,
      autoSubmitFromExtension: false,
      autoSelectAllBtFilesFromExtension: false,
      silentAutoSubmitFromExtension: true,
      autoChangeConflictingPorts: true,
      clipboardEnable: true,
      clipboardHttp: true,
      clipboardFtp: false,
      clipboardMagnet: true,
      clipboardEd2k: true,
      clipboardThunder: false,
      clipboardBtHash: true,
      connectTimeout: 60,
      timeout: 60,
      fileAllocation: 'prealloc',
    }
    const result = transformAdvancedForStore(form)
    expect(result.hardwareRendering).toBe(true)
  })
})

describe('DEFAULT_APP_CONFIG — hardwareRendering', () => {
  it('defaults to false (software rendering)', () => {
    expect(DEFAULT_APP_CONFIG.hardwareRendering).toBe(false)
  })
})
