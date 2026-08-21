/** @fileoverview User-facing error message normalization for unknown thrown values. */

const TAURI_ERROR_LABELS: Record<string, string> = {
  Store: 'Store error',
  Engine: 'Engine error',
  Io: 'IO error',
  NotFound: 'Not found',
  Updater: 'Updater error',
  Upnp: 'UPnP error',
  Protocol: 'Protocol error',
  Aria2: 'Aria2 Next error',
  Database: 'Database error',
  Hls: 'HLS error',
}

type TauriErrorVariant = keyof typeof TAURI_ERROR_LABELS

export interface ErrorMessageOptions {
  fallback?: string
  labels?: Partial<Record<TauriErrorVariant, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringifyUnknownObject(value: unknown, seen = new WeakSet<object>()): string {
  if (!isRecord(value)) return String(value)

  if (seen.has(value)) return '"[Circular]"'
  seen.add(value)

  try {
    const entries = Object.entries(value).map(([key, entryValue]) => {
      if (isRecord(entryValue)) {
        return `${JSON.stringify(key)}:${stringifyUnknownObject(entryValue, seen)}`
      }
      if (typeof entryValue === 'undefined') {
        return `${JSON.stringify(key)}:"[undefined]"`
      }
      if (typeof entryValue === 'bigint') {
        return `${JSON.stringify(key)}:"${entryValue.toString()}n"`
      }
      if (typeof entryValue === 'symbol' || typeof entryValue === 'function') {
        return `${JSON.stringify(key)}:${JSON.stringify(String(entryValue))}`
      }
      return `${JSON.stringify(key)}:${JSON.stringify(entryValue)}`
    })
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function formatTauriPayload(
  variant: TauriErrorVariant,
  payload: string,
  labels?: ErrorMessageOptions['labels'],
): string {
  const label = labels?.[variant] || TAURI_ERROR_LABELS[variant]
  if (variant !== 'Aria2') return `${label}: ${payload}`

  const rpcMatch = payload.match(/^aria2\s+(?:RPC|multicall)\s+error\s+\[([^\]]+)\]:\s*(.+)$/i)
  if (rpcMatch) {
    return `${label} [${rpcMatch[1]}]: ${rpcMatch[2]}`
  }

  return `${label}: ${payload}`
}

function normalizeMessage(value: unknown, options: ErrorMessageOptions): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value === null) return 'null'
  if (typeof value === 'undefined') return ''

  if (!isRecord(value)) return String(value)

  const directMessage = value.message
  if (typeof directMessage === 'string' && directMessage.trim()) return directMessage

  const nestedError = value.error
  if (isRecord(nestedError)) {
    const code = nestedError.code
    const message = nestedError.message
    if ((typeof code === 'number' || typeof code === 'string') && typeof message === 'string' && message.trim()) {
      return `JSON-RPC error [${code}]: ${message}`
    }
    const nested = normalizeMessage(nestedError, options)
    if (nested) return nested
  }

  for (const variant of Object.keys(TAURI_ERROR_LABELS) as TauriErrorVariant[]) {
    const payload = value[variant]
    if (typeof payload === 'string' && payload.trim()) {
      return formatTauriPayload(variant, payload, options.labels)
    }
  }

  return stringifyUnknownObject(value)
}

export function getErrorMessage(value: unknown, options: ErrorMessageOptions = {}): string {
  const message = normalizeMessage(value, options).trim()
  return message || options.fallback || 'Unknown error'
}
