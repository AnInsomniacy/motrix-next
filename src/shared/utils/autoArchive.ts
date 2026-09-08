/**
 * @fileoverview Post-download auto-archive — pure classification logic.
 *
 * When a download completes and the file was NOT pre-classified (e.g. the URL
 * had no detectable extension like `/download?id=123`), this module determines
 * whether the file should be moved to a category directory based on its real
 * filename (as resolved by aria2 via Content-Disposition or URL path).
 *
 * This is a fallback for stream downloads whose final filename was unavailable
 * before submission. P2P tasks resolve their target directory from native
 * metadata before payload transfer starts.
 */
import type { Aria2Task, FileCategory } from '@shared/types'
import { logger } from '@shared/logger'
import { extractExtension, resolveCategory } from './fileCategory'

/**
 * Normalizes path separators to forward slash for cross-platform comparison.
 *
 * On Windows, paths arrive in mixed formats from different sources:
 * - aria2 (`task.files[0].path`):       `C:/Users/x/Downloads/file.zip`
 * - preferenceStore.config.dir:          `C:\Users\x\Downloads`
 * - buildDefaultCategories():            `C:\Users\x\Downloads/Archives`
 *
 * This function canonicalizes all paths to forward slashes before comparison,
 * matching the industry-standard approach used by VS Code, ESLint, and Vite.
 */
export function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Determines whether a completed task's file should be archived (moved)
 * to a category directory.
 *
 * @param task       - Completed aria2 task with resolved file paths
 * @param enabled    - Whether file classification is enabled
 * @param categories - Classification rules with absolute directory paths
 * @param baseDir    - Default download directory — only files here are candidates for archiving.
 *                     Files in user-specified custom paths are left untouched.
 * @returns `{ source, targetDir }` if archiving is needed, `null` otherwise
 */
export function resolveArchiveAction(
  task: Aria2Task,
  enabled: boolean,
  categories: FileCategory[],
  baseDir: string,
): { source: string; targetDir: string } | null {
  if (!enabled) {
    logger.debug('AutoArchive.skip', 'classification disabled')
    return null
  }
  if (categories.length === 0) {
    logger.debug('AutoArchive.skip', 'empty categories array')
    return null
  }

  // Get the primary file's resolved path
  const firstFile = task.files?.[0]
  const filePath = firstFile?.path
  if (!filePath) {
    logger.debug('AutoArchive.skip', 'no file path')
    return null
  }

  // Extract filename from the full path
  const fileName = filePath.split(/[/\\]/).pop()
  if (!fileName) {
    logger.debug('AutoArchive.skip', 'empty filename')
    return null
  }

  // Only archive files that are in the default download directory.
  // Files in user-specified custom paths were intentionally placed there — leave untouched.
  // Normalize separators before comparison to handle Windows mixed-separator paths.
  const fileDir = normalizeSep(filePath.substring(0, filePath.length - fileName.length).replace(/[\\/]+$/, ''))
  const normalizedBase = normalizeSep(baseDir.replace(/[\\/]+$/, ''))
  if (fileDir !== normalizedBase) {
    logger.debug('AutoArchive.skip', `baseDir mismatch (fileDir=${fileDir}, base=${normalizedBase})`)
    return null
  }

  const ext = extractExtension(fileName)
  const category = resolveCategory(ext, categories, {
    urls: [fileName, ...(firstFile.uris ?? []).map((entry) => entry.uri)],
  })
  if (!category) {
    logger.debug('AutoArchive.skip', `no category match (ext=${ext || 'none'})`)
    return null
  }

  return { source: filePath, targetDir: category.directory }
}
