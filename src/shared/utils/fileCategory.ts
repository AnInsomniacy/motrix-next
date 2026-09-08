/**
 * @fileoverview Smart file classification engine — pure functions.
 *
 * Routes downloads to directories based on file extension matching.
 *
 * Two classification strategies:
 *   1. **Pre-Download (instant)**: Resolves `dir` BEFORE the aria2 RPC call
 *      using the URL's extension. aria2 writes directly to the target
 *      directory — zero post-download I/O.
 *   2. **Post-Download (auto-archive)**: For URLs without detectable extensions,
 *      the file downloads to the default directory. After completion,
 *      `resolveArchiveAction` in autoArchive.ts uses the real filename
 *      (from aria2's Content-Disposition resolution) to determine if the
 *      file should be moved.
 *
 * aria2 auto-creates non-existent directories via `util::mkdirs()`
 * (see AbstractDiskWriter.cc:251), so no pre-creation is needed.
 */
import type { FileCategory } from '@shared/types'

const MAX_URL_CANDIDATE_LENGTH = 4096
const MAX_URL_PATTERN_LENGTH = 512

export interface CategoryMatchContext {
  urls?: readonly string[]
}

export interface CategoryFileCandidate {
  path: string
  urls?: readonly string[]
}

export interface CategoryUrlPatternValidationError {
  line: number
  reason: 'invalid-regex' | 'too-long'
}

/**
 * Extracts the lowercase file extension from a URL or bare filename.
 *
 * Handles:
 * - Standard HTTP/HTTPS/SFTP URLs with path segments
 * - Query strings (`?token=...`) and fragments (`#page=3`)
 * - Percent-encoded filenames (`%E6%96%87%E4%BB%B6.pdf`)
 * - Bare filenames without protocol (`document.xlsx`)
 * - Double extensions (`archive.tar.gz` → `gz`)
 *
 * Returns empty string when no extension can be determined:
 * - Magnet URIs, data URIs, blob URIs
 * - URLs without a file path segment
 * - Dotfiles without extension (`.gitignore`)
 */
export function extractExtension(urlOrFilename: string): string {
  if (!urlOrFilename) return ''

  // Skip non-HTTP protocols that don't carry file extensions
  if (/^(magnet|data|blob):/i.test(urlOrFilename)) return ''

  // Extract pathname — strip query string and fragment first
  let pathname: string
  try {
    pathname = new URL(urlOrFilename).pathname
  } catch {
    // Not a valid URL — treat as bare filename or path
    pathname = urlOrFilename.split('?')[0].split('#')[0]
  }

  // Get the last path segment
  const segments = pathname.split('/').filter(Boolean)
  const filename = segments.pop()
  if (!filename) return ''

  // Percent-decode the segment
  let decoded: string
  try {
    decoded = decodeURIComponent(filename)
  } catch {
    decoded = filename
  }

  // Extract extension: last dot that isn't the first character (skip dotfiles)
  const dotIndex = decoded.lastIndexOf('.')
  if (dotIndex <= 0) return ''

  return decoded.substring(dotIndex + 1).toLowerCase()
}

/**
 * Matches a file extension against category rules.
 * Returns the first matching FileCategory, or undefined if none match.
 *
 * First-match wins: rule order defines priority.
 */
function normalizeExtension(ext: string): string {
  return ext.trim().toLowerCase().replace(/^\./, '')
}

export function normalizeCategoryUrlPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) return []
  const result: string[] = []
  const seen = new Set<string>()

  for (const value of patterns) {
    if (typeof value !== 'string') continue
    const pattern = value.trim()
    if (!pattern || pattern.length > MAX_URL_PATTERN_LENGTH || seen.has(pattern)) continue
    seen.add(pattern)
    result.push(pattern)
  }

  return result
}

export function validateCategoryUrlPatterns(
  patterns: readonly string[],
  mode: FileCategory['urlPatternMode'],
): CategoryUrlPatternValidationError | undefined {
  const normalizedMode = mode === 'regex' ? 'regex' : 'wildcard'

  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index]?.trim() ?? ''
    if (!pattern) continue
    if (pattern.length > MAX_URL_PATTERN_LENGTH) return { line: index + 1, reason: 'too-long' }

    try {
      if (normalizedMode === 'regex') {
        new RegExp(pattern, 'i')
      }
    } catch {
      return {
        line: index + 1,
        reason: 'invalid-regex',
      }
    }
  }

  return undefined
}

