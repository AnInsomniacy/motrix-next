import { describe, expect, it } from 'vitest'
import { buildBtForm, buildBtSystemConfig, transformBtForStore, validateBtEndpoint } from '../useBtPreference'
import { createDefaultAppConfig } from '@shared/utils/configHydration'

const createForm = () => buildBtForm(createDefaultAppConfig())

describe('BitTorrent preference contract', () => {
  it('builds the canonical default form', () => {
    const form = createForm()

    expect(form.magnetFileSelectionPolicy).toBe('prompt')
    expect(form.btEncryption).toBe('preferred')
    expect(form.btDhtEnabled).toBe(true)
    expect(form.trackerSource).toHaveLength(2)
  })

  it('maps the form to native engine options', () => {
    const config = buildBtSystemConfig({
      ...createForm(),
      btTracker: 'udp://one.example:6969\nudp://two.example:6969',
    })

    expect(config).toMatchObject({
      'bt-encryption': 'preferred',
      'bt-transport': 'both',
      'bt-user-agent': 'qBittorrent/5.2.3',
      'bt-peer-id-prefix': '-qB5230-',
      'enable-dht': 'true',
      'pause-metadata': 'true',
      'bt-tracker': 'udp://one.example:6969,udp://two.example:6969',
    })
    expect(config).not.toHaveProperty('force-save')
    expect(config).not.toHaveProperty('bt-save-metadata')
    expect(config).not.toHaveProperty('trackerSource')
  })

  it('persists application-owned settings without UI-only fields', () => {
    const stored = transformBtForStore({
      ...createForm(),
      magnetFileSelectionPolicy: 'manual',
      btTracker: 'udp://one.example:6969\nudp://two.example:6969',
    })

    expect(stored.magnetFileSelectionPolicy).toBe('manual')
    expect(stored.btTracker).toBe('udp://one.example:6969,udp://two.example:6969')
  })

  it('rejects invalid local and external endpoints', () => {
    const form = createForm()

    expect(validateBtEndpoint(form)).toBeNull()
    expect(validateBtEndpoint({ ...form, listenPort: 80 })).toBe('preferences.bt-port-unavailable')
    expect(validateBtEndpoint({ ...form, btExternalIp: 'tracker.example.com' })).toBe(
      'preferences.bt-external-ip-invalid',
    )
    expect(validateBtEndpoint({ ...form, btExternalPort: 65536 })).toBe('preferences.bt-external-port-invalid')
  })
})
