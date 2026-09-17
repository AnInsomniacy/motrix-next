import { describe, expect, it } from 'vitest'
import type { Aria2Task } from '@shared/types'
import {
  buildBtHealthSummary,
  buildMediaDetailRows,
  buildEd2kDetailSummary,
  buildTaskDetailKind,
  buildTaskTransferSummary,
  buildUriDetailSummary,
  getTaskDetailStatusLabelKey,
} from '../useTaskDetailSummary'

function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'gid-1',
    status: 'active',
    totalLength: '1000',
    completedLength: '400',
    uploadLength: '0',
    downloadSpeed: '100',
    uploadSpeed: '0',
    connections: '2',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/file.zip',
        length: '1000',
        completedLength: '400',
        selected: 'true',
        uris: [{ uri: 'https://example.com/file.zip', status: 'used' }],
      },
    ],
    ...overrides,
  }
}

describe('buildTaskDetailKind', () => {
  it('classifies bittorrent tasks from RPC shape', () => {
    expect(buildTaskDetailKind(makeTask({ bittorrent: { info: { name: 'Ubuntu' } } }))).toBe('bt')
  })

  it('classifies ED2K tasks separately from generic URI tasks', () => {
    expect(buildTaskDetailKind(makeTask({ ed2k: { hash: 'abcd' } }))).toBe('ed2k')
  })

  it('classifies HTTP, SFTP, Thunder-decoded, and other URI tasks as uri when no protocol metadata exists', () => {
    expect(buildTaskDetailKind(makeTask())).toBe('uri')
  })
})

describe('getTaskDetailStatusLabelKey', () => {
  it.each([
    ['active', 'task.status-active'],
    ['waiting', 'task.status-waiting'],
    ['paused', 'task.status-paused'],
    ['complete', 'task.status-complete'],
    ['error', 'task.status-error'],
    ['removed', 'task.status-removed'],
    ['seeding', 'task.seeding'],
    ['sharing', 'task.sharing'],
    ['bt-metadata-fetching', 'task.bt-metadata-fetching'],
  ])('maps %s to %s', (status, expected) => {
    expect(getTaskDetailStatusLabelKey(status)).toBe(expected)
  })
})

describe('buildUriDetailSummary', () => {
  it('summarizes sources and does not expose bittorrent fields', () => {
    const summary = buildUriDetailSummary(
      makeTask({
        files: [
          {
            index: '1',
            path: '/downloads/file.zip',
            length: '1000',
            completedLength: '400',
            selected: 'true',
            uris: [
              { uri: 'https://mirror-a.example/file.zip', status: 'used' },
              { uri: 'https://mirror-b.example/file.zip', status: 'waiting' },
            ],
          },
        ],
      }),
    )

    expect(summary.primaryUri).toBe('https://mirror-a.example/file.zip')
    expect(summary.mirrorCount).toBe(2)
    expect(summary.fileCount).toBe(1)
    expect(summary.selectedFileCount).toBe(1)
  })
})

describe('buildBtHealthSummary', () => {
  it('summarizes BT metadata, trackers, peers, and selected files', () => {
    const summary = buildBtHealthSummary(
      makeTask({
        bittorrent: {
          info: { name: 'Torrent' },
          announceList: [['udp://tracker.example:6969/announce'], ['https://tracker.example/announce']],
        },
        infoHash: 'abc123',
        numSeeders: '8',
        peers: [
          {
            peerId: '-qB5000-abcdefghijkl',
            ip: '192.0.2.1',
            port: '6881',
            bitfield: 'ff',
            amChoking: 'false',
            peerChoking: 'true',
            downloadSpeed: '20',
            uploadSpeed: '0',
            seeder: 'false',
            state: 'connected',
            transport: 'tcp',
            encryption: 'plain',
            sources: ['tracker'],
            progress: '0.500000',
            flags: 'D',
            incoming: 'false',
            downloaded: '20',
            uploaded: '0',
            completedLength: '50',
          },
          {
            peerId: '-TR3000-abcdefghijkl',
            ip: '192.0.2.2',
            port: '6881',
            bitfield: 'ff',
            amChoking: 'true',
            peerChoking: 'false',
            downloadSpeed: '0',
            uploadSpeed: '10',
            seeder: 'true',
            state: 'connected',
            transport: 'utp',
            encryption: 'rc4',
            sources: ['dht'],
            progress: '1.000000',
            flags: 'U',
            incoming: 'true',
            downloaded: '0',
            uploaded: '10',
            completedLength: '100',
          },
        ],
        files: [
          {
            index: '1',
            path: '/downloads/a.bin',
            length: '100',
            completedLength: '50',
            selected: 'true',
            uris: [],
          },
          {
            index: '2',
            path: '/downloads/b.bin',
            length: '200',
            completedLength: '0',
            selected: 'false',
            uris: [],
          },
        ],
      }),
    )

    expect(summary.metadataState).toBe('ready')
    expect(summary.trackerCount).toBe(2)
    expect(summary.peerCount).toBe(2)
    expect(summary.activeDownloadPeerCount).toBe(1)
    expect(summary.activeUploadPeerCount).toBe(1)
    expect(summary.selectedFileCount).toBe(1)
    expect(summary.selectedLength).toBe(100)
  })

  it('marks unresolved native aria2 metadata tasks as downloading', () => {
    const summary = buildBtHealthSummary(
      makeTask({
        bittorrent: {
          announceList: [],
          state: 'downloadingMetadata',
        },
      }),
    )

    expect(summary.metadataState).toBe('downloading')
  })
})

