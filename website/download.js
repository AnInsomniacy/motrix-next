/**
 * @fileoverview Download resolution logic for the Motrix Next website.
 *
 * Provides pure functions for:
 * - Building CDN URLs for channel-specific updater JSON files
 * - Resolving platform-specific download URLs from release asset data
 * - Deriving installer URLs from Tauri updater JSON platforms
 *
 * This module has zero DOM dependencies and is fully testable in Node/Vitest.
 */

/** Base URL for static assets hosted on the permanent `updater` GitHub Release tag. */
export const UPDATER_BASE_URL =
  'https://github.com/AnInsomniacy/motrix-next/releases/download/updater'

/**
 * Platform definitions used to match GitHub Release asset filenames
 * to platform-specific download keys.
 *
 * Each entry has:
 * - `key`   — stable identifier used to look up resolved URLs
 * - `os`    — display name for the operating system
 * - `arch`  — display name for the architecture
 * - `fmt`   — file extension label
 * - `match` — predicate that tests whether a GitHub Release asset filename belongs to this platform
 */
export const PLATFORMS = [
  {
    key: 'dmg-arm',
    os: 'macOS',
    arch: 'Apple Silicon',
    fmt: '.dmg',
    match: (n) => n.includes('aarch64') && n.endsWith('.dmg'),
  },
  {
    key: 'dmg-x64',
    os: 'macOS',
    arch: 'Intel',
    fmt: '.dmg',
    match: (n) => n.includes('x64') && n.endsWith('.dmg'),
  },
  {
    key: 'exe-x64',
    os: 'Windows',
    arch: 'x64',
    fmt: '.exe',
    match: (n) => n.includes('x64') && n.endsWith('-setup.exe'),
  },
  {
    key: 'exe-arm',
    os: 'Windows',
    arch: 'ARM64',
    fmt: '.exe',
    match: (n) => /(?:aarch64|arm64)/.test(n) && n.endsWith('-setup.exe'),
  },
  {
    key: 'appimage-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.AppImage',
    match: (n) => n.includes('amd64') && n.endsWith('.AppImage'),
  },
  {
    key: 'deb-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.deb',
    match: (n) => n.includes('amd64') && n.endsWith('.deb'),
  },
  {
    key: 'appimage-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.AppImage',
    match: (n) => n.includes('aarch64') && n.endsWith('.AppImage'),
  },
  {
    key: 'deb-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.deb',
    match: (n) => /(?:aarch64|arm64)/.test(n) && n.endsWith('.deb'),
  },
  {
    key: 'rpm-x64',
    os: 'Linux',
    arch: 'x64',
    fmt: '.rpm',
    match: (n) => n.includes('x86_64') && n.endsWith('.rpm'),
  },
  {
    key: 'rpm-arm',
    os: 'Linux',
    arch: 'ARM64',
    fmt: '.rpm',
    match: (n) => n.includes('aarch64') && n.endsWith('.rpm'),
  },
]

// --- Functions ---

/**
 * Returns the CDN URL for the channel-specific updater JSON file.
 *
 * The website reads the same JSON that the Tauri in-app updater uses:
 * - `latest.json` for the stable channel
 * - `beta.json`   for the beta channel
 *
 * @param {string} channel — `'stable'` or `'beta'`; anything else falls back to stable.
 * @returns {string} Full URL to the JSON asset on the `updater` Release tag.
 */
export function channelJsonUrl(channel) {
  const file = channel === 'beta' ? 'beta.json' : 'latest.json'
  return `${UPDATER_BASE_URL}/${file}`
}

/**
 * Resolves platform-specific download URLs from a list of release assets.
 *
 * Iterates all PLATFORMS and finds the first matching asset for each,
 * building a `{ [platformKey]: downloadUrl }` map.
 *
 * @param {Array<{name: string, url: string}>} assets — release asset objects
 * @returns {Record<string, string>} Map of platform keys to download URLs.
 */
export function resolveDownloadUrls(assets) {
  const urls = {}
  for (const p of PLATFORMS) {
    const asset = assets.find((a) => p.match(a.name))
    if (asset) urls[p.key] = asset.url
  }
  return urls
}

/**
 * Mapping from Tauri updater platform keys to website download platform keys.
 *
 * The updater JSON uses Tauri-standard keys (e.g. `darwin-aarch64`),
 * while the website uses human-friendly keys (e.g. `dmg-arm`).
 *
 * For macOS, the updater provides `.app.tar.gz` (delta update) URLs; the
 * website needs `.dmg` (installer) URLs. These are derived by replacing
 * the updater filename with the corresponding `.dmg` filename pattern.
 *
 * For Windows and Linux, the updater URL points to the same installer
 * file the website needs, so the URL is used directly.
 */
