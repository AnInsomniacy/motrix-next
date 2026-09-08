import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STAT_BASE_INTERVAL, STAT_MAX_INTERVAL, STAT_MIN_INTERVAL } from '@shared/timing'

// ── Mocks ───────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(() => 'macos'),
}))

const submitManualUrisMock = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const submitBatchItemsMock = vi.hoisted(() => vi.fn().mockResolvedValue(0))
const resolveUnresolvedItemsMock = vi.hoisted(() =>
  vi.fn(async (items: import('@shared/types').BatchItem[], _t: (key: string) => string, _downloadProxy?: string) => {
    for (const item of items) {
      item.payload = 'resolved-payload'
      item.status = 'pending'
    }
  }),
)

vi.mock('@/composables/useAddTaskSubmit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useAddTaskSubmit')>()
  return {
    ...actual,
    submitManualUris: (...args: Parameters<typeof actual.submitManualUris>) => submitManualUrisMock(...args),
    submitBatchItems: (...args: Parameters<typeof actual.submitBatchItems>) => submitBatchItemsMock(...args),
  }
})

vi.mock('@/composables/useAddTaskFileOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useAddTaskFileOps')>()
  return {
    ...actual,
    resolveUnresolvedItems: (...args: Parameters<typeof actual.resolveUnresolvedItems>) =>
      resolveUnresolvedItemsMock(...args),
  }
})

