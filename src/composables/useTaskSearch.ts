/**
 * @fileoverview Pure, testable fuzzy-search helpers for the task list.
 *
 * A keyword matches a task when every whitespace-separated token appears
 * (case-insensitively) as a substring of the task display name or of any
 * file basename. An empty/whitespace-only keyword matches everything.
 */
import { getFileNameFromFile, getTaskDisplayName } from '@shared/utils/task'
import type { Aria2Task } from '@shared/types'

const TOKEN_SEPARATOR = /\s+/

/** Percent-decoded file name for matching, mirroring getTaskDisplayName(). */
function getDecodedFileName(file: Parameters<typeof getFileNameFromFile>[0]): string {
  const name = getFileNameFromFile(file)
  if (!name) return ''
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** Lowercased search haystack: display name plus per-file display names. */
export function buildTaskSearchIndex(task: Aria2Task): string {
  const parts = [getTaskDisplayName(task)]
  for (const file of task.files ?? []) {
    const fileName = getDecodedFileName(file)
    if (fileName) parts.push(fileName)
  }
  return parts.join('\n').toLowerCase()
}

/** Split a raw keyword into normalized lowercase match tokens. */
export function parseSearchTokens(keyword: string): string[] {
  return keyword
    .trim()
    .toLowerCase()
    .split(TOKEN_SEPARATOR)
    .filter((token) => token.length > 0)
}

/** Returns true when every token is a substring of the task search index. */
export function taskMatchesKeyword(task: Aria2Task, tokens: readonly string[]): boolean {
  const normalized = tokens.map((token) => token.toLowerCase()).filter((token) => token.length > 0)
  if (normalized.length === 0) return true
  const index = buildTaskSearchIndex(task)
  return normalized.every((token) => index.includes(token))
}

/** Filter tasks by a raw search keyword; empty keyword returns the input as-is. */
export function filterTasksByKeyword<T extends Aria2Task>(tasks: readonly T[], keyword: string): T[] {
  const tokens = parseSearchTokens(keyword)
  if (tokens.length === 0) return [...tasks]
  return tasks.filter((task) => taskMatchesKeyword(task, tokens))
}

/** Whether a raw keyword should activate the filtered view. */
export function isKeywordActive(keyword: string | undefined): boolean {
  return Boolean(keyword?.trim())
}
