/** @fileoverview Draft state and validation for the User-Agent manager. */
import { computed, ref } from 'vue'
import type { UserAgentProfile, UserAgentRule } from '@shared/types'
import { sanitizeHeaderValue } from '@shared/utils/headerSanitize'
import {
  isValidUserAgentHostPattern,
  MAX_USER_AGENT_PROFILES,
  MAX_USER_AGENT_RULES,
} from '@shared/utils/userAgentPolicy'

export type UserAgentManagerPanel = 'profiles' | 'rules'

export interface UserAgentManagerPayload {
  profiles: UserAgentProfile[]
  rules: UserAgentRule[]
  recentProfileIds: string[]
}

export type UserAgentManagerValidationError = { kind: 'profile'; id: string } | { kind: 'rule'; id: string }

function cloneProfiles(profiles: readonly UserAgentProfile[]): UserAgentProfile[] {
  return profiles.map((profile) => ({ ...profile }))
}

function cloneRules(rules: readonly UserAgentRule[]): UserAgentRule[] {
  return rules.map((rule) => ({ ...rule }))
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function useUserAgentManager() {
  const profiles = ref<UserAgentProfile[]>([])
  const rules = ref<UserAgentRule[]>([])
  const recentProfileIds = ref<string[]>([])
  const activePanel = ref<UserAgentManagerPanel>('profiles')
  const selectedProfileId = ref('')
  const selectedRuleId = ref('')
  const validationRequested = ref(false)

  const selectedProfile = computed(() => profiles.value.find((profile) => profile.id === selectedProfileId.value))
  const selectedRule = computed(() => rules.value.find((rule) => rule.id === selectedRuleId.value))
  const profileOptions = computed(() =>
    profiles.value.map((profile) => ({
      label: profile.name || 'User-Agent',
      value: profile.id,
    })),
  )
  const canAddProfile = computed(() => profiles.value.length < MAX_USER_AGENT_PROFILES)
  const canAddRule = computed(() => profiles.value.length > 0 && rules.value.length < MAX_USER_AGENT_RULES)

  function reset(payload: UserAgentManagerPayload): void {
    profiles.value = cloneProfiles(payload.profiles)
    rules.value = cloneRules(payload.rules)
    recentProfileIds.value = [...payload.recentProfileIds]
    activePanel.value = 'profiles'
    selectedProfileId.value = profiles.value[0]?.id ?? ''
    selectedRuleId.value = rules.value[0]?.id ?? ''
    validationRequested.value = false
  }

  function selectProfile(id: string): void {
    activePanel.value = 'profiles'
    selectedProfileId.value = id
  }

  function selectRule(id: string): void {
    activePanel.value = 'rules'
    selectedRuleId.value = id
  }

  function addProfile(defaultName: string): void {
    if (!canAddProfile.value) return
    const now = Date.now()
    const profile: UserAgentProfile = {
      id: createId('ua'),
      name: defaultName,
      value: '',
      createdAt: now,
      updatedAt: now,
    }
    profiles.value.push(profile)
    validationRequested.value = false
    selectProfile(profile.id)
  }

  function addRule(): void {
    if (!canAddRule.value) return
    const now = Date.now()
    const rule: UserAgentRule = {
      id: createId('ua-rule'),
      enabled: true,
      hostPattern: '',
      profileId: profiles.value[0].id,
      overridePlugin: false,
      createdAt: now,
      updatedAt: now,
    }
    rules.value.push(rule)
    validationRequested.value = false
    selectRule(rule.id)
  }

  function profileRuleCount(id: string): number {
    return rules.value.filter((rule) => rule.profileId === id).length
  }

  function removeProfile(): boolean {
    const index = profiles.value.findIndex((profile) => profile.id === selectedProfileId.value)
    if (index < 0 || profileRuleCount(selectedProfileId.value) > 0) return false
    const [removed] = profiles.value.splice(index, 1)
    recentProfileIds.value = recentProfileIds.value.filter((id) => id !== removed.id)
    selectedProfileId.value = profiles.value[Math.min(index, profiles.value.length - 1)]?.id ?? ''
    validationRequested.value = false
    return true
  }

  function removeRule(): void {
    const index = rules.value.findIndex((rule) => rule.id === selectedRuleId.value)
    if (index < 0) return
    rules.value.splice(index, 1)
    selectedRuleId.value = rules.value[Math.min(index, rules.value.length - 1)]?.id ?? ''
    validationRequested.value = false
  }

  function moveRule(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= rules.value.length || to >= rules.value.length) return
    const [rule] = rules.value.splice(from, 1)
    rules.value.splice(to, 0, rule)
  }

  function validate(): UserAgentManagerValidationError | null {
    validationRequested.value = true
    for (const profile of profiles.value) {
      const name = profile.name.trim()
      const value = sanitizeHeaderValue(profile.value)
      if (!name || !value) {
        selectProfile(profile.id)
        return { kind: 'profile', id: profile.id }
      }
      if (name !== profile.name || value !== profile.value) {
        profile.name = name
        profile.value = value
        profile.updatedAt = Date.now()
      }
    }

    const profileIds = new Set(profiles.value.map((profile) => profile.id))
    for (const rule of rules.value) {
      const hostPattern = rule.hostPattern.trim().toLowerCase()
      if (!isValidUserAgentHostPattern(hostPattern) || !profileIds.has(rule.profileId)) {
        selectRule(rule.id)
        return { kind: 'rule', id: rule.id }
      }
      if (hostPattern !== rule.hostPattern) {
        rule.hostPattern = hostPattern
        rule.updatedAt = Date.now()
      }
    }
    return null
  }

  function payload(): UserAgentManagerPayload {
    return {
      profiles: cloneProfiles(profiles.value),
      rules: cloneRules(rules.value),
      recentProfileIds: [...recentProfileIds.value],
    }
  }

  return {
    profiles,
    rules,
    activePanel,
    selectedProfileId,
    selectedRuleId,
    selectedProfile,
    selectedRule,
    profileOptions,
    canAddProfile,
    canAddRule,
    validationRequested,
    reset,
    selectProfile,
    selectRule,
    addProfile,
    addRule,
    profileRuleCount,
    removeProfile,
    removeRule,
    moveRule,
    validate,
    payload,
  }
}
