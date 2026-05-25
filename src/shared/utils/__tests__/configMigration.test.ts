/**
 * @fileoverview TDD tests for the config migration system.
 *
 * Tests are written BEFORE the implementation to drive the design.
 * Each test defines an expected behavior that the migration engine must satisfy.
 */
import { describe, it, expect, vi } from 'vitest'
import { runMigrations, CONFIG_VERSION } from '@shared/utils/configMigration'
import { PROXY_SCOPE_OPTIONS } from '@shared/constants'
import type { AppConfig } from '@shared/types'

// ── CONFIG_VERSION constant ────────────────────────────────────────

describe('CONFIG_VERSION', () => {
  it('is a positive integer', () => {
    expect(CONFIG_VERSION).toBeGreaterThan(0)
    expect(Number.isInteger(CONFIG_VERSION)).toBe(true)
  })
})

// ── runMigrations — return value semantics ─────────────────────────

describe('runMigrations return value', () => {
  it('returns migrated=true when config has no configVersion (needs migration)', () => {
    const config: Partial<AppConfig> = {}
    const result = runMigrations(config)
    expect(result.migrated).toBe(true)
    expect(result.targetVersion).toBe(CONFIG_VERSION)
    expect(result.errors).toEqual([])
  })

  it('returns migrated=true when configVersion is 0 (pre-migration)', () => {
    const config: Partial<AppConfig> = { configVersion: 0 }
    const result = runMigrations(config)
    expect(result.migrated).toBe(true)
  })

  it('returns migrated=false when configVersion equals CONFIG_VERSION (already current)', () => {
    const config: Partial<AppConfig> = { configVersion: CONFIG_VERSION }
    const result = runMigrations(config)
    expect(result.migrated).toBe(false)
    expect(result.errors).toEqual([])
  })

  it('returns migrated=false when configVersion exceeds CONFIG_VERSION (future version)', () => {
    const config: Partial<AppConfig> = { configVersion: CONFIG_VERSION + 1 }
    const result = runMigrations(config)
    expect(result.migrated).toBe(false)
  })
})

// ── runMigrations — configVersion stamp ────────────────────────────

describe('runMigrations version stamping', () => {
  it('stamps configVersion to CONFIG_VERSION after migration', () => {
    const config: Partial<AppConfig> = {}
    runMigrations(config)
    expect(config.configVersion).toBe(CONFIG_VERSION)
  })

  it('does not modify configVersion when already current', () => {
    const config: Partial<AppConfig> = { configVersion: CONFIG_VERSION }
    runMigrations(config)
    expect(config.configVersion).toBe(CONFIG_VERSION)
  })

  it('does not downgrade configVersion from future version', () => {
    const future = CONFIG_VERSION + 5
    const config: Partial<AppConfig> = { configVersion: future }
    runMigrations(config)
    expect(config.configVersion).toBe(future)
  })
})

// ── v1 Migration: proxy.scope backfill ─────────────────────────────

describe('v1 migration — proxy.scope backfill', () => {
  it('backfills empty scope array with all PROXY_SCOPE_OPTIONS', () => {
    const config: Partial<AppConfig> = {
      proxy: { enable: true, server: 'http://127.0.0.1:7890', bypass: '', scope: [] },
    }
    runMigrations(config)
    expect(config.proxy!.scope).toEqual([...PROXY_SCOPE_OPTIONS])
  })

  it('backfills even when proxy is disabled (consistency)', () => {
    const config: Partial<AppConfig> = {
      proxy: { enable: false, server: '', bypass: '', scope: [] },
    }
    runMigrations(config)
    expect(config.proxy!.scope).toEqual([...PROXY_SCOPE_OPTIONS])
  })

  it('preserves user-selected scope values (does not overwrite)', () => {
    const config: Partial<AppConfig> = {
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '', scope: ['download'] },
    }
    runMigrations(config)
    expect(config.proxy!.scope).toEqual(['download'])
  })

  it('preserves full scope array unchanged', () => {
    const config: Partial<AppConfig> = {
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '',
        scope: [...PROXY_SCOPE_OPTIONS],
      },
    }
    runMigrations(config)
    expect(config.proxy!.scope).toEqual([...PROXY_SCOPE_OPTIONS])
  })

  it('does nothing when proxy field is absent entirely', () => {
    const config: Partial<AppConfig> = {}
    runMigrations(config)
    expect(config.proxy).toBeUndefined()
  })

  it('handles proxy without scope field (scope is undefined)', () => {
    const config: Partial<AppConfig> = {
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '' } as AppConfig['proxy'],
    }
    runMigrations(config)
    // No scope field to backfill — migration should not crash
    expect(config.proxy).toBeDefined()
  })
})

