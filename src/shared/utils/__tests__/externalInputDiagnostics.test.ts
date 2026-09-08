/** @fileoverview Tests for privacy-preserving external input diagnostics. */
import { describe, expect, it } from 'vitest'
import {
  summarizeAria2Options,
  summarizeExternalInput,
  summarizeExternalInputBatch,
  summarizeHeaderForwarding,
} from '../externalInputDiagnostics'

describe('externalInputDiagnostics', () => {
  it('summarizes motrixnext deep-links without leaking cookie or query values', () => {
    const summary = summarizeExternalInput(
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Fdownload%2Ffile.zip%3Ftoken%3Dsecret-token&cookie=session%3Dsecret-cookie&filename=file.zip',
    )

    expect(summary).toContain('scheme=motrixnext')
    expect(summary).toContain('target=scheme=https host=example.com ext=zip hasQuery=true')
    expect(summary).toContain('hasCookie=true')
    expect(summary).not.toContain('secret-token')
    expect(summary).not.toContain('secret-cookie')
  })

  it('summarizes batches with counts and first-input metadata only', () => {
    const fields = summarizeExternalInputBatch([
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip&cookie=session%3Dsecret-cookie',
    ])

    expect(fields.count).toBe(1)
    expect(fields.hasNewTask).toBe(true)
    expect(fields.hasCookie).toBe(true)
    expect(String(fields.first)).not.toContain('secret-cookie')
  })

  it('uses the same new-task detection for single-slash Motrix deep links', () => {
    const fields = summarizeExternalInputBatch(['motrixnext:/new?url=https%3A%2F%2Fexample.com%2Ffile.zip'])

    expect(fields.hasNewTask).toBe(true)
    expect(String(fields.first)).toContain('action=new')
  })

  it('summarizes forwarded browser headers without logging values', () => {
    const fields = summarizeHeaderForwarding({
      inputCount: 4,
      keptCount: 2,
      droppedCount: 2,
      keptNames: ['Accept', 'DNT'],
      droppedReasons: ['forbidden', 'unsafe-value'],
    })

    expect(fields).toEqual({
      headerInputCount: 4,
      headerKeptCount: 2,
      headerDroppedCount: 2,
      headerKeptNames: 'Accept,DNT',
      headerDroppedReasons: 'forbidden,unsafe-value',
    })
  })

  it('summarizes aria2 options without leaking cookies or authorization values', () => {
    const fields = summarizeAria2Options({
      dir: '/downloads',
      'stream-max-connections': '16',
      'user-agent': 'BrowserUA/1.0',
      referer: 'https://example.com/page?token=secret',
      header: ['Accept: application/octet-stream', 'Cookie: session=secret', 'Authorization: Bearer secret'],
    })

    expect(fields).toEqual({
      hasUserAgent: true,
      hasReferer: true,
      headerCount: 3,
      headerNames: 'Accept,Cookie,Authorization',
      hasCookieHeader: true,
      hasAuthorizationHeader: true,
    })
    expect(JSON.stringify(fields)).not.toContain('secret')
    expect(JSON.stringify(fields)).not.toContain('BrowserUA')
    expect(JSON.stringify(fields)).not.toContain('/downloads')
  })
})