describe('buildEd2kDetailSummary', () => {
  it('summarizes ED2K network state without bittorrent tracker concepts', () => {
    const summary = buildEd2kDetailSummary(
      makeTask({
        ed2k: {
          hash: 'ed2khash',
          serverCount: '4',
          connectedServerCount: '2',
          peerCount: '12',
          acceptedPeerCount: '5',
          queuedPeerCount: '3',
          lowIdPeerCount: '2',
          callbackWaitingPeerCount: '1',
          kadNodeCount: '30',
          kadFirewalled: true,
          uploadingPeerCount: '1',
          waitingUploadPeerCount: '2',
        },
      }),
    )

    expect(summary.connectedServerCount).toBe(2)
    expect(summary.serverCount).toBe(4)
    expect(summary.peerCount).toBe(12)
    expect(summary.lowIdPeerCount).toBe(2)
    expect(summary.callbackWaitingPeerCount).toBe(1)
    expect(summary.kadNodeCount).toBe(30)
    expect(summary.kadFirewalled).toBe(true)
  })
})

describe('buildTaskTransferSummary', () => {
  it('shows upload metrics for BT and ED2K tasks but not generic URI tasks', () => {
    const bt = buildTaskTransferSummary(
      makeTask({
        totalLength: '1000',
        uploadLength: '250',
        bittorrent: { info: { name: 'Torrent' } },
      }),
    )
    const ed2k = buildTaskTransferSummary(
      makeTask({
        totalLength: '1000',
        uploadLength: '500',
        ed2k: { hash: 'ed2khash' },
      }),
    )
    const uri = buildTaskTransferSummary(makeTask({ totalLength: '1000', uploadLength: '900' }))

    expect(bt.showUploadMetrics).toBe(true)
    expect(bt.showSeeders).toBe(true)
    expect(bt.ratio).toBe(0.25)
    expect(ed2k.showUploadMetrics).toBe(true)
    expect(ed2k.showSeeders).toBe(false)
    expect(ed2k.ratio).toBe(0.5)
    expect(uri.showUploadMetrics).toBe(false)
    expect(uri.showSeeders).toBe(false)
    expect(uri.ratio).toBe(0)
  })
})

describe('media overview integration', () => {
  const media = {
    state: 'downloading' as const,
    protocol: 'hls' as const,
    live: 'false' as const,
    duration: '60000',
    completedDuration: '10000',
    downloadedLength: '1024',
    lengthKnown: 'false' as const,
    error: '',
    tracks: [
      {
        id: '0:0',
        type: 'video' as const,
        language: '',
        codec: 'avc1',
        width: '640',
        height: '360',
        bandwidth: '1000000',
        selected: 'true' as const,
      },
    ],
  }
  it('does not repeat status, protocol or zero-value diagnostics before selection', () => {
    expect(buildMediaDetailRows(makeTask({ media: { ...media, state: 'awaiting-selection' } }), 'en-US')).toEqual([])
  })
  it('adds only media-specific rows to the existing overview', () => {
    const rows = buildMediaDetailRows(makeTask({ media }), 'en-US')
    expect(rows.map((row) => row.key)).toEqual(['video', 'duration', 'speed', 'received'])
    expect(rows.find((row) => row.key === 'duration')?.value).toBe('00:00:10 / 00:01:00')
    expect(rows.find((row) => row.key === 'video')?.value).toContain('640×360')
  })
  it('shows recorded duration without a fake total for paused live media', () => {
    const rows = buildMediaDetailRows(
      makeTask({ status: 'paused', media: { ...media, state: 'paused', live: 'true' } }),
      'en-US',
    )
    expect(rows.find((row) => row.key === 'duration')?.value).toBe('00:00:10')
    expect(rows.some((row) => row.key === 'speed')).toBe(false)
  })
})
