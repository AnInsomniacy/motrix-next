/** @fileoverview Download content deletion. */
import { invoke } from '@tauri-apps/api/core'
import { resolveOpenTarget } from '@shared/utils'
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

export async function deleteTaskFiles(task: Aria2Task, mode: FileDeletionMode): Promise<void> {
  const target = await resolveOpenTarget(task)
  const contentPaths = target && target !== task.dir ? [target] : (task.files || []).map((file) => file.path)
  let deletionError: unknown

  try {
    await deletePaths(contentPaths, mode)
  } catch (error) {
    deletionError = error
  }

  if (deletionError) throw deletionError
}