import { useAppStore } from '../app'
import { createBatchItem } from '@shared/utils/batchHelpers'

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    submitManualUrisMock.mockReset()
    submitManualUrisMock.mockResolvedValue({ submittedTaskNames: [], magnetGids: [], magnetFailures: [] })
    submitBatchItemsMock.mockReset()
    submitBatchItemsMock.mockResolvedValue(0)
    resolveUnresolvedItemsMock.mockClear()
  })

  it('keeps automatic prompting local to the task that captured it', () => {
    const store = useAppStore()

    store.queueMagnetSelection('prompt-gid', true)
    store.queueMagnetSelection('manual-gid', false)
    store.replacePendingMagnetSelections(['prompt-gid', 'manual-gid', 'restored-gid'])

    expect(store.pendingMagnetGids).toEqual(['prompt-gid', 'manual-gid', 'restored-gid'])
    expect(store.automaticMagnetPromptGids).toEqual(['prompt-gid'])

    store.disableAutomaticMagnetPrompt('prompt-gid')

    expect(store.pendingMagnetGids).toEqual(['prompt-gid', 'manual-gid', 'restored-gid'])
    expect(store.automaticMagnetPromptGids).toEqual([])

    store.clearMagnetSelections(['prompt-gid'])

    expect(store.pendingMagnetGids).toEqual(['manual-gid', 'restored-gid'])
  })

  // ── enqueueBatch ────────────────────────────────────────────────

  it('enqueueBatch deduplicates against items already in pendingBatch', () => {
    const store = useAppStore()

    store.pendingBatch = [createBatchItem('uri', 'magnet:?xt=urn:btih:existing')]

    const skipped = store.enqueueBatch([
      createBatchItem('uri', 'magnet:?xt=urn:btih:existing'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:new'),
    ])

    expect(skipped).toBe(1)
    expect(store.pendingBatch.map((i) => i.source)).toEqual(['magnet:?xt=urn:btih:existing', 'magnet:?xt=urn:btih:new'])
  })

  it('enqueueBatch deduplicates duplicates within the same incoming batch', () => {
    const store = useAppStore()

    const skipped = store.enqueueBatch([
      createBatchItem('uri', 'magnet:?xt=urn:btih:dup'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:dup'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:other'),
    ])

    expect(skipped).toBe(1)
    expect(store.pendingBatch.map((i) => i.source)).toEqual(['magnet:?xt=urn:btih:dup', 'magnet:?xt=urn:btih:other'])
  })

  it('enqueueBatch returns 0 and opens dialog when given empty array', () => {
    const store = useAppStore()
    const skipped = store.enqueueBatch([])
    expect(skipped).toBe(0)
    expect(store.pendingBatch).toEqual([])
  })

  it('enqueueBatch opens addTaskDialog on non-empty input', () => {
    const store = useAppStore()
    expect(store.addTaskVisible).toBe(false)
    store.enqueueBatch([createBatchItem('uri', 'https://example.com/file')])
    expect(store.addTaskVisible).toBe(true)
  })

  // ── Interval Management ─────────────────────────────────────────

  describe('interval management', () => {
    it('updateInterval sets interval within bounds', () => {
      const store = useAppStore()
      store.updateInterval(2000)
      expect(store.interval).toBe(2000)
    })

    it('updateInterval clamps to STAT_MAX_INTERVAL', () => {
      const store = useAppStore()
      store.updateInterval(99999)
      expect(store.interval).toBe(STAT_MAX_INTERVAL)
    })

    it('updateInterval clamps to STAT_MIN_INTERVAL', () => {
      const store = useAppStore()
      store.updateInterval(1)
      expect(store.interval).toBe(STAT_MIN_INTERVAL)
    })

    it('updateInterval no-ops when value equals current', () => {
      const store = useAppStore()
      store.interval = 2000
      store.updateInterval(2000)
      expect(store.interval).toBe(2000)
    })

    it('increaseInterval increments by 100ms by default', () => {
      const store = useAppStore()
      const before = store.interval
      store.increaseInterval()
      expect(store.interval).toBe(before + 100)
    })

    it('increaseInterval does not exceed STAT_MAX_INTERVAL', () => {
      const store = useAppStore()
      store.interval = STAT_MAX_INTERVAL
      store.increaseInterval()
      expect(store.interval).toBe(STAT_MAX_INTERVAL)
    })
  })

  // ── Dialog State ────────────────────────────────────────────────

  describe('dialog state', () => {
    it('showAddTaskDialog sets addTaskVisible to true', () => {
      const store = useAppStore()
      expect(store.addTaskVisible).toBe(false)
      store.showAddTaskDialog()
      expect(store.addTaskVisible).toBe(true)
    })

    it('showAddTaskDialog clears stale external browser context before manual entry', () => {
      const store = useAppStore()
      store.pendingReferer = 'https://old.example/page'
      store.pendingCookie = 'sid=old'
      store.pendingFilename = 'old.zip'
      store.pendingUserAgent = 'OldUA/1.0'
      store.pendingRequestHeaders = [{ name: 'Accept', value: 'application/octet-stream' }]

      store.showAddTaskDialog()

      expect(store.addTaskVisible).toBe(true)
      expect(store.pendingReferer).toBe('')
      expect(store.pendingCookie).toBe('')
      expect(store.pendingFilename).toBe('')
      expect(store.pendingUserAgent).toBe('')
      expect(store.pendingRequestHeaders).toEqual([])
    })

    it('hideAddTaskDialog sets addTaskVisible to false and clears pendingBatch', () => {
      const store = useAppStore()
      store.addTaskVisible = true
      store.pendingBatch = [createBatchItem('uri', 'https://example.com')]
      store.hideAddTaskDialog()
      expect(store.addTaskVisible).toBe(false)
      expect(store.pendingBatch).toEqual([])
    })
  })

  // ── updateAddTaskOptions ────────────────────────────────────────

  describe('updateAddTaskOptions', () => {
    it('replaces addTaskOptions with provided options', () => {
      const store = useAppStore()
      store.updateAddTaskOptions({ dir: '/tmp/downloads', 'stream-max-connections': '4' } as never)
      expect(store.addTaskOptions).toEqual({ dir: '/tmp/downloads', 'stream-max-connections': '4' })
    })

    it('defaults to empty object when called with no arguments', () => {
      const store = useAppStore()
      store.addTaskOptions = { dir: '/old' } as never
      store.updateAddTaskOptions()
      expect(store.addTaskOptions).toEqual({})
    })
  })

  // ── handleStatEvent (Rust event → reactive state) ───────────────

  describe('handleStatEvent', () => {
    it('updates stat values from event payload', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 204800,
        uploadSpeed: 10240,
        numActive: 2,
        numWaiting: 1,
        numStopped: 5,
        numStoppedTotal: 10,
      })
      expect(store.stat.downloadSpeed).toBe(204800)
      expect(store.stat.uploadSpeed).toBe(10240)
      expect(store.stat.numActive).toBe(2)
      expect(store.stat.numWaiting).toBe(1)
      expect(store.stat.numStopped).toBe(5)
    })

    it('decreases interval when active tasks are present', () => {
      const store = useAppStore()
      store.interval = STAT_BASE_INTERVAL
      store.handleStatEvent({
        downloadSpeed: 1000,
        uploadSpeed: 0,
        numActive: 3,
        numWaiting: 0,
        numStopped: 0,
        numStoppedTotal: 0,
      })
      expect(store.interval).toBeLessThanOrEqual(STAT_BASE_INTERVAL)
    })

    it('increases interval when idle (numActive = 0)', () => {
      const store = useAppStore()
      const before = store.interval
      store.handleStatEvent({
        downloadSpeed: 0,
        uploadSpeed: 0,
        numActive: 0,
        numWaiting: 0,
        numStopped: 3,
        numStoppedTotal: 5,
      })
      expect(store.interval).toBeGreaterThanOrEqual(before)
    })

    it('preserves the authoritative engine speed payload', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 999,
        uploadSpeed: 100,
        numActive: 0,
        numWaiting: 0,
        numStopped: 1,
        numStoppedTotal: 1,
      })
      expect(store.stat.downloadSpeed).toBe(999)
      expect(store.stat.uploadSpeed).toBe(100)
    })

    it('preserves downloadSpeed when tasks are active', () => {
      const store = useAppStore()
      store.handleStatEvent({
        downloadSpeed: 512000,
        uploadSpeed: 0,
        numActive: 1,
        numWaiting: 0,
        numStopped: 0,
        numStoppedTotal: 0,
      })
      expect(store.stat.downloadSpeed).toBe(512000)
    })
  })

  // ── handleDeepLinkUrls ──────────────────────────────────────────

  describe('handleDeepLinkUrls', () => {
    beforeEach(async () => {
      const { usePreferenceStore } = await import('@/stores/preference')
      usePreferenceStore().config.autoSubmitFromExtension = false
    })

    it('treats remote .torrent URLs as torrent tasks', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['https://example.com/linux.torrent'])
      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: 'https://example.com/linux.torrent' },
      ])
    })

    it('keeps local file:// torrent references as file items', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['file:///Users/test/Downloads/a.torrent'])
      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: '/Users/test/Downloads/a.torrent' },
      ])
    })

    it('normalizes Windows file URIs without leaving a leading slash before the drive letter', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['file:///C:/Users/test/Downloads/Space%20Name.torrent'])

      expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
        { kind: 'torrent', source: 'C:/Users/test/Downloads/Space Name.torrent' },
      ])
    })

    it('handles magnet links', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls(['magnet:?xt=urn:btih:abc123'])
      expect(store.pendingBatch[0].kind).toBe('uri')
      expect(store.pendingBatch[0].source).toBe('magnet:?xt=urn:btih:abc123')
    })

    it('handles ED2K file links as URI tasks', () => {
      const store = useAppStore()
      const url = 'ed2k://|file|Ubuntu%2026.04.iso|123456789|0123456789abcdef0123456789abcdef|/'
      store.handleDeepLinkUrls([url])
      expect(store.pendingBatch[0].kind).toBe('uri')
      expect(store.pendingBatch[0].source).toBe(url)
      expect(store.pendingBatch[0].displayName).toBe(url)
    })

    it('no-ops for empty or null-ish input', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([])
      expect(store.pendingBatch).toEqual([])
    })

    it('handles mixed protocol URLs', () => {
      const store = useAppStore()
      store.handleDeepLinkUrls([
        'https://example.com/file.zip',
        'magnet:?xt=urn:btih:hash',
        'file:///local/path.torrent',
      ])
      expect(store.pendingBatch).toHaveLength(3)
    })

    it('extracts referer from motrixnext://new deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.example.com/file.zip')
      const referer = encodeURIComponent('https://example.com/downloads')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.example.com/file.zip')
      expect(store.pendingReferer).toBe('https://example.com/downloads')
    })

    it('handles single-slash motrixnext new deep links', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext:/new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.example.com/file.zip')
      expect(store.addTaskVisible).toBe(true)
    })

    it('sets pendingReferer to empty when deep link has no referer param', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingReferer).toBe('')
    })

    it('uses last referer when multiple deep links arrive', () => {
      const store = useAppStore()
      const url1 = encodeURIComponent('https://cdn.example.com/a.zip')
      const ref1 = encodeURIComponent('https://site-a.com')
      const url2 = encodeURIComponent('https://cdn.example.com/b.zip')
      const ref2 = encodeURIComponent('https://site-b.com')
      store.handleDeepLinkUrls([
        `motrixnext://new?url=${url1}&referer=${ref1}`,
        `motrixnext://new?url=${url2}&referer=${ref2}`,
      ])

      expect(store.pendingBatch).toHaveLength(2)
      expect(store.pendingReferer).toBe('https://site-b.com')
    })

    it('clears pendingReferer when hideAddTaskDialog is called', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      const referer = encodeURIComponent('https://example.com')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}`])
      expect(store.pendingReferer).toBe('https://example.com')

      store.hideAddTaskDialog()
      expect(store.pendingReferer).toBe('')
    })

    // ── Cookie extraction (mirrors referer tests above) ────────────

    it('extracts cookie from motrixnext://new deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/file.zip')
      const cookie = encodeURIComponent('session=abc123; token=xyz')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&cookie=${cookie}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.quark.cn/file.zip')
      expect(store.pendingCookie).toBe('session=abc123; token=xyz')
    })

    it('sets pendingCookie to empty when deep link has no cookie param', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingCookie).toBe('')
    })

    it('uses last cookie when multiple deep links arrive', () => {
      const store = useAppStore()
      const url1 = encodeURIComponent('https://cdn.a.com/file.zip')
      const c1 = encodeURIComponent('sid=aaa')
      const url2 = encodeURIComponent('https://cdn.b.com/file.zip')
      const c2 = encodeURIComponent('sid=bbb')
      store.handleDeepLinkUrls([
        `motrixnext://new?url=${url1}&cookie=${c1}`,
        `motrixnext://new?url=${url2}&cookie=${c2}`,
      ])

      expect(store.pendingBatch).toHaveLength(2)
      expect(store.pendingCookie).toBe('sid=bbb')
    })

    it('clears pendingCookie when hideAddTaskDialog is called', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      const cookie = encodeURIComponent('auth=secret')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&cookie=${cookie}`])
      expect(store.pendingCookie).toBe('auth=secret')

      store.hideAddTaskDialog()
      expect(store.pendingCookie).toBe('')
    })

    it('extracts both referer and cookie from same deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/file.zip')
      const referer = encodeURIComponent('https://pan.quark.cn')
      const cookie = encodeURIComponent('__puus=abc; __pus=def')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}&cookie=${cookie}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingReferer).toBe('https://pan.quark.cn')
      expect(store.pendingCookie).toBe('__puus=abc; __pus=def')
    })

    // ── Filename extraction (mirrors referer/cookie tests above) ────

    it('extracts filename from motrixnext://new deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/hash123')
      const filename = encodeURIComponent('ghost-sample-v0.1.xmgic')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&filename=${filename}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].source).toBe('https://cdn.quark.cn/hash123')
      expect(store.pendingFilename).toBe('ghost-sample-v0.1.xmgic')
    })

    it('sets pendingFilename to empty when deep link has no filename param', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://example.com/file.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingFilename).toBe('')
    })

    it('clears stale external metadata when the next deep link omits it', () => {
      const store = useAppStore()
      const firstUrl = encodeURIComponent('https://cdn.quark.cn/hash123')
      const firstReferer = encodeURIComponent('https://pan.quark.cn')
      const firstCookie = encodeURIComponent('__puus=abc')
      const firstFilename = encodeURIComponent('first.zip')
      store.handleDeepLinkUrls([
        `motrixnext://new?url=${firstUrl}&referer=${firstReferer}&cookie=${firstCookie}&filename=${firstFilename}`,
      ])
      expect(store.pendingReferer).toBe('https://pan.quark.cn')
      expect(store.pendingCookie).toBe('__puus=abc')
      expect(store.pendingFilename).toBe('first.zip')

      const secondUrl = encodeURIComponent('https://example.com/second.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${secondUrl}`])

      expect(store.pendingReferer).toBe('')
      expect(store.pendingCookie).toBe('')
      expect(store.pendingFilename).toBe('')
    })

    it('clears pendingFilename when hideAddTaskDialog is called', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/hash123')
      const filename = encodeURIComponent('test.zip')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&filename=${filename}`])
      expect(store.pendingFilename).toBe('test.zip')

      store.hideAddTaskDialog()
      expect(store.pendingFilename).toBe('')
    })

    it('extracts filename together with referer and cookie', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://cdn.quark.cn/hash123')
      const referer = encodeURIComponent('https://pan.quark.cn')
      const cookie = encodeURIComponent('__puus=abc')
      const filename = encodeURIComponent('ghost-sample-v0.1.xmgic')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&referer=${referer}&cookie=${cookie}&filename=${filename}`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingReferer).toBe('https://pan.quark.cn')
      expect(store.pendingCookie).toBe('__puus=abc')
      expect(store.pendingFilename).toBe('ghost-sample-v0.1.xmgic')
    })

    it('ignores generic browser fallback filename from extension deep link', () => {
      const store = useAppStore()
      const url = encodeURIComponent('https://mail-attachment.googleusercontent.com/attachment/u/0/')
      store.handleDeepLinkUrls([`motrixnext://new?url=${url}&filename=download`])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingFilename).toBe('')
      expect(store.pendingBatch[0].displayName).not.toBe('download')
    })
  })

  // ── autoSubmitFromExtension ───────────────────────────────────────

  describe('autoSubmitFromExtension', () => {
    beforeEach(async () => {
      const { usePreferenceStore } = await import('@/stores/preference')
      usePreferenceStore().recordHistoryDirectory = vi.fn()
    })

    // Helper: build a motrixnext://new deep link
    function buildDeepLink(downloadUrl: string, referer = '', cookie = '', filename = ''): string {
      const u = encodeURIComponent(downloadUrl)
      const r = referer ? `&referer=${encodeURIComponent(referer)}` : ''
      const c = cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''
      const f = filename ? `&filename=${encodeURIComponent(filename)}` : ''
      return `motrixnext://new?url=${u}${r}${c}${f}`
    }

    it('auto-submits HTTP URI when enabled', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true
      const onStart = vi.fn()
      store.setExternalInputStartHandler(onStart)
      submitManualUrisMock.mockResolvedValueOnce({
        submittedTaskNames: ['file.zip'],
        magnetGids: [],
        magnetFailures: [],
      })

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/file.zip')])
      await new Promise((resolve) => setTimeout(resolve, 0))

      // Auto-submitted: pendingBatch should be empty, dialog should NOT open
      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
      expect(onStart).toHaveBeenCalledWith(['file.zip'])
    })

    it('auto-submits magnet URI when enabled', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('magnet:?xt=urn:btih:abc123')])

      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
    })

    it('auto-submits ED2K URI when enabled', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([
        buildDeepLink('ed2k://|file|Ubuntu%2026.04.iso|123456789|0123456789abcdef0123456789abcdef|/'),
      ])

      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
    })

    it('falls back to AddTask dialog when disabled', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = false

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/file.zip')])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.addTaskVisible).toBe(true)
    })

    it('shows AddTask for remote .torrent URLs', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/linux.torrent')])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].kind).toBe('torrent')
      expect(store.addTaskVisible).toBe(true)
      expect(submitManualUrisMock).not.toHaveBeenCalled()
      expect(resolveUnresolvedItemsMock).not.toHaveBeenCalled()
      expect(submitBatchItemsMock).not.toHaveBeenCalled()
    })

    it('auto-submits magnet URLs without bypassing file selection', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('magnet:?xt=urn:btih:abc123')])
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(submitManualUrisMock).toHaveBeenCalledTimes(1)
      expect(store.addTaskVisible).toBe(false)
    })

    it('handles mixed batch: auto-submits URIs, dialogs torrent', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([
        buildDeepLink('https://example.com/file.zip'),
        buildDeepLink('https://example.com/linux.torrent'),
      ])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].kind).toBe('torrent')
      expect(store.addTaskVisible).toBe(true)
      expect(submitManualUrisMock).toHaveBeenCalledTimes(1)
    })

    it('does not open dialog when all items are auto-submitted', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/a.zip'), buildDeepLink('https://example.com/b.mp4')])

      expect(store.pendingBatch).toHaveLength(0)
      expect(store.addTaskVisible).toBe(false)
    })

    it('passes referer through auto-submit without retaining pending metadata', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://example.com/file.zip', 'https://example.com')])

      const submittedForm = submitManualUrisMock.mock.calls[0][0]
      expect(submittedForm.referer).toBe('https://example.com')
      expect(store.pendingReferer).toBe('')
    })

    it('passes cookie through auto-submit without retaining pending metadata', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      store.handleDeepLinkUrls([buildDeepLink('https://cdn.quark.cn/file.zip', 'https://pan.quark.cn', 'auth=secret')])

      const submittedForm = submitManualUrisMock.mock.calls[0][0]
      expect(submittedForm.cookie).toBe('auth=secret')
      expect(store.pendingCookie).toBe('')
    })

    it('auto-submits structured extension input with captured user agent and request headers', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true
      prefStore.config.userAgent = 'ConfiguredUA/1.0'

      store.handleExternalInputs([
        {
          url: 'https://drivers.amd.com/file.exe',
          finalUrl: 'https://drivers.amd.com/file.exe',
          referer: 'https://www.amd.com/support',
          cookie: 'auth=secret',
          userAgent: 'BrowserUA/1.0',
          requestHeaders: [{ name: 'Accept', value: 'application/octet-stream' }],
          filename: 'driver.exe',
          source: 'http-api',
        },
      ])
      await new Promise((resolve) => setTimeout(resolve, 0))

      const submittedForm = submitManualUrisMock.mock.calls[0][0]
      expect(submittedForm.userAgent).toBe('BrowserUA/1.0')
      expect(submittedForm.referer).toBe('https://www.amd.com/support')
      expect(submittedForm.cookie).toBe('auth=secret')
      expect(submittedForm.requestHeaders).toEqual([{ name: 'Accept', value: 'application/octet-stream' }])
    })

    it('falls back to configured user agent when structured input has none', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true
      prefStore.config.userAgent = 'ConfiguredUA/1.0'

      store.handleExternalInputs([
        {
          url: 'https://example.com/file.zip',
          source: 'http-api',
        },
      ])
      await new Promise((resolve) => setTimeout(resolve, 0))

      const submittedForm = submitManualUrisMock.mock.calls[0][0]
      expect(submittedForm.userAgent).toBe('ConfiguredUA/1.0')
    })

    it('keeps structured request headers for manual dialog submission', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = false

      store.handleExternalInputs([
        {
          url: 'https://example.com/file.zip',
          userAgent: 'BrowserUA/1.0',
          requestHeaders: [{ name: 'Accept-Language', value: 'en-US,en;q=0.9' }],
          source: 'http-api',
        },
      ])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.pendingBatch[0].browserContext).toMatchObject({
        userAgent: 'BrowserUA/1.0',
        requestHeaders: [{ name: 'Accept-Language', value: 'en-US,en;q=0.9' }],
      })
      expect(store.pendingUserAgent).toBe('BrowserUA/1.0')
      expect(store.pendingRequestHeaders).toEqual([{ name: 'Accept-Language', value: 'en-US,en;q=0.9' }])
    })

    it('non-extension deep links (file://, http://) are unaffected by auto-submit', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true

      // Regular deep links (not motrixnext://) should always go to dialog
      store.handleDeepLinkUrls(['https://example.com/file.zip'])

      expect(store.pendingBatch).toHaveLength(1)
      expect(store.addTaskVisible).toBe(true)
    })

    it('reports readable auto-submit errors for structured Tauri failures', async () => {
      const store = useAppStore()
      const { usePreferenceStore } = await import('@/stores/preference')
      const prefStore = usePreferenceStore()
      prefStore.config.autoSubmitFromExtension = true
      const onError = vi.fn()
      submitManualUrisMock.mockRejectedValueOnce({ Aria2: 'aria2 RPC error [1]: Unsupported URI scheme' })

      store.setExternalInputErrorHandler(onError)
      store.handleDeepLinkUrls([buildDeepLink('23222233')])
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(onError).toHaveBeenCalledWith({ Aria2: 'aria2 RPC error [1]: Unsupported URI scheme' })
    })
  })
})
