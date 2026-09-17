import { describe, expect, it, vi } from 'vitest'
import {
  resolveUserVisibleDownloadDir,
  shouldPersistResolvedDownloadDir,
  type UserVisibleDirectoryDeps,
} from '../userVisibleDirectory'

function deps(overrides: Partial<UserVisibleDirectoryDeps> = {}): UserVisibleDirectoryDeps {
  return {
    downloadDir: vi.fn(async () => '/home/parallels/'),
    homeDir: vi.fn(async () => '/home/parallels'),
    appDataDir: vi.fn(async () => '/home/parallels/.local/share/dev.aninsomniacy.rayburst'),
    pathExists: vi.fn(async (path: string) => path === '/home/parallels/Downloads'),
    join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
    ...overrides,
  }
}

describe('resolveUserVisibleDownloadDir', () => {
  it('uses an existing configured directory before probing OS defaults', async () => {
    const d = deps()

    const result = await resolveUserVisibleDownloadDir({ configuredDir: '/data/downloads', deps: d })

    expect(result).toEqual({ path: '/data/downloads', source: 'configured', usedFallback: false })
    expect(d.downloadDir).not.toHaveBeenCalled()
    expect(d.pathExists).not.toHaveBeenCalled()
  })

  it('uses ~/Downloads when Linux XDG resolves Downloads to home but ~/Downloads exists', async () => {
    const d = deps()

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/home/parallels/Downloads', source: 'home-downloads', usedFallback: true })
  })

  it('uses the OS download directory when it is distinct from home', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => '/home/parallels/Downloads'),
      pathExists: vi.fn(async () => false),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/home/parallels/Downloads', source: 'system-downloads', usedFallback: false })
    expect(d.pathExists).not.toHaveBeenCalledWith('/home/parallels/Downloads')
  })

  it('uses macOS Downloads even when frontend filesystem scope cannot stat it', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => '/Users/sekiro/Downloads'),
      homeDir: vi.fn(async () => '/Users/sekiro'),
      pathExists: vi.fn(async () => false),
      join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/Users/sekiro/Downloads', source: 'system-downloads', usedFallback: false })
  })

  it('uses Windows Downloads even when frontend filesystem scope cannot stat it', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => 'C:/Users/sekiro/Downloads'),
      homeDir: vi.fn(async () => 'C:/Users/sekiro'),
      pathExists: vi.fn(async () => false),
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: 'C:/Users/sekiro/Downloads', source: 'system-downloads', usedFallback: false })
  })

  it('falls back to home when Downloads does not exist', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => '/home/parallels/'),
      pathExists: vi.fn(async () => false),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({ path: '/home/parallels', source: 'home', usedFallback: true })
  })

  it('falls back to app data when all user directory probes fail', async () => {
    const d = deps({
      downloadDir: vi.fn(async () => {
        throw new Error('unknown path')
      }),
      homeDir: vi.fn(async () => {
        throw new Error('home missing')
      }),
      pathExists: vi.fn(async () => false),
    })

    const result = await resolveUserVisibleDownloadDir({ deps: d })

    expect(result).toEqual({
      path: '/home/parallels/.local/share/dev.aninsomniacy.rayburst',
      source: 'app-data',
      usedFallback: true,
    })
  })

  it('persists only confident default directory resolutions', () => {
    expect(
      shouldPersistResolvedDownloadDir({
        path: '/Users/sekiro/Downloads',
        source: 'system-downloads',
        usedFallback: false,
      }),
    ).toBe(true)
    expect(
      shouldPersistResolvedDownloadDir({
        path: '/home/parallels/Downloads',
        source: 'home-downloads',
        usedFallback: true,
      }),
    ).toBe(true)
    expect(shouldPersistResolvedDownloadDir({ path: '/home/parallels', source: 'home', usedFallback: true })).toBe(
      false,
    )
    expect(
      shouldPersistResolvedDownloadDir({
        path: '/tmp/dev.aninsomniacy.rayburst',
        source: 'app-data',
        usedFallback: true,
      }),
    ).toBe(false)
  })
})
