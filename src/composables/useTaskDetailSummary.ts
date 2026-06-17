/** @fileoverview Type-aware task detail summaries for the drawer UI. */
import type { Aria2Task, Aria2File, Aria2Peer } from '@shared/types'

export type TaskDetailKind = 'uri' | 'bt' | 'ed2k'

export interface UriSourceGroup {
  url: string
  segmentCount: number
  status: 'used' | 'waiting' | '-'
}

export interface UriDetailSummary {
  primaryUri: string
  fileCount: number
  selectedFileCount: number
  mirrorCount: number
  uniqueSourceCount: number
  usedMirrorCount: number
  waitingMirrorCount: number
  sourceGroups: UriSourceGroup[]
}

type BtMetadataState = 'downloading' | 'ready' | 'unknown'

export interface BtHealthSummary {
  metadataState: BtMetadataState
  hasMetadata: boolean
  trackerCount: number
  unprobeableTrackerCount: number
  peerCount: number
  seederPeerCount: number
  activeDownloadPeerCount: number
  activeUploadPeerCount: number
  amChokingCount: number
  peerChokingCount: number
  selectedFileCount: number
  totalFileCount: number
  selectedLength: number
}

export interface Ed2kDetailSummary {
  serverCount: number
  connectedServerCount: number
  peerCount: number
  acceptedPeerCount: number
  queuedPeerCount: number
  deadPeerCount: number
  lowIdPeerCount: number
  callbackWaitingPeerCount: number
  kadNodeCount: number
  kadRouterCount: number
  kadFirewalled: boolean | undefined
  hasSearchState: boolean
  uploadingPeerCount: number
  waitingUploadPeerCount: number
}

export interface TaskTransferSummary {
  showUploadMetrics: boolean
  showSeeders: boolean
  ratio: number
}

export function buildTaskDetailKind(task: Aria2Task | null | undefined): TaskDetailKind {
  if (task?.bittorrent) return 'bt'
  if (task?.ed2k) return 'ed2k'
  return 'uri'
}

