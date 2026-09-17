/** @fileoverview BitTorrent file selection and category routing. */
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'
import { usePlatform } from '@/composables/usePlatform'
import {
  buildSelectFileOption,
  isPendingMagnetSelectionTask,
  parseFilesForSelection,
} from '@/composables/useMagnetFlow'
import { normalizeSep } from '@shared/utils/autoArchive'
import { resolveFileSetCategory } from '@shared/utils/fileCategory'
import type { Aria2Task, BtFileSelectionItem } from '@shared/types'

export function useBtSelection() {
  const preferences = usePreferenceStore()
  const tasks = useTaskStore()
  const { isWindows } = usePlatform()

  function categoryDirectory(task: Aria2Task, files: readonly { path: string; length: number }[]) {
    const config = preferences.config
    if (!config.fileCategoryEnabled || !config.fileCategories.length) return undefined
    const normalize = (directory: string) => {
      const path = normalizeSep(directory).replace(/\/+$/, '')
      return isWindows.value ? path.toLowerCase() : path
    }
    if (normalize(task.dir) !== normalize(config.dir)) return undefined
    return resolveFileSetCategory(
      files.filter((file) => file.length > 0),
      config.fileCategories,
      { urls: [task.bittorrent?.magnetLink ?? ''] },
    )?.directory
  }

  async function selectFiles(task: Aria2Task, files: BtFileSelectionItem[], indices: number[]) {
    const selected = new Set(indices)
    if (!selected.size) throw new Error('Select at least one file')
    await tasks.applyMagnetFileSelection(
      task,
      buildSelectFileOption(indices),
      categoryDirectory(
        task,
        files.filter((file) => selected.has(file.index)),
      ),
    )
  }

  async function classifyPending(gid: string) {
    if (preferences.config.magnetFileSelectionPolicy !== 'download-all' || !preferences.config.fileCategoryEnabled)
      return
    const task = await tasks.fetchTaskStatus(gid)
    if (!isPendingMagnetSelectionTask(task)) return
    const files = parseFilesForSelection(await tasks.getFiles(gid))
    if (files.length)
      await selectFiles(
        task,
        files,
        files.map((file) => file.index),
      )
  }
  return { selectFiles, classifyPending }
}
