import { describe, expect, it } from 'vitest'
import { useUserAgentManager } from '../useUserAgentManager'
import type { UserAgentProfile, UserAgentRule } from '@shared/types'

const profiles: UserAgentProfile[] = [
  {
    id: 'quark',
    name: 'Quark Drive',
    value: 'QuarkUA/1.0',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'baidu',
    name: 'Baidu Netdisk',
    value: 'BaiduUA/1.0',
    createdAt: 2,
    updatedAt: 2,
  },
]

const rules: UserAgentRule[] = [
  {
    id: 'quark-rule',
    enabled: true,
    hostPattern: '*.quark.cn',
    profileId: 'quark',
    overridePlugin: false,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'baidu-rule',
    enabled: false,
    hostPattern: 'pan.baidu.com',
    profileId: 'baidu',
    overridePlugin: true,
    createdAt: 2,
    updatedAt: 2,
  },
]

function setup() {
  const manager = useUserAgentManager()
  manager.reset({ profiles, rules, recentProfileIds: ['quark', 'baidu'] })
  return manager
}

describe('useUserAgentManager', () => {
  it('keeps modal edits isolated from persisted input', () => {
    const manager = setup()

    if (!manager.selectedProfile.value) throw new Error('Expected a selected profile')
    manager.selectedProfile.value.name = 'Changed'

    expect(profiles[0].name).toBe('Quark Drive')
    expect(manager.payload().profiles[0].name).toBe('Changed')
  })

  it('protects profiles referenced by rules and cleans recent ids after deletion', () => {
    const manager = setup()

    expect(manager.removeProfile()).toBe(false)
    manager.rules.value = manager.rules.value.filter((rule) => rule.profileId !== 'quark')
    expect(manager.removeProfile()).toBe(true)
    expect(manager.profiles.value.map((profile) => profile.id)).toEqual(['baidu'])
    expect(manager.payload().recentProfileIds).toEqual(['baidu'])
  })

  it('reorders rules without changing the selected rule', () => {
    const manager = setup()
    manager.selectRule('quark-rule')

    manager.moveRule(0, 1)

    expect(manager.rules.value.map((rule) => rule.id)).toEqual(['baidu-rule', 'quark-rule'])
    expect(manager.selectedRuleId.value).toBe('quark-rule')
  })

  it('selects the first invalid draft for inline recovery', () => {
    const manager = setup()
    manager.profiles.value[1].value = ''

    expect(manager.validate()).toEqual({ kind: 'profile', id: 'baidu' })
    expect(manager.activePanel.value).toBe('profiles')
    expect(manager.selectedProfileId.value).toBe('baidu')
    expect(manager.validationRequested.value).toBe(true)
  })

  it('normalizes valid values and preserves rule precedence order', () => {
    const manager = setup()
    manager.profiles.value[0].name = '  Quark Drive  '
    manager.profiles.value[0].value = 'QuarkUA/1.0\r\n'
    manager.rules.value[0].hostPattern = '*.QUARK.CN '

    expect(manager.validate()).toBeNull()
    expect(manager.payload()).toMatchObject({
      profiles: [{ name: 'Quark Drive', value: 'QuarkUA/1.0' }, { name: 'Baidu Netdisk' }],
      rules: [{ id: 'quark-rule', hostPattern: '*.quark.cn' }, { id: 'baidu-rule' }],
    })
  })
})