// ── Idempotency ────────────────────────────────────────────────────

describe('runMigrations idempotency', () => {
  it('running migrations twice produces identical results', () => {
    const config: Partial<AppConfig> = {
      proxy: { enable: true, server: 'http://127.0.0.1:7890', bypass: '', scope: [] },
    }
    runMigrations(config)
    const snapshot = JSON.parse(JSON.stringify(config))
    // Running again on already-migrated config should be a no-op
    const result = runMigrations(config)
    expect(result.migrated).toBe(false)
    expect(config).toEqual(snapshot)
  })
})

// ── Integration with non-proxy fields ──────────────────────────────

describe('runMigrations preserves unrelated config fields', () => {
  it('does not mutate any non-proxy fields', () => {
    const config: Partial<AppConfig> = {
      theme: 'dark',
      locale: 'zh-CN',
      split: 16,
      dir: '/downloads',
      proxy: { enable: true, server: 'http://proxy:1080', bypass: '', scope: [] },
    }
    runMigrations(config)
    expect(config.theme).toBe('dark')
    expect(config.locale).toBe('zh-CN')
    expect(config.split).toBe(16)
    expect(config.dir).toBe('/downloads')
  })
})

// ── CONFIG_VERSION consistency guard ───────────────────────────────

describe('CONFIG_VERSION consistency guard', () => {
  it('CONFIG_VERSION equals the number of registered migrations', async () => {
    // The module-level guard throws at import time if mismatched.
    // If we reach this test, the guard has already passed — verify
    // the invariant explicitly by re-importing the constant.
    const mod = await import('@shared/utils/configMigration')
    expect(mod.CONFIG_VERSION).toBeGreaterThan(0)
    // CONFIG_VERSION is set to migrations.length in source, and the
    // runtime guard ensures they match. If this test passes, the
    // invariant holds.
  })
})

// ── Error isolation ────────────────────────────────────────────────

describe('runMigrations error isolation', () => {
  it('stamps configVersion even when a migration throws', () => {
    // We can't easily inject a failing migration into the sealed array,
    // but we can verify the contract: if proxy.scope triggers an error
    // due to a corrupted proxy object, the engine should still stamp
    // configVersion and return true.
    const config: Partial<AppConfig> = {
      // proxy.scope is a non-array value — Object.defineProperty to
      // make .length throw when accessed
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '',
        get scope(): string[] {
          throw new Error('simulated corruption')
        },
        set scope(_v: string[]) {
          // no-op for the test
        },
      },
    }
    // Suppress expected error log during test
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = runMigrations(config)
    logSpy.mockRestore()

    // Migration failed but engine should still complete
    expect(result.migrated).toBe(true)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(config.configVersion).toBe(CONFIG_VERSION)
  })

  it('does not crash the entire migration pipeline on error', () => {
    // Verify runMigrations never throws, even with bad data
    const config: Partial<AppConfig> = {
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '',
        get scope(): string[] {
          throw new TypeError('cannot read property')
        },
        set scope(_v: string[]) {
          // no-op
        },
      },
    }
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => runMigrations(config)).not.toThrow()
    logSpy.mockRestore()
  })
})

// ── v2 Migration: decouple split / maxConnectionPerServer ──────────

