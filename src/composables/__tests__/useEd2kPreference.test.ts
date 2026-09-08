/**
 * @fileoverview Tests for ED2K preference pure functions.
 *
 * ED2K uses server/server.met/nodes.dat/Kad discovery, not BitTorrent trackers.
 * These tests lock the form and engine-option mapping before the UI is wired.
 */
import { describe, expect, it } from 'vitest'
import {
  buildEd2kForm,
  buildEd2kSystemConfig,
  ED2K_SEARCH_MAX_DURATION_MS,
  getEd2kSearchToastKey,
  randomEd2kPort,
  shouldFinishEd2kSearchPoll,
  transformEd2kForStore,
  validateEd2kForm,
  validateServerLines,
  type Ed2kForm,
} from '../useEd2kPreference'
import type { AppConfig } from '@shared/types'

const baseForm: Ed2kForm = {
  ed2kListenPort: 29140,
  ed2kUdpListenPort: 29150,
  ed2kServer: '',
  ed2kServerMetUrl: 'https://upd.emule-security.org/server.met',
  ed2kNodesDatUrl: 'https://upd.emule-security.org/nodes.dat',
  ed2kBootstrapAutoSync: true,
  ed2kBootstrapSyncIntervalHours: 24,
  ed2kUploadSlots: 3,
  ed2kMaxConnections: 20,
  ed2kPreviewPriority: false,
  ed2kSearchTimeout: 20,
}

describe('buildEd2kForm', () => {
  it('defaults to Aria2 Next ED2K values', () => {
    const form = buildEd2kForm({} as AppConfig)

    expect(form.ed2kListenPort).toBe(29140)
    expect(form.ed2kUdpListenPort).toBe(29150)
    expect(form.ed2kServer).toBe('')
    expect(form.ed2kServerMetUrl).toBe('https://upd.emule-security.org/server.met')
    expect(form.ed2kNodesDatUrl).toBe('https://upd.emule-security.org/nodes.dat')
    expect(form.ed2kBootstrapAutoSync).toBe(true)
    expect(form.ed2kBootstrapSyncIntervalHours).toBe(24)
    expect(form.ed2kUploadSlots).toBe(3)
    expect(form.ed2kMaxConnections).toBe(20)
    expect(form.ed2kPreviewPriority).toBe(false)
    expect(form.ed2kSearchTimeout).toBe(20)
  })

  it('renders persisted server list as one item per line', () => {
    const form = buildEd2kForm({
      ed2kServer: 'server-one.example:4661,server-two.example:4661',
    } as AppConfig)

    expect(form.ed2kServer).toBe('server-one.example:4661\nserver-two.example:4661')
  })
})

describe('buildEd2kSystemConfig', () => {
  it('maps ED2K fields to Aria2 Next startup option keys', () => {
    const config = buildEd2kSystemConfig({
      ...baseForm,
      ed2kServer: 'server-one.example:4661\nserver-two.example:4661',
    })

    expect(config).toEqual({
      'ed2k-listen-port': '29140',
      'ed2k-udp-listen-port': '29150',
      'ed2k-server': 'server-one.example:4661,server-two.example:4661',
      'ed2k-upload-slots': '3',
      'ed2k-max-connections': '20',
      'ed2k-preview-priority': 'false',
    })
  })
})

describe('transformEd2kForStore', () => {
  it('stores normalized ED2K values in AppConfig shape', () => {
    const result = transformEd2kForStore({
      ...baseForm,
      ed2kServer: ' server-one.example:4661 \n\nserver-two.example:4661 ',
      ed2kServerMetUrl: ' https://example.test/server.met ',
      ed2kNodesDatUrl: ' https://example.test/nodes.dat ',
      ed2kBootstrapAutoSync: false,
      ed2kBootstrapSyncIntervalHours: 168,
      ed2kSearchTimeout: 120,
    })

    expect(result).toEqual({
      ed2kListenPort: 29140,
      ed2kUdpListenPort: 29150,
      ed2kServer: 'server-one.example:4661,server-two.example:4661',
      ed2kServerMetUrl: 'https://example.test/server.met',
      ed2kNodesDatUrl: 'https://example.test/nodes.dat',
      ed2kBootstrapAutoSync: false,
      ed2kBootstrapSyncIntervalHours: 168,
      ed2kUploadSlots: 3,
      ed2kMaxConnections: 20,
      ed2kPreviewPriority: false,
      ed2kSearchTimeout: 120,
    })
  })
})

