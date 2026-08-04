/** @fileoverview File deletion for download content and aria2 metadata. */
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'
import { resolveOpenTarget } from '@shared/utils'
import { cleanupAria2MetadataFiles } from '@/composables/useDownloadCleanup'
import type { Aria2Task, FileDeletionMode } from '@shared/types'

export async function deletePath(path: string, mode: FileDeletionMode): Promise<boolean> {
  if (!path) return false
  return invoke<boolean>('delete_path', { path, mode })
}

async function deletePaths(paths: string[], mode: FileDeletionMode): Promise<void> {
  const failures: string[] = []
  for (const path of new Set(paths.filter(Boolean))) {
    try {
      await deletePath(path, mode)
    } catch (error) {
      failures.push(`${path}: ${String(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to delete ${failures.length} path(s): ${failures.join('; ')}`)
  }
}

/** Content paths a task owns: its resolved target, or its individual files. */
async function resolveContentPaths(task: Aria2Task): Promise<string[]> {
  const target = await resolveOpenTarget(task)
  if (target && target !== task.dir) return [target]
  return (task.files || []).map((file) => file.path)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** True when `path` is, contains, or is contained by one of `protectedPaths`. */
function isProtected(path: string, protectedPaths: string[]): boolean {
  if (!path) return false
  const candidate = normalizePath(path)
  return protectedPaths.some((protectedPath) => {
    const other = normalizePath(protectedPath)
    return candidate === other || candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`)
  })
}

/**
 * Content paths still owned by tasks other than `gid`. Tasks pointing at the
 * same file (e.g. the same URL queued twice, or a re-added torrent) must keep
 * their data when one of them is removed.
 */
async function collectProtectedPaths(gid: string, tasks: Aria2Task[]): Promise<string[]> {
  const paths = new Set<string>()

  for (const task of tasks) {
    if (task.gid === gid) continue

    try {
      for (const path of await resolveContentPaths(task)) {
        if (path) paths.add(path)
      }
    } catch (error) {
      logger.debug('collectProtectedPaths', `resolve gid=${task.gid} skipped: ${error}`)
    }

    for (const file of task.files || []) {
      if (file.path) paths.add(file.path)
    }
  }

  return [...paths]
}

export async function cleanupAria2ControlFiles(task: Aria2Task, protectedPaths: string[] = []): Promise<void> {
  try {
    const paths: string[] = []
    if (task.dir && task.infoHash) {
      paths.push(`${task.dir}/${task.infoHash}.aria2`)
    }

    for (const path of await resolveContentPaths(task)) {
      if (path) paths.push(path + '.aria2')
    }

    // A control file belongs to whichever task is still downloading that path;
    // removing it would reset the surviving task's progress.
    await deletePaths(
      paths.filter((path) => !isProtected(path.replace(/\.aria2$/, ''), protectedPaths)),
      'permanent',
    )
  } catch (error) {
    logger.debug('cleanupAria2ControlFiles', `cleanup failed: ${error}`)
  }
}

export async function deleteTaskFiles(
  task: Aria2Task,
  mode: FileDeletionMode,
  protectedTasks: Aria2Task[] = [],
): Promise<void> {
  const protectedPaths = await collectProtectedPaths(task.gid, protectedTasks)
  const contentPaths = (await resolveContentPaths(task)).filter((path) => {
    if (!isProtected(path, protectedPaths)) return true
    logger.warn('deleteTaskFiles', `Skipped ${path}: still referenced by another task`)
    return false
  })
  let deletionError: unknown

  try {
    await deletePaths(contentPaths, mode)
  } catch (error) {
    deletionError = error
  } finally {
    await cleanupAria2ControlFiles(task, protectedPaths)
    if (task.dir && task.infoHash) {
      await cleanupAria2MetadataFiles(task.dir, task.infoHash)
    }
  }

  if (deletionError) throw deletionError
}
