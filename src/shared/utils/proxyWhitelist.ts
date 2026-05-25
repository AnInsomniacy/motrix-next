/** @fileoverview Proxy whitelist parsing and URL matching utilities. */
import { isEmpty } from 'lodash-es'

/**
 * Parses a whitelist string (comma-separated, newline-separated, or mixed)
 * into an array of trimmed, non-empty domain patterns.
 *
 * Each pattern can be:
 * - Exact domain: `example.com`
 * - Wildcard subdomain: `*.example.com` (matches example.com and all its subdomains)
 */
export function parseWhitelist(input: string): string[] {
  if (!input || !input.trim()) return []
  return (
    input
      // Split by comma or newline
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
}

/**
 * Determines whether a URL's hostname matches any pattern in a whitelist.
 *
 * Only HTTP/HTTPS/FTP URLs are evaluated — magnet, ed2k, thunder, and other
 * non-URL schemes return false (no match), which means the proxy is NOT applied.
 *
 * Matching rules:
 * - `example.com` matches only that exact hostname
 * - `*.example.com` matches example.com and all its subdomains
 *
 * @param url - The full URL string (e.g. "https://example.com/file.zip")
 * @param whitelist - Parsed list of domain patterns (from parseWhitelist)
 * @returns true if the URL's hostname matches any pattern in the whitelist
 */
export function isUrlInWhitelist(url: string, whitelist: string[]): boolean {
  if (!url || isEmpty(whitelist)) return false

  // Only evaluate HTTP/HTTPS/FTP URLs
  const protocolMatch = url.match(/^(https?|ftp):\/\//)
  if (!protocolMatch) return false

  // Extract hostname from URL
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }

  if (!hostname) return false

  return whitelist.some((pattern) => matchDomain(hostname, pattern))
}

/**
 * Matches a hostname against a single domain pattern.
 *
 * - `example.com` → matches if hostname === 'example.com'
 * - `*.example.com` → matches if hostname === 'example.com' or ends with '.example.com'
 */
function matchDomain(hostname: string, pattern: string): boolean {
  const trimmed = pattern.trim().toLowerCase()
  const normalizedHost = hostname.toLowerCase()

  if (trimmed.startsWith('*.')) {
    // Wildcard: *.example.com
    const suffix = trimmed.slice(1) // ".example.com"
    return normalizedHost === suffix.slice(1) || normalizedHost.endsWith(suffix)
  }

  // Exact match
  return normalizedHost === trimmed
}
