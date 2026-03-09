/** @fileoverview Task metadata operations: naming, progress, BT detection, magnet links. */
import { difference, parseInt } from 'lodash-es'
import type { Aria2Task, Aria2File } from '@shared/types'

/** Calculates download progress as a percentage. */
export const calcProgress = (totalLength: string | number, completedLength: string | number, decimal = 2): number => {
  const total = parseInt(String(totalLength), 10)
  const completed = parseInt(String(completedLength), 10)
  if (total === 0 || completed === 0) return 0
  const percentage = (completed / total) * 100
  return parseFloat(percentage.toFixed(decimal))
}

/** Calculates upload-to-download ratio for seeding tasks. */
export const calcRatio = (totalLength: string | number, uploadLength: string | number): number => {
  const total = parseInt(String(totalLength), 10)
  const upload = parseInt(String(uploadLength), 10)
  if (total === 0 || upload === 0) return 0
  const percentage = upload / total
  return parseFloat(percentage.toFixed(4))
}

const getFileNameFromFile = (file?: Aria2File): string => {
  if (!file) return ''
  let { path } = file
  if (!path && file.uris && file.uris.length > 0) {
    path = decodeURI(file.uris[0]?.uri || '')
  }
  if (!path) return ''
  const index = path.lastIndexOf('/')
  if (index <= 0 || index === path.length) return path
  return path.substring(index + 1)
}

/** Resolves a human-readable task name from BT info or file path. */
export const getTaskName = (task: Aria2Task | null, options: { defaultName?: string } = {}): string => {
  const { defaultName = '' } = options
  let result = defaultName
  if (!task) return result

  const { files, bittorrent } = task
  if (!files || files.length === 0) return result

  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = bittorrent.info.name
  } else if (files.length === 1) {
    const name = getFileNameFromFile(files[0])
    result = name || result
  } else {
    // Multi-file HTTP/Metalink: use first non-empty filename
    const firstName = files.map((f) => getFileNameFromFile(f)).find((n) => !!n)
    result = firstName || result
  }

  return result
}

/** Returns true if the task is a magnet link still resolving metadata. */
export const isMagnetTask = (task: Aria2Task): boolean => {
  const { bittorrent } = task
  return !!bittorrent && !bittorrent.info
}

/** Returns true if the task is actively seeding (BT upload-only). */
export const checkTaskIsSeeder = (task: Aria2Task): boolean => {
  const { bittorrent, seeder } = task
  return !!bittorrent && seeder === 'true'
}

/** Returns true if the task is a BitTorrent download (has bittorrent metadata). */
export const checkTaskIsBT = (task: Partial<Aria2Task> = {} as Partial<Aria2Task>): boolean => {
  return !!task.bittorrent
}

/** Builds a magnet link from a BT task, optionally including tracker URLs. */
export const buildMagnetLink = (task: Aria2Task, withTracker = false, btTracker: string[] = []): string => {
  const { bittorrent, infoHash } = task
  const info = bittorrent?.info

  const params = [`magnet:?xt=urn:btih:${infoHash}`]
  if (info && info.name) {
    params.push(`dn=${encodeURIComponent(info.name)}`)
  }

  if (withTracker && bittorrent?.announceList) {
    const trackers = difference(bittorrent.announceList, btTracker)
    trackers.forEach((tracker) => {
      params.push(`tr=${encodeURIComponent(tracker)}`)
    })
  }

  return params.join('&')
}

/**
 * Collects all download URIs from a task.
 * For BT tasks, returns this magnet link.
 * For HTTP/FTP tasks, iterates all files and extracts their URIs.
 */
export const getTaskUris = (task: Aria2Task, withTracker = false): string[] => {
  if (checkTaskIsBT(task)) {
    const magnet = buildMagnetLink(task, withTracker)
    return magnet ? [magnet] : []
  }
  const { files } = task
  if (!files || files.length === 0) return []
  const uris: string[] = []
  for (const file of files) {
    if (file.uris && file.uris.length > 0) {
      uris.push(file.uris[0].uri)
    }
  }
  return uris
}

/** Returns the primary download URI or magnet link for a task. */
export const getTaskUri = (task: Aria2Task, withTracker = false): string => {
  const uris = getTaskUris(task, withTracker)
  return uris.length > 0 ? uris[0] : ''
}

export const checkTaskTitleIsEmpty = (task: Aria2Task): boolean => {
  const { files, bittorrent } = task
  const [file] = files
  const { path } = file
  let result = path
  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = bittorrent.info.name
  }
  return result === ''
}

export const mergeTaskResult = (response: unknown[][] = []): unknown[] => {
  let result: unknown[] = []
  for (const res of response) {
    result = result.concat(...res)
  }
  return result
}

export { getFileNameFromFile }