function toPositiveInt(value: string | number | boolean | undefined): number {
  if (typeof value === 'boolean') return Number(value)
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function selectedFiles(files: Aria2File[]): Aria2File[] {
  return files.filter((file) => file.selected === 'true')
}

function fileLength(file: Aria2File): number {
  return toPositiveInt(file.length)
}

function isUnprobeableTracker(url: string): boolean {
  return /^(?:udp|ws|wss):\/\//i.test(url)
}

function hasSpeed(value: string | undefined): boolean {
  return toPositiveInt(value) > 0
}

function normalizeBtMetadataState(task: Aria2Task | null | undefined, hasMetadata: boolean): BtMetadataState {
  if (hasMetadata) return 'ready'
  if (task?.bittorrent && !task.following) return 'downloading'
  return 'unknown'
}

export function buildUriDetailSummary(task: Aria2Task | null | undefined): UriDetailSummary {
  const files = task?.files ?? []
  const uris = files.flatMap((file) => file.uris ?? [])

  // Group URIs by URL to show per-source segment distribution
  const groupMap = new Map<string, { count: number; hasUsed: boolean; hasWaiting: boolean }>()
  for (const u of uris) {
    const existing = groupMap.get(u.uri)
    if (existing) {
      existing.count++
      if (u.status === 'used') existing.hasUsed = true
      if (u.status === 'waiting') existing.hasWaiting = true
    } else {
      groupMap.set(u.uri, { count: 1, hasUsed: u.status === 'used', hasWaiting: u.status === 'waiting' })
    }
  }
  const sourceGroups: UriSourceGroup[] = [...groupMap.entries()]
    .map(([url, g]) => ({
      url,
      segmentCount: g.count,
      status: (g.hasUsed ? 'used' : g.hasWaiting ? 'waiting' : '-') as UriSourceGroup['status'],
    }))
    .sort((a, b) => b.segmentCount - a.segmentCount)

  return {
    primaryUri: uris[0]?.uri ?? '',
    fileCount: files.length,
    selectedFileCount: selectedFiles(files).length,
    mirrorCount: uris.length,
    uniqueSourceCount: groupMap.size,
    usedMirrorCount: uris.filter((uri) => uri.status === 'used').length,
    waitingMirrorCount: uris.filter((uri) => uri.status === 'waiting').length,
    sourceGroups,
  }
}

export function buildBtHealthSummary(task: Aria2Task | null | undefined): BtHealthSummary {
  const files = task?.files ?? []
  const selected = selectedFiles(files)
  const trackers = task?.bittorrent?.announceList?.flat() ?? []
  const peers = task?.peers ?? []
  const hasMetadata = Boolean(task?.bittorrent?.info)

  return {
    metadataState: normalizeBtMetadataState(task, hasMetadata),
    hasMetadata,
    trackerCount: trackers.length,
    unprobeableTrackerCount: trackers.filter(isUnprobeableTracker).length,
    peerCount: peers.length,
    seederPeerCount: peers.filter((peer: Aria2Peer) => peer.seeder === 'true').length,
    activeDownloadPeerCount: peers.filter((peer: Aria2Peer) => hasSpeed(peer.downloadSpeed)).length,
    activeUploadPeerCount: peers.filter((peer: Aria2Peer) => hasSpeed(peer.uploadSpeed)).length,
    amChokingCount: peers.filter((peer: Aria2Peer) => peer.amChoking === 'true').length,
    peerChokingCount: peers.filter((peer: Aria2Peer) => peer.peerChoking === 'true').length,
    selectedFileCount: selected.length,
    totalFileCount: files.length,
    selectedLength: selected.reduce((sum, file) => sum + fileLength(file), 0),
  }
}

export function buildEd2kDetailSummary(task: Aria2Task | null | undefined): Ed2kDetailSummary {
  const ed2k = task?.ed2k
  return {
    serverCount: toPositiveInt(ed2k?.serverCount),
    connectedServerCount: toPositiveInt(ed2k?.connectedServerCount),
    peerCount: toPositiveInt(ed2k?.peerCount),
    acceptedPeerCount: toPositiveInt(ed2k?.acceptedPeerCount),
    queuedPeerCount: toPositiveInt(ed2k?.queuedPeerCount),
    deadPeerCount: toPositiveInt(ed2k?.deadPeerCount),
    lowIdPeerCount: toPositiveInt(ed2k?.lowIdPeerCount),
    callbackWaitingPeerCount: toPositiveInt(ed2k?.callbackWaitingPeerCount),
    kadNodeCount: toPositiveInt(ed2k?.kadNodeCount),
    kadRouterCount: toPositiveInt(ed2k?.kadRouterCount),
    kadFirewalled: ed2k?.kadFirewalled,
    hasSearchState:
      ed2k?.searchActive === true || ed2k?.searchMoreResults === true || toPositiveInt(ed2k?.searchResultCount) > 0,
    uploadingPeerCount: toPositiveInt(ed2k?.uploadingPeerCount),
    waitingUploadPeerCount: toPositiveInt(ed2k?.waitingUploadPeerCount),
  }
}

export function buildTaskTransferSummary(task: Aria2Task | null | undefined): TaskTransferSummary {
  const kind = buildTaskDetailKind(task)
  const showUploadMetrics = kind === 'bt' || kind === 'ed2k'
  return {
    showUploadMetrics,
    showSeeders: kind === 'bt',
    ratio: showUploadMetrics && task ? toRatio(task.totalLength, task.uploadLength) : 0,
  }
}

function toRatio(totalLength: string | number | undefined, uploadLength: string | number | undefined): number {
  const total = toPositiveInt(totalLength)
  const upload = toPositiveInt(uploadLength)
  if (total === 0 || upload === 0) return 0
  return Number((upload / total).toFixed(4))
}
