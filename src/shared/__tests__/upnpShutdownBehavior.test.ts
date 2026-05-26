import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LIB_SOURCE = readFileSync(resolve(process.cwd(), 'src-tauri/src/lib.rs'), 'utf-8')

describe('UPnP shutdown behavior', () => {
  it('wraps stop_mapping in a timeout on app exit', () => {
    const exitIdx = LIB_SOURCE.indexOf('tauri::RunEvent::Exit =>')
    expect(exitIdx).toBeGreaterThanOrEqual(0)
    const exitSnippet = LIB_SOURCE.slice(exitIdx)
    const stopMappingIdx = exitSnippet.indexOf('upnp::stop_mapping')
    expect(stopMappingIdx).toBeGreaterThanOrEqual(0)

    const upnpCleanupSnippet = exitSnippet.slice(Math.max(0, stopMappingIdx - 240), stopMappingIdx + 240)
    expect(upnpCleanupSnippet).toContain('tokio::time::timeout(')
  })
})
