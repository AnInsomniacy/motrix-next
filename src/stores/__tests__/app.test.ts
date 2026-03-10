import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../app'
import { createBatchItem, resetBatchIdCounter } from '@shared/utils/batchHelpers'
import { normalizeError } from '@shared/errorNormalizer'

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
  })

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

  it('handleDeepLinkUrls keeps remote .torrent and .metalink URLs as uri items', () => {
    const store = useAppStore()

    store.handleDeepLinkUrls([
      'https://example.com/linux.torrent',
      'https://example.com/bundle.meta4',
      'ftp://example.com/archive.metalink',
    ])

    expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
      { kind: 'uri', source: 'https://example.com/linux.torrent' },
      { kind: 'uri', source: 'https://example.com/bundle.meta4' },
      { kind: 'uri', source: 'ftp://example.com/archive.metalink' },
    ])
  })

  it('handleDeepLinkUrls keeps local file:// torrent and metalink references as file items', () => {
    const store = useAppStore()

    store.handleDeepLinkUrls(['file:///Users/test/Downloads/a.torrent', 'file:///Users/test/Downloads/b.meta4'])

    expect(store.pendingBatch.map((i) => ({ kind: i.kind, source: i.source }))).toEqual([
      { kind: 'torrent', source: '/Users/test/Downloads/a.torrent' },
      { kind: 'metalink', source: '/Users/test/Downloads/b.meta4' },
    ])
  })

  it('startupErrors initialises as empty array', () => {
    const store = useAppStore()
    expect(store.startupErrors).toEqual([])
  })

  it('startupErrors can accumulate NormalizedError entries', () => {
    const store = useAppStore()
    const err1 = normalizeError('engine failed', 'engine')
    const err2 = normalizeError('engine not ready after retries', 'engine')

    store.startupErrors.push(err1)
    store.startupErrors.push(err2)

    expect(store.startupErrors).toHaveLength(2)
    expect(store.startupErrors[0].category).toBe('engine')
    expect(store.startupErrors[0].rawMessage).toBe('engine failed')
    expect(store.startupErrors[1].rawMessage).toBe('engine not ready after retries')
  })

  it('startupErrors can be drained (cleared)', () => {
    const store = useAppStore()
    store.startupErrors.push(normalizeError('test error', 'engine'))
    expect(store.startupErrors).toHaveLength(1)

    store.startupErrors = []
    expect(store.startupErrors).toEqual([])
  })
})
