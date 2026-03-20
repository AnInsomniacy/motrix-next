/** Type declarations for the website download resolution module. */

export interface Platform {
  key: string
  os: string
  arch: string
  fmt: string
  match: (filename: string) => boolean
}

export interface Asset {
  name: string
  url: string
}

export interface UpdaterPlatformEntry {
  signature: string
  url: string
}

export declare const UPDATER_BASE_URL: string
export declare const PLATFORMS: Platform[]
export declare function channelJsonUrl(channel: string): string
export declare function resolveDownloadUrls(assets: Asset[]): Record<string, string>
export declare function deriveDmgUrl(updaterUrl: string, version: string): string
export declare function deriveRpmUrl(appImageUrl: string, version: string): string
export declare function resolveFromUpdaterJson(
  platforms: Record<string, UpdaterPlatformEntry>,
  version: string,
): Record<string, string>