const UPDATER_TO_WEBSITE = {
  'darwin-aarch64': { key: 'dmg-arm', derive: 'dmg' },
  'darwin-x86_64': { key: 'dmg-x64', derive: 'dmg' },
  'windows-x86_64': { key: 'exe-x64', derive: null },
  'windows-aarch64': { key: 'exe-arm', derive: null },
  'linux-x86_64': { key: 'appimage-x64', derive: null },
  'linux-aarch64': { key: 'appimage-arm', derive: null },
  'linux-x86_64-deb': { key: 'deb-x64', derive: null },
  'linux-aarch64-deb': { key: 'deb-arm', derive: null },
  // RPM entries are not in the updater JSON; derive from the AppImage URL.
  'linux-x86_64:rpm': { key: 'rpm-x64', derive: 'rpm', source: 'linux-x86_64' },
  'linux-aarch64:rpm': { key: 'rpm-arm', derive: 'rpm', source: 'linux-aarch64' },
}

/**
 * Derives a macOS `.dmg` installer URL from a Tauri updater `.app.tar.gz` URL.
 *
 * Updater URL pattern: `BASE/MotrixNext_aarch64.app.tar.gz`
 * Derived  URL pattern: `BASE/MotrixNext_VERSION_aarch64.dmg`
 *
 * @param {string} updaterUrl — the `.app.tar.gz` URL from the updater JSON
 * @param {string} version   — semantic version string (e.g. `"3.4.6"` or `"3.4.6-beta.8"`)
 * @returns {string} the corresponding `.dmg` download URL
 */
export function deriveDmgUrl(updaterUrl, version) {
  // Extract architecture from the updater filename: MotrixNext_{arch}.app.tar.gz
  const match = updaterUrl.match(/MotrixNext_([^.]+)\.app\.tar\.gz$/)
  if (!match) return updaterUrl
  const arch = match[1]
  const base = updaterUrl.substring(0, updaterUrl.lastIndexOf('/'))
  return `${base}/MotrixNext_${version}_${arch}.dmg`
}

/**
 * Derives a Linux `.rpm` installer URL from a Tauri updater AppImage URL.
 *
 * AppImage URL pattern: `BASE/MotrixNext_VERSION_amd64.AppImage`
 * Derived  RPM pattern: `BASE/MotrixNext-VERSION-1.x86_64.rpm`
 *
 * RPM uses different arch naming: `amd64` → `x86_64`, `aarch64` → `aarch64`.
 *
 * @param {string} appImageUrl — the `.AppImage` URL from the updater JSON
 * @param {string} version     — semantic version string
 * @returns {string} the corresponding `.rpm` download URL
 */
export function deriveRpmUrl(appImageUrl, version) {
  const base = appImageUrl.substring(0, appImageUrl.lastIndexOf('/'))
  // Map AppImage arch names to RPM arch names
  const rpmArch = appImageUrl.includes('amd64') ? 'x86_64' : 'aarch64'
  return `${base}/MotrixNext-${version}-1.${rpmArch}.rpm`
}

/**
 * Resolves website download URLs from a Tauri updater JSON `platforms` object.
 *
 * This function bridges the updater JSON format to the website's flat
 * `{ platformKey: url }` map. For macOS, it derives the `.dmg` URL from
 * the updater's `.app.tar.gz` URL. For RPM, it derives the URL from
 * the AppImage URL. For all other platforms, the URL is used as-is.
 *
 * @param {Record<string, {url: string}>} platforms — the `platforms` object from `latest.json` or `beta.json`
 * @param {string} version — semantic version (e.g. `"3.4.6"`)
 * @returns {Record<string, string>} Map of website platform keys to download URLs.
 */
export function resolveFromUpdaterJson(platforms, version) {
  const urls = {}
  for (const [updaterKey, mapping] of Object.entries(UPDATER_TO_WEBSITE)) {
    // For derived entries (e.g. RPM), look up the source platform instead
    const sourceKey = mapping.source || updaterKey
    const entry = platforms[sourceKey]
    if (!entry) continue
    if (mapping.derive === 'dmg') {
      urls[mapping.key] = deriveDmgUrl(entry.url, version)
    } else if (mapping.derive === 'rpm') {
      urls[mapping.key] = deriveRpmUrl(entry.url, version)
    } else {
      urls[mapping.key] = entry.url
    }
  }
  return urls
}
