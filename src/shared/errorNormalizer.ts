/** @fileoverview Pure utility for normalizing any error into a structured format for UI display. */

import { ARIA2_ERROR_CODES } from './aria2ErrorCodes'

export type ErrorCategory = 'engine' | 'task' | 'network' | 'file' | 'config' | 'update' | 'generic'

export interface NormalizedError {
  category: ErrorCategory
  titleKey: string
  messageKey?: string
  rawMessage: string
}

/** Category → i18n title key mapping */
const CATEGORY_TITLE_KEYS: Record<ErrorCategory, string> = {
  engine: 'app.error-title-engine',
  task: 'app.error-title-task',
  network: 'app.error-title-network',
  file: 'app.error-title-file',
  config: 'app.error-title-config',
  update: 'app.error-title-update',
  generic: 'app.error-title-generic',
}

/** Known engine error patterns → specific i18n message keys */
const ENGINE_PATTERNS: Array<[RegExp, string]> = [
  [/start.*(engine|aria2)|launch.*failed/i, 'app.error-engine-start-failed'],
  [/not\s+(initialized|ready)/i, 'app.error-engine-not-ready'],
  [/not.*ready.*retr/i, 'app.error-engine-not-ready-after-retries'],
]

/** Known RPC / network error patterns */
const NETWORK_PATTERNS: Array<[RegExp, string]> = [
  [/rpc.*connect|connection.*refused|ECONNREFUSED/i, 'app.error-rpc-connection-failed'],
  [/timeout|timed?\s*out|ETIMEDOUT|rpc request timed out/i, 'app.error-rpc-timeout'],
  [/load failed|websocket closed|fetch failed|networkerror/i, 'app.error-rpc-connection-failed'],
]

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    // Rust AppError serialized as { Engine: "msg" } or { Config: "msg" }
    const keys = Object.keys(error)
    if (keys.length === 1) {
      const val = (error as Record<string, unknown>)[keys[0]]
      if (typeof val === 'string') return val
    }
    // JSON-RPC error structure { code: number, message: string }
    if ('message' in error && typeof (error as Record<string, unknown>).message === 'string') {
      return (error as Record<string, unknown>).message as string
    }
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function detectCategory(error: unknown, rawMessage: string): ErrorCategory {
  // Rust AppError variant detection: { Engine: "..." }, "Engine error: ..."
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const keys = Object.keys(error)
    if (keys.length === 1) {
      const variant = keys[0].toLowerCase()
      if (variant === 'engine') return 'engine'
      if (variant === 'config') return 'config'
      if (variant === 'network') return 'network'
      if (variant === 'io' || variant === 'file') return 'file'
      if (variant === 'task') return 'task'
    }
  }

  const msg = rawMessage.toLowerCase()

  // Engine patterns
  if (msg.includes('engine') || msg.includes('aria2') || msg.includes('not initialized')) return 'engine'

  // Task patterns
  if (msg.includes('duplicate') || msg.includes('already')) return 'task'

  // Network patterns (includes macOS WebKit "load failed" and WebSocket errors)
  if (
    msg.includes('network') ||
    msg.includes('connection') ||
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('rpc') ||
    msg.includes('load failed') ||
    msg.includes('websocket closed') ||
    msg.includes('fetch failed') ||
    msg.includes('networkerror')
  )
    return 'network'

  // File patterns
  if (msg.includes('disk full') || msg.includes('permission denied') || msg.includes('enospc')) return 'file'

  // Config patterns
  if (msg.includes('config') || msg.includes('preference') || msg.includes('settings')) return 'config'

  // Update patterns
  if (msg.includes('update') || msg.includes('upgrade')) return 'update'

  return 'generic'
}

function findMessageKey(category: ErrorCategory, rawMessage: string): string | undefined {
  const patterns = category === 'engine' ? ENGINE_PATTERNS : category === 'network' ? NETWORK_PATTERNS : []
  for (const [re, key] of patterns) {
    if (re.test(rawMessage)) return key
  }
  return undefined
}

/**
 * Normalizes any error into a structured format suitable for UI display.
 * Pure function with no Vue dependencies.
 */
export function normalizeError(error: unknown, contextHint?: ErrorCategory): NormalizedError {
  const rawMessage = extractRawMessage(error)
  const category = contextHint ?? detectCategory(error, rawMessage)
  const titleKey = CATEGORY_TITLE_KEYS[category]
  const messageKey = findMessageKey(category, rawMessage)

  return { category, titleKey, messageKey, rawMessage }
}

/**
 * Normalizes an aria2 task error using its errorCode for precise mapping.
 */
export function normalizeTaskError(
  errorCode: string | undefined,
  errorMessage: string | undefined,
  taskName?: string,
): NormalizedError {
  const i18nKey = errorCode ? ARIA2_ERROR_CODES[errorCode] : undefined
  const rawMessage = taskName ? `${taskName}: ${errorMessage || 'Unknown error'}` : errorMessage || 'Unknown error'

  return {
    category: 'task',
    titleKey: CATEGORY_TITLE_KEYS.task,
    messageKey: i18nKey,
    rawMessage,
  }
}

/** Generates a deduplication key from a normalized error. */
export function errorDedupeKey(err: NormalizedError): string {
  return `${err.category}:${err.messageKey || err.rawMessage}`
}