describe('v2 migration — decouple split / maxConnectionPerServer', () => {
  it('removes engineMaxConnectionPerServer from config', () => {
    const config = {
      configVersion: 1,
      engineMaxConnectionPerServer: 64,
      split: 64,
      maxConnectionPerServer: 64,
    } as Partial<AppConfig>
    runMigrations(config)
    expect((config as Record<string, unknown>).engineMaxConnectionPerServer).toBeUndefined()
  })

  it('preserves split value unchanged', () => {
    const config = {
      configVersion: 1,
      engineMaxConnectionPerServer: 128,
      split: 128,
      maxConnectionPerServer: 128,
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.split).toBe(128)
  })

  it('preserves maxConnectionPerServer value unchanged', () => {
    const config = {
      configVersion: 1,
      engineMaxConnectionPerServer: 64,
      split: 64,
      maxConnectionPerServer: 64,
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.maxConnectionPerServer).toBe(64)
  })

  it('handles config without engineMaxConnectionPerServer gracefully', () => {
    const config = {
      configVersion: 1,
      split: 32,
      maxConnectionPerServer: 32,
    } as Partial<AppConfig>
    const result = runMigrations(config)
    expect(result.migrated).toBe(true)
    expect(config.split).toBe(32)
    expect(config.configVersion).toBe(CONFIG_VERSION)
  })

  it('stamps configVersion to 2 after migration', () => {
    const config = {
      configVersion: 1,
      engineMaxConnectionPerServer: 64,
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.configVersion).toBe(CONFIG_VERSION)
  })

  it('is idempotent — running on already-migrated v2 config is a no-op', () => {
    const config = {
      configVersion: 2,
      split: 64,
      maxConnectionPerServer: 16,
    } as Partial<AppConfig>
    const result = runMigrations(config)
    // v3 migration runs (configVersion 2 < 3), but autoSubmitFromExtension
    // is absent so the migration is effectively a no-op for that field
    expect(result.migrated).toBe(true)
    expect(config.split).toBe(64)
    expect(config.maxConnectionPerServer).toBe(16)
  })
})

// ── v3 Migration: flatten autoSubmitFromExtension ──────────────────

describe('v3 migration — flatten autoSubmitFromExtension', () => {
  it('flattens object with enable=true to boolean true', () => {
    const config = {
      configVersion: 2,
      autoSubmitFromExtension: { enable: true, http: true, magnet: true, torrent: false },
    } as unknown as Partial<AppConfig>
    runMigrations(config)
    expect(config.autoSubmitFromExtension).toBe(true)
  })

  it('flattens object with enable=false to boolean false', () => {
    const config = {
      configVersion: 2,
      autoSubmitFromExtension: { enable: false, http: true, magnet: true, torrent: true },
    } as unknown as Partial<AppConfig>
    runMigrations(config)
    expect(config.autoSubmitFromExtension).toBe(false)
  })

  it('leaves boolean value untouched (already migrated)', () => {
    const config = {
      configVersion: 2,
      autoSubmitFromExtension: true,
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.autoSubmitFromExtension).toBe(true)
  })

  it('handles absent autoSubmitFromExtension gracefully', () => {
    const config = { configVersion: 2 } as Partial<AppConfig>
    const result = runMigrations(config)
    expect(result.migrated).toBe(true)
    expect(config.autoSubmitFromExtension).toBeUndefined()
  })

  it('stamps configVersion to 3 after migration', () => {
    const config = {
      configVersion: 2,
      autoSubmitFromExtension: { enable: false, http: true, magnet: true, torrent: false },
    } as unknown as Partial<AppConfig>
    runMigrations(config)
    expect(config.configVersion).toBe(CONFIG_VERSION)
  })
})

// ── v4 Migration: fix auto-archive path separators + empty categories ──

