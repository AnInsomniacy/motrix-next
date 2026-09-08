/** @fileoverview Pure row builders for heavy task detail tabs. */
import {
  bitfieldToPercent,
  bytesToSize,
  calcProgress,
  getFileExtension,
  getFileName,
  peerIdParser,
} from '@shared/utils'
import { decodePathSegment } from '@shared/utils/batchHelpers'
import type { Aria2File, Aria2Peer, Aria2Task, BtFilePriority } from '@shared/types'

export interface FileDetailRow {
  idx: number
  name: string
  extension: string
  length: number
  completedLength: number
  percent: number
  selected: boolean
  priority: BtFilePriority
}

export interface SourceDetailRow {
  key: string
  fileIndex: number
  uriIndex: number
  uri: string
  status: string
}

export interface PeerDetailRow {
  index: number
  host: string
  ip: string
  client: string
  connection: string
  percent: string
  uploadSpeed: string
  downloadSpeed: string
  amChoking: boolean
  peerChoking: boolean
  seeder: boolean
}

export function buildFileDetailRows(files: Aria2File[]): FileDetailRow[] {
  return files.map((item) => {
    const name = decodePathSegment(getFileName(item.path))
    const length = Number(item.length)
    const completedLength = Number(item.completedLength)
    return {
      idx: Number(item.index),
      name,
      extension: '.' + getFileExtension(name),
      length,
      completedLength,
      percent: calcProgress(item.length, item.completedLength, 1),
      selected: item.selected === 'true',
      priority: item.priority ?? (item.selected === 'true' ? 'normal' : 'off'),
    }
  })
}

export function buildSourceDetailRows(task: Aria2Task | null | undefined): SourceDetailRow[] {
  return (task?.files ?? []).flatMap((file) =>
    (file.uris ?? []).map((uri, uriIndex) => ({
      key: `${file.index}-${uriIndex}`,
      fileIndex: Number(file.index),
      uriIndex,
      uri: uri.uri,
      status: uri.status || '-',
    })),
  )
}

export function buildPeerDetailRows(peers: Aria2Peer[] | undefined): PeerDetailRow[] {
  return (peers ?? [])
    .map((peer) => ({
      host: `${peer.ip}:${peer.port}`,
      ip: peer.ip,
      client: peer.peerClientName || peerIdParser(peer.peerId ?? ''),
      connection: [peer.state, peer.transport, peer.encryption].filter(Boolean).join(' · '),
      percent: peer.bitfield
        ? bitfieldToPercent(peer.bitfield) + '%'
        : peer.progress
          ? `${Math.floor(Number(peer.progress) * 100)}%`
          : '-',
      uploadSpeed: bytesToSize(peer.uploadSpeed) + '/s',
      downloadSpeed: bytesToSize(peer.downloadSpeed) + '/s',
      amChoking: peer.amChoking === 'true',
      peerChoking: peer.peerChoking === 'true',
      seeder: peer.seeder === 'true',
    }))
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((row, index) => ({ ...row, index: index + 1 }))
}

export function sourceRowsSignature(task: Aria2Task | null | undefined): string {
  const files = task?.files ?? []
  const shape = files
    .map(
      (file) =>
        `${file.index}:${file.uris?.length ?? 0}:${(file.uris ?? []).map((uri) => uri.status || '-').join(',')}`,
    )
    .join(';')
  return `${task?.gid ?? ''}:${files.length}:${shape}`
}

export function peerRowsSignature(peers: Aria2Peer[] | undefined): string {
  return (peers ?? [])
    .map((peer) => `${peer.ip}:${peer.port}`)
    .sort()
    .join('|')
}
