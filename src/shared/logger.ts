/** @fileoverview Centralized logging utility bridging to tauri-plugin-log for persistent file output. */
import { error as tauriError, warn as tauriWarn, info as tauriInfo, debug as tauriDebug } from '@tauri-apps/plugin-log'
import { getErrorMessage } from '@shared/utils/errorMessage'

export type LogFieldValue = string | number | boolean | null | undefined
export type LogFields = Record<string, LogFieldValue>

function toKeyValues(target: string, fields: LogFields = {}): Record<string, string> {
  return Object.fromEntries([
    ['target', target],
    ...Object.entries(fields).map(([key, value]) => [key, value === null ? 'null' : String(value)]),
  ])
}

function serializeDebugValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${value.toString()}n`
    case 'undefined':
      return '"[undefined]"'
    case 'symbol':
      return JSON.stringify(value.toString())
    case 'function':
      return JSON.stringify(`[Function ${value.name || 'anonymous'}]`)
    case 'object':
      break
    default:
      return JSON.stringify(String(value))
  }

  if (value instanceof Error) {
    return JSON.stringify(value.stack ?? value.message)
  }

  if (seen.has(value)) {
    return JSON.stringify('[Circular]')
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeDebugValue(item, seen)).join(',')}]`
    }

    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
      try {
        return `${JSON.stringify(key)}:${serializeDebugValue(entryValue, seen)}`
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return `${JSON.stringify(key)}:${JSON.stringify(`[Unserializable: ${reason}]`)}`
      }
    })

    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function formatDebugMessage(data: unknown): string {
  if (data instanceof Error) {
    return data.stack ?? data.message
  }

  if (typeof data === 'string') {
    return data
  }

  if (data === undefined) {
    return ''
  }

  try {
    return serializeDebugValue(data)
  } catch (error) {
    return error instanceof Error ? `[Unserializable: ${error.message}]` : '[Unserializable payload]'
  }
}

/**
 * Centralized logger providing structured, level-gated output.
 *
 * Each log level bridges to the Rust-side `tauri-plugin-log` for persistent file storage
 * with automatic rotation. Console output policy:
 * - **error / warn**: mirror to `console.error` / `console.warn` for DevTools visibility
 * - **info / debug**: silent in console — only written to the Rust log file
 *
 * The `.catch(() => {})` on every tauri call prevents IPC failures from propagating
 * into business logic (e.g., during app teardown or before plugin initialisation).
 */
export const logger = {
  error(context: string, error: unknown, fields: LogFields = {}): void {
    const message = getErrorMessage(error)
    console.error(`[${context}] ${message}`)
    tauriError(message, {
      keyValues: toKeyValues(context, {
        ...fields,
        error_type: error instanceof Error ? error.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    }).catch(() => {})
  },

  warn(context: string, message: string, fields: LogFields = {}): void {
    console.warn(`[${context}] ${message}`)
    tauriWarn(message, { keyValues: toKeyValues(context, fields) }).catch(() => {})
  },

  info(context: string, message: string, fields: LogFields = {}): void {
    tauriInfo(message, { keyValues: toKeyValues(context, fields) }).catch(() => {})
  },

  debug(context: string, data?: unknown, fields: LogFields = {}): void {
    const message = formatDebugMessage(data)
    tauriDebug(message, { keyValues: toKeyValues(context, fields) }).catch(() => {})
  },
}
