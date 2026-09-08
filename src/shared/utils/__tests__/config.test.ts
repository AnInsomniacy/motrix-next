/** @fileoverview Tests for config utilities. */
import { describe, it, expect } from 'vitest'
import {
  changeKeysToCamelCase,
  changeKeysToKebabCase,
  diffConfig,
  checkIsNeedRestart,
  formatOptionsForEngine,
  filterHotReloadableKeys,
} from '../config'

describe('changeKeysToCamelCase', () => {
  it('converts kebab-case keys to camelCase', () => {
    expect(changeKeysToCamelCase({ 'max-speed': 100 })).toEqual({ maxSpeed: 100 })
  })
  it('returns empty for empty object', () => {
    expect(changeKeysToCamelCase({})).toEqual({})
  })
  it('returns empty for default parameter', () => {
    expect(changeKeysToCamelCase()).toEqual({})
  })
})

describe('changeKeysToKebabCase', () => {
  it('converts camelCase keys to kebab-case', () => {
    expect(changeKeysToKebabCase({ maxSpeed: 100 })).toEqual({ 'max-speed': 100 })
  })

  it('keeps ED2K as one aria2 option prefix', () => {
    expect(
      changeKeysToKebabCase({ ed2kListenPort: 4663, ed2kServerMetUrl: 'https://example.test/server.met' }),
    ).toEqual({
      'ed2k-listen-port': 4663,
      'ed2k-server-met-url': 'https://example.test/server.met',
    })
  })

  it('keeps Aria2 as one engine name prefix', () => {
    expect(changeKeysToKebabCase({ aria2LogLevel: 'warn' })).toEqual({ 'aria2-log-level': 'warn' })
  })
})

describe('diffConfig', () => {
  it('returns only changed keys', () => {
    const result = diffConfig({ a: 1, b: 2 }, { a: 1, b: 3 })
    expect(result).toEqual({ b: 3 })
  })
  it('returns empty for identical configs', () => {
    const result = diffConfig({ a: 1 }, { a: 1 })
    expect(result).toEqual({})
  })
  it('detects changed array values', () => {
    const result = diffConfig({ tags: ['a', 'b'] }, { tags: ['a', 'c'] })
    expect(result).toEqual({ tags: ['a', 'c'] })
  })
  it('returns empty for identical arrays', () => {
    const result = diffConfig({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })
    expect(result).toEqual({})
  })
  it('detects changed nested values', () => {
    const result = diffConfig({ proxy: { host: 'a' } }, { proxy: { host: 'b' } })
    expect(result).toEqual({ proxy: { host: 'b' } })
  })

  it('still detects genuinely different values across types', () => {
    const result = diffConfig({ listenPort: '29120' }, { listenPort: 21302 })
    expect(result).toEqual({ listenPort: 21302 })
  })
})

describe('checkIsNeedRestart', () => {
  it('returns false for empty changes', () => {
    expect(checkIsNeedRestart({})).toBe(false)
  })
  it('returns true for rpcListenPort', () => {
    expect(checkIsNeedRestart({ rpcListenPort: 6800 })).toBe(true)
  })
  it('returns true for rpcSecret', () => {
    expect(checkIsNeedRestart({ rpcSecret: 'new-secret-value' })).toBe(true)
  })
  it('returns false for the hot-reloadable BitTorrent listen port', () => {
    expect(checkIsNeedRestart({ listenPort: 21302 })).toBe(false)
  })
  it('keeps native BitTorrent settings hot-reloadable', () => {
    expect(checkIsNeedRestart({ btDhtEnabled: false })).toBe(false)
    expect(checkIsNeedRestart({ btPeerExchangeEnabled: false })).toBe(false)
    expect(checkIsNeedRestart({ btLocalPeerDiscoveryEnabled: false })).toBe(false)
    expect(checkIsNeedRestart({ btEncryption: 'required' })).toBe(false)
    expect(checkIsNeedRestart({ btMaxPeers: 256 })).toBe(false)
    expect(checkIsNeedRestart({ aria2LogLevel: 'info' })).toBe(false)
  })
  it('returns true for ED2K restart keys from AppConfig camelCase fields', () => {
    expect(checkIsNeedRestart({ ed2kListenPort: 4663 })).toBe(true)
    expect(checkIsNeedRestart({ ed2kServer: 'server.example:4661' })).toBe(true)
    expect(checkIsNeedRestart({ ed2kUploadSlots: 4 })).toBe(true)
  })
  it('returns false for non-restart keys', () => {
    expect(checkIsNeedRestart({ theme: 'dark' })).toBe(false)
  })
  it('detects restart key among multiple changes', () => {
    expect(checkIsNeedRestart({ theme: 'dark', rpcSecret: 'changed' })).toBe(true)
  })
})

