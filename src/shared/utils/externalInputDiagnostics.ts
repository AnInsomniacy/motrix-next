/** @fileoverview Sanitized diagnostics for external download inputs. */
import type { LogFields } from '@shared/logger'
import type { Aria2EngineOptions } from '@shared/types'
import type { HeaderSanitizeDiagnostics } from './headerSanitize'

let traceSequence = 0

function nextTraceSequence(): number {
  traceSequence = (traceSequence % 9999) + 1
  return traceSequence
}

function getExtension(pathname: string): string {
  const match = pathname.match(/\.([A-Za-z0-9]{1,16})$/)
  return match?.[1]?.toLowerCase() ?? 'none'
}

function summarizeRemoteUrl(value: string): string {
  const lower = value.toLowerCase()
  if (lower.startsWith('magnet:')) return `scheme=magnet length=${value.length}`
  if (lower.startsWith('ed2k://')) return `scheme=ed2k length=${value.length}`
  if (lower.startsWith('thunder://')) return `scheme=thunder length=${value.length}`

  try {
    const parsed = new URL(value)
    const scheme = parsed.protocol.replace(':', '') || 'unknown'
    const host = parsed.hostname || 'none'
    const ext = getExtension(parsed.pathname)
    return `scheme=${scheme} host=${host} ext=${ext} hasQuery=${parsed.search ? 'true' : 'false'} length=${value.length}`
  } catch {
    return `parseable=false length=${value.length}`
  }
}

/** Returns a privacy-preserving summary that never includes query values or cookies. */
export function summarizeExternalInput(value: string): string {
  return summarizeRemoteUrl(value)
}

export function summarizeExternalInputBatch(urls: string[]): LogFields {
  return {
    count: urls.length,
    first: urls[0] ? summarizeExternalInput(urls[0]) : 'none',
  }
}

export function createExternalInputTraceId(): string {
  return `external-input-${Date.now().toString(36)}-${nextTraceSequence()}`
}

export function summarizeHeaderForwarding(diagnostics: HeaderSanitizeDiagnostics): LogFields {
  return {
    headerInputCount: diagnostics.inputCount,
    headerKeptCount: diagnostics.keptCount,
    headerDroppedCount: diagnostics.droppedCount,
    headerKeptNames: diagnostics.keptNames.join(',') || 'none',
    headerDroppedReasons: diagnostics.droppedReasons.join(',') || 'none',
  }
}

function extractHeaderNames(headerOption: Aria2EngineOptions['header']): string[] {
  const lines = Array.isArray(headerOption) ? headerOption : typeof headerOption === 'string' ? [headerOption] : []
  return lines
    .flatMap((line) => line.split('\n'))
    .map((line) => {
      const index = line.indexOf(':')
      return index > 0 ? line.slice(0, index).trim() : ''
    })
    .filter(Boolean)
}

export function summarizeAria2Options(options: Aria2EngineOptions): LogFields {
  const headerNames = extractHeaderNames(options.header)
  return {
    hasUserAgent: Boolean(options['user-agent']),
    hasReferer: Boolean(options.referer),
    headerCount: headerNames.length,
    headerNames: headerNames.join(',') || 'none',
    hasCookieHeader: headerNames.some((name) => name.toLowerCase() === 'cookie'),
    hasAuthorizationHeader: headerNames.some((name) => name.toLowerCase() === 'authorization'),
  }
}