export function normalizeFileCategory(category: FileCategory): FileCategory {
  const mode = category.urlPatternMode === 'regex' ? 'regex' : 'wildcard'
  return {
    ...category,
    extensions: Array.from(new Set(category.extensions.map(normalizeExtension).filter(Boolean))),
    urlPatterns: normalizeCategoryUrlPatterns(category.urlPatterns),
    urlPatternMode: mode,
  }
}

function hasExtensionRules(category: FileCategory): boolean {
  return category.extensions.length > 0
}

function hasUrlRules(category: FileCategory): boolean {
  return normalizeCategoryUrlPatterns(category.urlPatterns).length > 0
}

function urlCandidates(context?: CategoryMatchContext): string[] {
  const urls = context?.urls ?? []
  const result: string[] = []
  const seen = new Set<string>()

  for (const value of urls) {
    const url = value.trim()
    if (!url || url.length > MAX_URL_CANDIDATE_LENGTH || seen.has(url)) continue
    seen.add(url)
    result.push(url)
  }

  return result
}

function wildcardMatches(pattern: string, url: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${source}$`, 'i').test(url)
}

function regexMatches(pattern: string, url: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(url)
  } catch {
    return false
  }
}

function matchesUrlRules(category: FileCategory, context?: CategoryMatchContext): boolean {
  const patterns = normalizeCategoryUrlPatterns(category.urlPatterns)
  if (patterns.length === 0) return true

  const candidates = urlCandidates(context)
  if (candidates.length === 0) return false
  const mode = category.urlPatternMode === 'regex' ? 'regex' : 'wildcard'

  return patterns.some((pattern) =>
    candidates.some((url) => (mode === 'regex' ? regexMatches(pattern, url) : wildcardMatches(pattern, url))),
  )
}

/**
 * Matches a file extension and optional URL context against category rules.
 * Empty URL rules preserve the legacy extension-only behavior.
 * When extension and URL rules are both configured, both must match.
 */
export function resolveCategory(
  ext: string,
  categories: FileCategory[],
  context?: CategoryMatchContext,
): FileCategory | undefined {
  const normalizedExt = normalizeExtension(ext)

  return categories.find((raw) => {
    const category = normalizeFileCategory(raw)
    const extensionConfigured = hasExtensionRules(category)
    const urlConfigured = hasUrlRules(category)
    if (!extensionConfigured && !urlConfigured) return false
    if (extensionConfigured && !category.extensions.includes(normalizedExt)) return false
    return matchesUrlRules(category, context)
  })
}

export function resolveDownloadCategory(
  url: string,
  categories: FileCategory[],
  context?: CategoryMatchContext,
): FileCategory | undefined {
  const ext = extractExtension(url)
  return resolveCategory(ext, categories, { urls: [url, ...(context?.urls ?? [])] })
}

/**
 * Resolves one category for a selected file set.
 *
 * A multi-file download is classified only when every non-empty candidate
 * resolves to the same directory. Mixed or partially unclassified content
 * stays in the default directory so its native layout remains intact.
 */
export function resolveFileSetCategory(
  files: readonly CategoryFileCandidate[],
  categories: FileCategory[],
  context?: CategoryMatchContext,
): FileCategory | undefined {
  const candidates = files.filter((file) => file.path.trim().length > 0)
  if (candidates.length === 0) return undefined

  let resolved: FileCategory | undefined
  for (const file of candidates) {
    const category = resolveDownloadCategory(file.path, categories, {
      urls: [...(file.urls ?? []), ...(context?.urls ?? [])],
    })
    if (!category) return undefined
    if (resolved && normalizeDirectory(resolved.directory) !== normalizeDirectory(category.directory)) {
      return undefined
    }
    resolved = category
  }

  return resolved
}

function normalizeDirectory(directory: string): string {
  return directory.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Resolves the effective download directory for a URI.
 *
 * When classification is enabled and the URI's extension matches a rule,
 * returns the category's absolute directory path.
 * Otherwise returns baseDir unchanged.
 *
 * @param url        - Download URI or filename
 * @param baseDir    - User's configured default download directory
 * @param enabled    - Whether file classification is enabled
 * @param categories - Classification rules with absolute directory paths
 * @returns Resolved absolute directory path
 */
export function resolveDownloadDir(
  url: string,
  baseDir: string,
  enabled: boolean,
  categories: FileCategory[],
  context?: CategoryMatchContext,
): string {
  if (!enabled) return baseDir

  const cat = resolveDownloadCategory(url, categories, context)
  return cat?.directory || baseDir
}
