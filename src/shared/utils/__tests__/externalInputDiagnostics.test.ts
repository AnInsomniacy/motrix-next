/** @fileoverview Tests for privacy-preserving external input diagnostics. */
import { describe, expect, it } from 'vitest'
import {
  summarizeAria2Options,
  summarizeExternalInput,
  summarizeExternalInputBatch,
  summarizeHeaderForwarding,
} from '../externalInputDiagnostics'

describe('externalInputDiagnostics', () => {
  it('summarizes URLs without disclosing query credentials', () => {
    const summary = summarizeExternalInput('https://example.com/file.zip?token=private-token')
    expect(summary).toContain('scheme=https host=example.com ext=zip hasQuery=true')
    expect(summary).not.toContain('private-token')
    const batch = summarizeExternalInputBatch(['https://example.com/file.zip?cookie=private-cookie'])
    expect(batch.count).toBe(1)
    expect(String(batch.first)).not.toContain('private-cookie')
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
