import { describe, expect, it } from 'vitest'
import { normalizeHttpAuthOrigin } from '@shared/utils/httpAuth'

describe('normalizeHttpAuthOrigin', () => {
  it('normalizes HTTP and HTTPS origins without path, query, hash, or credentials', () => {
    expect(normalizeHttpAuthOrigin('https://User:Pass@Files.Example.com:443/private/file.zip?token=1#top')).toBe(
      'https://files.example.com',
    )
    expect(normalizeHttpAuthOrigin('http://Files.Example.com:8080/path/file.zip')).toBe('http://files.example.com:8080')
  })

  it('rejects unsupported URL schemes and invalid URLs', () => {
    expect(normalizeHttpAuthOrigin('magnet:?xt=urn:btih:abc')).toBeNull()
    expect(normalizeHttpAuthOrigin('not a url')).toBeNull()
  })
})
