import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import { NUMERIC_CONFIG_CONSTRAINTS, validateAppConfigCandidate } from '@shared/configConstraints'

describe('numeric config contract', () => {
  it('accepts factory defaults and rejects invalid engine settings', () => {
    expect(validateAppConfigCandidate(DEFAULT_APP_CONFIG)).toEqual([])

    const invalid = validateAppConfigCandidate({
      ...DEFAULT_APP_CONFIG,
      streamMaxConnections: NUMERIC_CONFIG_CONSTRAINTS.streamMaxConnections.max + 1,
      rpcListenPort: NUMERIC_CONFIG_CONSTRAINTS.rpcListenPort.min - 1,
      btMaxUploads: NUMERIC_CONFIG_CONSTRAINTS.btMaxUploads.max + 1,
    })

    expect(invalid.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['streamMaxConnections', 'rpcListenPort', 'btMaxUploads']),
    )
  })
})
