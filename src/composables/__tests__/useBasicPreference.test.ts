/**
 * @fileoverview Tests for useBasicPreference pure functions.
 *
 * Key business logic: btAutoDownloadContent ↔ followTorrent/followMetalink/pauseMetadata.
 * This is the most important mapping to test — it bridges a single UI toggle
 * to three separate aria2 engine options.
 */
import { describe, it, expect } from 'vitest'
import { buildBasicForm, buildBasicSystemConfig, transformBasicForStore, type BasicForm } from '../useBasicPreference'
import type { AppConfig } from '@shared/types'

// ── buildBasicForm ──────────────────────────────────────────────────

describe('buildBasicForm', () => {
  const emptyConfig = {} as AppConfig

  it('returns sensible defaults for empty config', () => {
    const form = buildBasicForm(emptyConfig)
    expect(form.autoCheckUpdate).toBe(true)
    expect(form.autoCheckUpdateInterval).toBe(24)
    expect(form.updateChannel).toBe('stable')
    expect(form.locale).toBe('en-US')
    expect(form.theme).toBe('auto')
    expect(form.maxConcurrentDownloads).toBe(5)
    expect(form.maxConnectionPerServer).toBe(16)
    expect(form.keepSeeding).toBe(false)
    expect(form.seedRatio).toBe(1)
    expect(form.seedTime).toBe(60)
    expect(form.continue).toBe(true)
  })

  it('defaults btAutoDownloadContent to false (pause-metadata=true for file selection)', () => {
    const form = buildBasicForm(emptyConfig)
    expect(form.btAutoDownloadContent).toBe(false)
  })

  it('uses defaultDir when config.dir is empty', () => {
    const form = buildBasicForm(emptyConfig, '~/Downloads')
    expect(form.dir).toBe('~/Downloads')
  })

  it('prefers config.dir over defaultDir', () => {
    const form = buildBasicForm({ dir: '/custom' } as AppConfig, '~/Downloads')
    expect(form.dir).toBe('/custom')
  })

  it('sets btAutoDownloadContent=true when follow=true and pause=false', () => {
    const form = buildBasicForm({
      followTorrent: true,
      followMetalink: true,
      pauseMetadata: false,
    } as unknown as AppConfig)
    expect(form.btAutoDownloadContent).toBe(true)
  })

  it('sets btAutoDownloadContent=false when followTorrent=false', () => {
    const form = buildBasicForm({
      followTorrent: false,
      followMetalink: true,
      pauseMetadata: false,
    } as unknown as AppConfig)
    expect(form.btAutoDownloadContent).toBe(false)
  })

  it('sets btAutoDownloadContent=false when pauseMetadata=true', () => {
    const form = buildBasicForm({
      followTorrent: true,
      followMetalink: true,
      pauseMetadata: true,
    } as unknown as AppConfig)
    expect(form.btAutoDownloadContent).toBe(false)
  })

  it('handles theme undefined → auto', () => {
    const form = buildBasicForm({ theme: undefined } as unknown as AppConfig)
    expect(form.theme).toBe('auto')
  })

  it('preserves theme null → auto via nullish coalescing', () => {
    const form = buildBasicForm({ theme: null } as unknown as AppConfig)
    expect(form.theme).toBe('auto')
  })

  it('formats speed limits as strings', () => {
    const form = buildBasicForm({
      maxOverallDownloadLimit: 1024,
      maxOverallUploadLimit: 512,
    } as unknown as AppConfig)
    expect(form.maxOverallDownloadLimit).toBe('1024')
    expect(form.maxOverallUploadLimit).toBe('512')
  })
})

// ── buildBasicSystemConfig ──────────────────────────────────────────