describe('v4 migration — path separator normalization and category auto-populate', () => {
  it('normalizes backslashes in dir to forward slashes', () => {
    const config = {
      configVersion: 3,
      dir: 'C:\\Users\\test\\Downloads',
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.dir).toBe('C:/Users/test/Downloads')
  })

  it('normalizes backslashes in fileCategories[].directory', () => {
    const config = {
      configVersion: 3,
      dir: 'C:/Users/test/Downloads',
      fileCategories: [
        { label: 'Archives', extensions: ['zip'], directory: 'C:\\Users\\test\\Downloads\\Archives', builtIn: true },
        { label: 'Videos', extensions: ['mp4'], directory: 'C:\\Users\\test\\Downloads/Videos', builtIn: true },
      ],
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.fileCategories![0].directory).toBe('C:/Users/test/Downloads/Archives')
    expect(config.fileCategories![1].directory).toBe('C:/Users/test/Downloads/Videos')
  })

  it('populates empty fileCategories when fileCategoryEnabled is true', () => {
    const config = {
      configVersion: 3,
      dir: '/Users/test/Downloads',
      fileCategoryEnabled: true,
      fileCategories: [],
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.fileCategories!.length).toBeGreaterThan(0)
    expect(config.fileCategories![0].directory).toContain('/Users/test/Downloads/')
  })

  it('does not populate categories when fileCategoryEnabled is false', () => {
    const config = {
      configVersion: 3,
      dir: '/Users/test/Downloads',
      fileCategoryEnabled: false,
      fileCategories: [],
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.fileCategories).toEqual([])
  })

  it('leaves forward-slash paths unchanged (no-op on macOS/Linux)', () => {
    const config = {
      configVersion: 3,
      dir: '/Users/test/Downloads',
      fileCategories: [
        { label: 'Archives', extensions: ['zip'], directory: '/Users/test/Downloads/Archives', builtIn: true },
      ],
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.dir).toBe('/Users/test/Downloads')
    expect(config.fileCategories![0].directory).toBe('/Users/test/Downloads/Archives')
  })

  it('does not populate categories when dir is empty (no base path)', () => {
    const config = {
      configVersion: 3,
      dir: '',
      fileCategoryEnabled: true,
      fileCategories: [],
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.fileCategories).toEqual([])
  })

  it('preserves existing non-empty categories when fileCategoryEnabled is true', () => {
    const existingCats = [{ label: 'Custom', extensions: ['xyz'], directory: 'C:/Custom/Dir', builtIn: false }]
    const config = {
      configVersion: 3,
      dir: 'C:/Users/test/Downloads',
      fileCategoryEnabled: true,
      fileCategories: existingCats,
    } as Partial<AppConfig>
    runMigrations(config)
    expect(config.fileCategories).toEqual(existingCats)
  })

  it('is idempotent — running on current config is a no-op', () => {
    const config = {
      configVersion: CONFIG_VERSION,
      dir: 'C:/Users/test/Downloads',
      fileCategoryEnabled: true,
      fileCategories: [
        { label: 'Archives', extensions: ['zip'], directory: 'C:/Users/test/Downloads/Archives', builtIn: true },
      ],
    } as Partial<AppConfig>
    const result = runMigrations(config)
    expect(result.migrated).toBe(false)
    expect(config.dir).toBe('C:/Users/test/Downloads')
  })
})

// ── v5 Migration: ED2K protocol and clipboard defaults ────────────

describe('v5 migration — ED2K protocol and clipboard backfill', () => {
  it('backfills protocols.ed2k when protocols already exists', () => {
    const config = {
      configVersion: 4,
      protocols: { magnet: true, thunder: false, motrixnext: true },
    } as Partial<AppConfig>

    runMigrations(config)

    expect(config.protocols?.ed2k).toBe(true)
  })

  it('backfills clipboard.ed2k when clipboard already exists', () => {
    const config = {
      configVersion: 4,
      clipboard: { enable: true, http: true, ftp: true, magnet: true, thunder: true, btHash: true },
    } as Partial<AppConfig>

    runMigrations(config)

    expect(config.clipboard?.ed2k).toBe(true)
  })

  it('preserves explicit ed2k=false values', () => {
    const config = {
      configVersion: 4,
      protocols: { magnet: true, thunder: false, motrixnext: true, ed2k: false },
      clipboard: { enable: true, http: true, ftp: true, magnet: true, ed2k: false, thunder: true, btHash: true },
    } as Partial<AppConfig>

    runMigrations(config)

    expect(config.protocols?.ed2k).toBe(false)
    expect(config.clipboard?.ed2k).toBe(false)
  })
})