describe('formatOptionsForEngine', () => {
  it('converts keys to kebab-case', () => {
    const result = formatOptionsForEngine({ maxSpeed: '100' })
    expect(result).toHaveProperty('max-speed')
  })
  it('formats ED2K option keys with the aria2 ED2K prefix', () => {
    const result = formatOptionsForEngine({
      ed2kListenPort: 4663,
      ed2kUdpListenPort: 4673,
      ed2kServerMetUrl: 'https://example.test/server.met',
    })
    expect(result).toEqual({
      'ed2k-listen-port': '4663',
      'ed2k-udp-listen-port': '4673',
      'ed2k-server-met-url': 'https://example.test/server.met',
    })
  })
  it('joins arrays with newline', () => {
    const result = formatOptionsForEngine({ trackerSource: ['a', 'b'] })
    expect(result['tracker-source']).toBe('a\nb')
  })
  it('skips null and undefined values', () => {
    const result = formatOptionsForEngine({ a: undefined, b: null })
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('forwards empty-string values for aria2 options that intentionally accept them', () => {
    const result = formatOptionsForEngine({ userAgent: '', referer: '' })
    expect(result['user-agent']).toBe('')
    expect(result.referer).toBe('')
  })
  it('keeps numeric 0 value (converted to string)', () => {
    const result = formatOptionsForEngine({ shareTime: 0 })
    expect(result['share-time']).toBe('0')
  })
  it('converts boolean to string', () => {
    const result = formatOptionsForEngine({ checkIntegrity: true })
    expect(result['check-integrity']).toBe('true')
  })
})

describe('filterHotReloadableKeys', () => {
  it('passes through hot-reloadable keys unchanged', () => {
    const config = {
      'max-concurrent-downloads': '10',
      'stream-max-connections': '16',
      'max-overall-download-limit': '0',
      dir: '/downloads',
    }
    expect(filterHotReloadableKeys(config)).toEqual(config)
  })

  it('keeps the live BitTorrent endpoint and strips restart-only ports and secrets', () => {
    const config = {
      'rpc-listen-port': '29100',
      'allow-remote-access': 'false',
      'rpc-secret': 'abc',
      'listen-port': '29120',
      'bt-external-ip': '203.0.113.7',
      'bt-external-port': '62000',
      'ed2k-listen-port': '29140',
      'ed2k-udp-listen-port': '29150',
      'enable-dht': 'true',
      'enable-peer-exchange': 'true',
      'bt-enable-lpd': 'true',
      'bt-encryption': 'enabled',
      'bt-port-mapping': 'true',
      'bt-max-peers': '128',
    }
    expect(filterHotReloadableKeys(config)).toEqual({
      'listen-port': '29120',
      'bt-external-ip': '203.0.113.7',
      'bt-external-port': '62000',
      'enable-dht': 'true',
      'enable-peer-exchange': 'true',
      'bt-enable-lpd': 'true',
      'bt-encryption': 'enabled',
      'bt-port-mapping': 'true',
      'bt-max-peers': '128',
    })
  })

  it('strips aria2 changeGlobalOption exclusions', () => {
    const config = {
      checksum: 'sha-256=abc',
      'index-out': '0=file.txt',
      out: 'output.zip',
      pause: 'true',
      'select-file': '1-3',
    }
    expect(filterHotReloadableKeys(config)).toEqual({})
  })

  it('strips unsupported engine keys by allowlist', () => {
    const config = {
      'not-supported': 'true',
      'stale-local-key': 'false',
      'future-unknown-key': '203.0.113.1',
      'max-overall-download-limit': '1M',
    }
    expect(filterHotReloadableKeys(config)).toEqual({
      'max-overall-download-limit': '1M',
    })
  })

  it('returns empty for empty input', () => {
    expect(filterHotReloadableKeys({})).toEqual({})
  })

  it('separates hot-reloadable from non-hot-reloadable in mixed input', () => {
    const config = {
      'max-concurrent-downloads': '8',
      'allow-remote-access': 'true',
      'rpc-listen-port': '29100',
      'bt-tracker': 'udp://t.example.org:6969',
      'rpc-secret': 'secret',
      'user-agent': 'Motrix/3.4.1',
    }
    expect(filterHotReloadableKeys(config)).toEqual({
      'max-concurrent-downloads': '8',
      'bt-tracker': 'udp://t.example.org:6969',
      'user-agent': 'Motrix/3.4.1',
    })
  })
})