describe('buildBasicSystemConfig', () => {
  const baseForm: BasicForm = {
    autoCheckUpdate: true,
    autoCheckUpdateInterval: 24,
    lastCheckUpdateTime: 0,
    updateChannel: 'stable',
    dir: '/downloads',
    locale: 'en-US',
    theme: 'auto',
    openAtLogin: false,
    keepWindowState: false,
    resumeAllWhenAppLaunched: false,
    autoHideWindow: false,
    minimizeToTrayOnClose: false,
    hideDockOnMinimize: false,
    showProgressBar: false,
    traySpeedometer: false,
    dockBadgeSpeed: true,
    taskNotification: true,
    newTaskShowDownloading: true,
    noConfirmBeforeDeleteTask: false,
    maxConcurrentDownloads: 5,
    maxConnectionPerServer: 16,
    maxOverallDownloadLimit: '0',
    maxOverallUploadLimit: '0',
    btSaveMetadata: false,
    btAutoDownloadContent: true,
    btForceEncryption: false,
    keepSeeding: true,
    seedRatio: 1,
    seedTime: 60,
    continue: true,
    deleteTorrentAfterComplete: false,
    autoDeleteStaleRecords: false,
  }

  it('maps all required aria2 config keys', () => {
    const config = buildBasicSystemConfig(baseForm)
    expect(config.dir).toBe('/downloads')
    expect(config['max-concurrent-downloads']).toBe('5')
    expect(config['max-connection-per-server']).toBe('16')
    expect(config['seed-ratio']).toBe('1')
    expect(config['seed-time']).toBe('60')
    expect(config.continue).toBe('true')
  })

  it('sets follow-torrent=true and pause-metadata=false when auto-content ON', () => {
    const config = buildBasicSystemConfig({ ...baseForm, btAutoDownloadContent: true })
    expect(config['follow-torrent']).toBe('true')
    expect(config['follow-metalink']).toBe('true')
    expect(config['pause-metadata']).toBe('false')
  })

  it('sets follow-torrent=false and pause-metadata=true when auto-content OFF', () => {
    const config = buildBasicSystemConfig({ ...baseForm, btAutoDownloadContent: false })
    expect(config['follow-torrent']).toBe('false')
    expect(config['follow-metalink']).toBe('false')
    expect(config['pause-metadata']).toBe('true')
  })
})

// ── transformBasicForStore ──────────────────────────────────────────

describe('transformBasicForStore', () => {
  const baseForm: BasicForm = {
    autoCheckUpdate: true,
    autoCheckUpdateInterval: 24,
    lastCheckUpdateTime: 0,
    updateChannel: 'stable',
    dir: '/dl',
    locale: 'en-US',
    theme: 'auto',
    openAtLogin: false,
    keepWindowState: false,
    resumeAllWhenAppLaunched: false,
    autoHideWindow: false,
    minimizeToTrayOnClose: false,
    hideDockOnMinimize: false,
    showProgressBar: false,
    traySpeedometer: false,
    dockBadgeSpeed: true,
    taskNotification: true,
    newTaskShowDownloading: true,
    noConfirmBeforeDeleteTask: false,
    maxConcurrentDownloads: 5,
    maxConnectionPerServer: 16,
    maxOverallDownloadLimit: '0',
    maxOverallUploadLimit: '0',
    btSaveMetadata: false,
    btAutoDownloadContent: true,
    btForceEncryption: false,
    keepSeeding: true,
    seedRatio: 1,
    seedTime: 60,
    continue: true,
    deleteTorrentAfterComplete: false,
    autoDeleteStaleRecords: false,
  }

  it('expands btAutoDownloadContent=true into follow+resume', () => {
    const result = transformBasicForStore({ ...baseForm, btAutoDownloadContent: true })
    expect(result.followTorrent).toBe(true)
    expect(result.followMetalink).toBe(true)
    expect(result.pauseMetadata).toBe(false)
    expect((result as Record<string, unknown>).btAutoDownloadContent).toBeUndefined()
  })

  it('expands btAutoDownloadContent=false into stop+pause', () => {
    const result = transformBasicForStore({ ...baseForm, btAutoDownloadContent: false })
    expect(result.followTorrent).toBe(false)
    expect(result.followMetalink).toBe(false)
    expect(result.pauseMetadata).toBe(true)
    expect((result as Record<string, unknown>).btAutoDownloadContent).toBeUndefined()
  })

  it('removes btAutoDownloadContent from output', () => {
    const result = transformBasicForStore(baseForm)
    expect('btAutoDownloadContent' in result).toBe(false)
  })
})