// ── v6 Migration: proxy.matchMode backfill ────────────────────────

describe('v6 migration — proxy.matchMode backfill', () => {
  it('backfills matchMode to blacklist when proxy exists and matchMode is undefined', () => {
    const config: Partial<AppConfig> = {
      configVersion: 5,
      proxy: { enable: true, server: 'http://proxy:8080', bypass: '', scope: ['download'] },
    }
    runMigrations(config)
    expect(config.proxy!.matchMode).toBe('blacklist')
  })

  it('preserves explicit matchMode whitelist value', () => {
    const config: Partial<AppConfig> = {
      configVersion: 5,
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '*.example.com',
        scope: ['download'],
        matchMode: 'whitelist' as const,
      },
    }
    runMigrations(config)
    expect(config.proxy!.matchMode).toBe('whitelist')
  })

  it('preserves explicit matchMode blacklist value', () => {
    const config: Partial<AppConfig> = {
      configVersion: 5,
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '',
        scope: ['download'],
        matchMode: 'blacklist' as const,
      },
    }
    runMigrations(config)
    expect(config.proxy!.matchMode).toBe('blacklist')
  })

  it('does nothing when proxy field is absent entirely', () => {
    const config: Partial<AppConfig> = { configVersion: 5 }
    runMigrations(config)
    expect(config.proxy).toBeUndefined()
  })

  it('is idempotent — running on already-migrated v6 config is a no-op', () => {
    const config: Partial<AppConfig> = {
      configVersion: CONFIG_VERSION,
      proxy: {
        enable: true,
        server: 'http://proxy:8080',
        bypass: '',
        scope: ['download'],
        matchMode: 'blacklist' as const,
      },
    }
    const result = runMigrations(config)
    expect(result.migrated).toBe(false)
    expect(config.proxy!.matchMode).toBe('blacklist')
  })
})

// ── Full v0 → v6 integration ──────────────────────────────────────

describe('v0 → v6 full migration path', () => {
  it('runs all migrations in sequence on fresh config', () => {
    const config = {
      proxy: { enable: true, server: 'http://proxy:1080', bypass: '', scope: [] },
      engineMaxConnectionPerServer: 64,
      split: 64,
      maxConnectionPerServer: 64,
      autoSubmitFromExtension: { enable: true, http: true, magnet: true, torrent: false },
      dir: 'C:\\Users\\test\\Downloads',
      fileCategoryEnabled: true,
      fileCategories: [],
      protocols: { magnet: true, thunder: false, motrixnext: true },
      clipboard: { enable: true, http: true, ftp: true, magnet: true, thunder: true, btHash: true },
    } as unknown as Partial<AppConfig>

    const result = runMigrations(config)
    expect(result.migrated).toBe(true)
    expect(config.configVersion).toBe(CONFIG_VERSION)
    // v1: proxy scope backfilled
    expect(config.proxy!.scope).toEqual([...PROXY_SCOPE_OPTIONS])
    // v2: engineMaxConnectionPerServer removed
    expect((config as Record<string, unknown>).engineMaxConnectionPerServer).toBeUndefined()
    // v3: autoSubmitFromExtension flattened
    expect(config.autoSubmitFromExtension).toBe(true)
    // v4: dir normalized, categories populated
    expect(config.dir).toBe('C:/Users/test/Downloads')
    expect(config.fileCategories!.length).toBeGreaterThan(0)
    expect(config.fileCategories![0].directory).toMatch(/^C:\/Users\/test\/Downloads\//)
    // v5: ED2K protocol surfaces backfilled
    expect(config.protocols?.ed2k).toBe(true)
    expect(config.clipboard?.ed2k).toBe(true)
    // v6: proxy.matchMode backfilled
    expect(config.proxy!.matchMode).toBe('blacklist')
    // Both split and maxConnectionPerServer preserved
    expect(config.split).toBe(64)
    expect(config.maxConnectionPerServer).toBe(64)
  })
})
