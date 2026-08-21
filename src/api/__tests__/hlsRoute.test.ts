/**
 * @fileoverview Tests for HLS/aria2 GID routing helpers used by the API layer.
 */
import { describe, expect, it } from 'vitest'
import { splitGids } from '@shared/utils/hls'

const HLS_A = 'hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HLS_B = 'hls-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ARIA2_A = '0123456789abcdef'
const ARIA2_B = 'fedcba9876543210'

describe('splitGids', () => {
  it('returns empty buckets for an empty list', () => {
    expect(splitGids([])).toEqual({ hls: [], aria2: [] })
  })

  it('places HLS gids in hls and remaining gids in aria2', () => {
    expect(splitGids([ARIA2_A, HLS_A])).toEqual({
      hls: [HLS_A],
      aria2: [ARIA2_A],
    })
  })

  it('preserves encounter order within each bucket', () => {
    expect(splitGids([ARIA2_B, HLS_B, ARIA2_A, HLS_A])).toEqual({
      hls: [HLS_B, HLS_A],
      aria2: [ARIA2_B, ARIA2_A],
    })
  })

  it('leaves the unused bucket empty for homogeneous lists', () => {
    expect(splitGids([HLS_A, HLS_B])).toEqual({ hls: [HLS_A, HLS_B], aria2: [] })
    expect(splitGids([ARIA2_A])).toEqual({ hls: [], aria2: [ARIA2_A] })
  })
})