describe('validateEd2kForm', () => {
  it('accepts port 0 so Aria2 Next can ask the OS for an available port', () => {
    expect(validateEd2kForm({ ...baseForm, ed2kListenPort: 0 })).toBeNull()
    expect(validateEd2kForm({ ...baseForm, ed2kUdpListenPort: 0 })).toBeNull()
  })

  it('rejects invalid listen ports', () => {
    expect(validateEd2kForm({ ...baseForm, ed2kListenPort: -1 })).toBe('preferences.ed2k-invalid-listen-port')
    expect(validateEd2kForm({ ...baseForm, ed2kListenPort: 65536 })).toBe('preferences.ed2k-invalid-listen-port')
    expect(validateEd2kForm({ ...baseForm, ed2kUdpListenPort: -1 })).toBe('preferences.ed2k-invalid-listen-port')
    expect(validateEd2kForm({ ...baseForm, ed2kUdpListenPort: 65536 })).toBe('preferences.ed2k-invalid-listen-port')
  })

  it('rejects invalid upload slot counts', () => {
    expect(validateEd2kForm({ ...baseForm, ed2kUploadSlots: 0 })).toBe('preferences.ed2k-invalid-upload-slots')
  })

  it('rejects invalid search timeout values', () => {
    expect(validateEd2kForm({ ...baseForm, ed2kSearchTimeout: 9 })).toBe('preferences.ed2k-invalid-search-timeout')
    expect(validateEd2kForm({ ...baseForm, ed2kSearchTimeout: 601 })).toBe('preferences.ed2k-invalid-search-timeout')
  })

  it('rejects malformed ED2K server endpoints', () => {
    expect(validateEd2kForm({ ...baseForm, ed2kServer: 'server.example:not-a-port' })).toBe(
      'preferences.ed2k-invalid-server',
    )
  })

  it('rejects invalid bootstrap URLs', () => {
    expect(validateEd2kForm({ ...baseForm, ed2kNodesDatUrl: 'not-a-url' })).toBe(
      'preferences.ed2k-invalid-bootstrap-url',
    )
  })
})

describe('validateServerLines', () => {
  it('accepts empty server lists and host:port rows', () => {
    expect(validateServerLines('')).toBe(true)
    expect(validateServerLines('server.example:4661\n192.0.2.10:4661')).toBe(true)
  })

  it('rejects missing hosts, missing ports, and out-of-range ports', () => {
    expect(validateServerLines(':4661')).toBe(false)
    expect(validateServerLines('server.example')).toBe(false)
    expect(validateServerLines('server.example:70000')).toBe(false)
  })
})

describe('randomEd2kPort', () => {
  it('chooses ports from the ED2K auto-recovery range', () => {
    for (let i = 0; i < 100; i++) {
      const port = randomEd2kPort()
      expect(port).toBeGreaterThanOrEqual(29000)
      expect(port).toBeLessThanOrEqual(29999)
    }
  })
})

describe('getEd2kSearchToastKey', () => {
  it('returns specific terminal toast keys for ED2K search outcomes', () => {
    expect(getEd2kSearchToastKey('completed', 4)).toBe('preferences.ed2k-search-completed')
    expect(getEd2kSearchToastKey('completed', 0)).toBe('preferences.ed2k-search-empty')
    expect(getEd2kSearchToastKey('cancelled', 2)).toBe('preferences.ed2k-search-cancelled-with-results')
    expect(getEd2kSearchToastKey('cancelled', 0)).toBe('preferences.ed2k-search-cancelled')
    expect(getEd2kSearchToastKey('failed', 0)).toBe('preferences.ed2k-search-failed')
  })
})

describe('shouldFinishEd2kSearchPoll', () => {
  it('keeps searching with empty results until the configured timeout', () => {
    expect(
      shouldFinishEd2kSearchPoll({
        elapsedMs: ED2K_SEARCH_MAX_DURATION_MS - 1000,
        resultCount: 0,
        previousResultCount: 0,
        stablePolls: 10,
        moreResults: false,
        maxDurationMs: ED2K_SEARCH_MAX_DURATION_MS,
      }),
    ).toBe(false)
  })

  it('finishes only when the configured timeout is reached', () => {
    expect(
      shouldFinishEd2kSearchPoll({
        elapsedMs: ED2K_SEARCH_MAX_DURATION_MS - 1000,
        resultCount: 4,
        previousResultCount: 4,
        stablePolls: 2,
        maxDurationMs: ED2K_SEARCH_MAX_DURATION_MS,
      }),
    ).toBe(false)
    expect(
      shouldFinishEd2kSearchPoll({
        elapsedMs: ED2K_SEARCH_MAX_DURATION_MS,
        resultCount: 7,
        previousResultCount: 3,
        stablePolls: 0,
        moreResults: true,
        maxDurationMs: ED2K_SEARCH_MAX_DURATION_MS,
      }),
    ).toBe(true)
  })
})
