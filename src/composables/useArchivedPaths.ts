/** Resolves task paths after automatic archiving, with reactive file rechecks. */
import { shallowReactive, shallowRef } from 'vue'
import type { Aria2Task } from '@shared/types'

const archivedPaths = shallowReactive(new Map<string, string>())

export const recheckTrigger = shallowRef(0)

export function setArchivedPath(gid: string, newPath: string): void {
  archivedPaths.set(gid, newPath)
}

export function requestFileRecheck(): void {
  recheckTrigger.value++
}

/** Prefer the archived location, then the first selected file. */
export function resolveTaskFilePath(task: Aria2Task): string | null {
  const archived = archivedPaths.get(task.gid)
  if (archived) return archived
  const files = task.files
  if (!files || files.length === 0) return null
  return (files.find((file) => file.selected === 'true') ?? files[0])?.path ?? null
}
