/**
 * @fileoverview File resolution and file-chooser operations for AddTask dialog.
 *
 * Extracted from AddTask.vue to reduce component script size.
 * Uses dependency injection for store access and i18n to enable testability.
 */
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'
import { inspectTorrent } from '@/api/aria2'
import { createBatchItem, detectExternalInputKind, detectKind } from '@shared/utils/batchHelpers'
import { sanitizeBrowserRequestHeaders, sanitizeHttpHeaderOptions } from '@shared/utils/headerSanitize'
import type { BatchItem } from '@shared/types'

interface FileOpsDeps {
  t: (key: string) => string
  batch: { value: BatchItem[] }
  fileItems: { value: BatchItem[] }
  selectedBatchIndex: { value: number }
  setPendingBatch: (items: BatchItem[]) => void
  showWarning: (msg: string) => void
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function getTorrentInspectionErrorKind(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const payload = (error as Record<string, unknown>).TorrentInspection
  if (typeof payload !== 'object' || payload === null) return ''
  const kind = (payload as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : ''
}

function getTorrentInspectionError(error: unknown, t: (key: string) => string): string {
  return getTorrentInspectionErrorKind(error) === 'torrentTooLarge'
    ? t('task.torrent-too-large')
    : t('task.error-bencode-parse')
}

async function inspectResolvedTorrent(item: BatchItem, t: (key: string) => string): Promise<void> {
  item.inspectionState = 'inspecting'
  item.error = undefined
  try {
    const inspection = await inspectTorrent({ torrent: item.payload })
    item.torrentMeta = inspection
    item.selectedFileIndices = inspection.files.map((file) => Number(file.index))
    item.inspectionState = 'ready'
    item.status = 'pending'
  } catch (error) {
    logger.error('AddTask.inspectTorrent', error)
    item.torrentMeta = undefined
    item.selectedFileIndices = undefined
    item.inspectionState = 'failed'
    item.status = 'failed'
    item.error = getTorrentInspectionError(error, t)
  }
}

/**
 * Resolves a single file-based batch item into base64 for native engine parsing.
 */
export async function resolveFileItem(item: BatchItem, t: (key: string) => string) {
  item.inspectionState = 'reading'
  item.error = undefined
  try {
    const bytes = await invoke<number[]>('read_local_file', { path: item.source })
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    item.payload = encodeBase64(uint8)
    await inspectResolvedTorrent(item, t)
  } catch (e) {
    logger.error('AddTask.resolveFileItem', e)
    item.status = 'failed'
    item.inspectionState = 'failed'
    item.error = t('task.file-load-failed')
  }
}

/** Resolves a remote .torrent URL by downloading bytes through Rust IPC. */
export async function resolveRemoteFileItem(item: BatchItem, t: (key: string) => string, downloadProxy?: string) {
  item.inspectionState = 'reading'
  item.error = undefined
  try {
    const context = item.browserContext
    const sanitizedHeaders = sanitizeHttpHeaderOptions({
      referer: context?.referer,
      cookie: context?.cookie,
      userAgent: context?.userAgent,
    })
    const bytes = await invoke<number[]>('fetch_remote_bytes', {
      url: item.source,
      proxy: downloadProxy ?? null,
      referer: sanitizedHeaders.referer,
      cookie: sanitizedHeaders.cookie,
      userAgent: sanitizedHeaders.userAgent,
      requestHeaders: sanitizeBrowserRequestHeaders(context?.requestHeaders ?? []),
    })
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    item.payload = encodeBase64(uint8)
    await inspectResolvedTorrent(item, t)
  } catch (e) {
    logger.error('AddTask.resolveRemoteFileItem', e)
    item.status = 'failed'
    item.inspectionState = 'failed'
    item.error = t('task.file-load-failed')
  }
}

export function isRemoteTorrentSource(source: string): boolean {
  return /^https?:\/\//i.test(source) && detectExternalInputKind(source) === 'torrent'
}

/**
 * Resolves all unresolved local file-based batch items by reading their files.
 */
export async function resolveUnresolvedItems(batch: BatchItem[], t: (key: string) => string, downloadProxy?: string) {
  const unresolved = batch.filter(
    (item) => item.kind === 'torrent' && item.inspectionState === 'reading' && item.payload === item.source,
  )
  await Promise.all(
    unresolved.map((item) =>
      isRemoteTorrentSource(item.source) ? resolveRemoteFileItem(item, t, downloadProxy) : resolveFileItem(item, t),
    ),
  )
}

export async function retryTorrentInspection(item: BatchItem, t: (key: string) => string, downloadProxy?: string) {
  if (isRemoteTorrentSource(item.source)) {
    await resolveRemoteFileItem(item, t, downloadProxy)
  } else {
    await resolveFileItem(item, t)
  }
}

/**
 * Opens a native file dialog for torrent selection, deduplicates
 * against existing batch items, resolves the files, and appends to batch.
 */
export async function chooseTorrentFile(deps: FileOpsDeps) {
  const { t, batch, fileItems, selectedBatchIndex, setPendingBatch, showWarning } = deps

  try {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
    })
    const paths = typeof selected === 'string' ? [selected] : Array.isArray(selected) ? selected : []
    if (paths.length === 0) return

    // Deduplicate: skip files already in the batch by source path
    const existingSources = new Set(batch.value.map((i) => i.source))
    const newPaths = paths.filter((p) => !existingSources.has(p))
    if (newPaths.length === 0) {
      showWarning(t('task.duplicate-task'))
      return
    }
    if (newPaths.length < paths.length) {
      showWarning(t('task.duplicate-task'))
    }

    const items = newPaths.map((p) => createBatchItem(detectKind(p), p))
    await Promise.all(items.map((item) => resolveFileItem(item, t)))
    setPendingBatch([...batch.value, ...items])
    selectedBatchIndex.value = Math.max(0, fileItems.value.length - 1)
  } catch (e) {
    logger.debug('AddTask.chooseTorrentFile', e)
  }
}
