import picomatch from 'picomatch'
import type { ExternalDownloadContext, UserAgentProfile, UserAgentRule } from '@shared/types'
import { sanitizeSingleHeaderValue } from './headerSanitize'

export const MAX_USER_AGENT_PROFILES = 64
export const MAX_USER_AGENT_RULES = 128
const MAX_RECENT_USER_AGENT_PROFILES = 5
const HOST_PATTERN_RE = /^(?:\*\.)?[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/

export type UserAgentSource = 'manual' | 'plugin' | 'rule' | 'default' | 'empty'

export interface UserAgentResolutionInput {
  manualUserAgent?: string
  pluginUserAgent?: string
  defaultUserAgent?: string
  url?: string
  finalUrl?: string
  referer?: string
  profiles: readonly UserAgentProfile[]
  rules: readonly UserAgentRule[]
}

export interface UserAgentResolution {
  userAgent: string
  source: UserAgentSource
  profileId?: string
  ruleId?: string
}

export interface UserAgentRuleMatchInput {
  url?: string
  finalUrl?: string
  referer?: string
  profiles: readonly UserAgentProfile[]
  rules: readonly UserAgentRule[]
}

export interface UserAgentRuleMatch {
  rule: UserAgentRule
  profile: UserAgentProfile
  host: string
}

export type UserAgentSelectionSection = 'matched' | 'recent' | 'saved'

export interface UserAgentSelectionItem {
  section: UserAgentSelectionSection
  profile: UserAgentProfile
  rule?: UserAgentRule
}

export interface UserAgentSelectionInput extends UserAgentRuleMatchInput {
  recentProfileIds: readonly string[]
  maxRecent?: number
}

function nowTimestamp(value: unknown): number {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function isValidUserAgentHostPattern(pattern: string): boolean {
  const trimmed = pattern.trim().toLowerCase()
  return HOST_PATTERN_RE.test(trimmed) && !trimmed.includes('..')
}

export function normalizeUserAgentProfiles(value: unknown): UserAgentProfile[] {
  if (!Array.isArray(value)) return []
  const result: UserAgentProfile[] = []
  const seen = new Set<string>()

  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = normalizeId(record.id)
    const name = normalizeName(record.name)
    const userAgent = sanitizeSingleHeaderValue(typeof record.value === 'string' ? record.value : '')
    if (!id || !name || !userAgent || seen.has(id)) continue

    seen.add(id)
    result.push({
      id,
      name,
      value: userAgent,
      createdAt: nowTimestamp(record.createdAt),
      updatedAt: nowTimestamp(record.updatedAt),
    })
    if (result.length >= MAX_USER_AGENT_PROFILES) break
  }

  return result
}

export function normalizeUserAgentRules(value: unknown, profiles: readonly UserAgentProfile[]): UserAgentRule[] {
  if (!Array.isArray(value)) return []
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const result: UserAgentRule[] = []
  const seen = new Set<string>()

  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = normalizeId(record.id)
    const hostPattern = typeof record.hostPattern === 'string' ? record.hostPattern.trim().toLowerCase() : ''
    const profileId = normalizeId(record.profileId)
    if (!id || seen.has(id) || !profileIds.has(profileId) || !isValidUserAgentHostPattern(hostPattern)) continue

    seen.add(id)
    result.push({
      id,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
      hostPattern,
      profileId,
      overridePlugin: typeof record.overridePlugin === 'boolean' ? record.overridePlugin : false,
      createdAt: nowTimestamp(record.createdAt),
      updatedAt: nowTimestamp(record.updatedAt),
    })
    if (result.length >= MAX_USER_AGENT_RULES) break
  }

  return result
}

export function normalizeRecentUserAgentProfileIds(value: unknown, profiles: readonly UserAgentProfile[]): string[] {
  if (!Array.isArray(value)) return []
  const profileIds = new Set(profiles.map((profile) => profile.id))
  const seen = new Set<string>()
  const result: string[] = []

  for (const item of value) {
    const id = normalizeId(item)
    if (!id || seen.has(id) || !profileIds.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length >= MAX_RECENT_USER_AGENT_PROFILES) break
  }

  return result
}

function extractHost(value: string | undefined): string {
  if (!value) return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function collectCandidateHosts(input: Pick<UserAgentRuleMatchInput, 'url' | 'finalUrl' | 'referer'>): string[] {
  const hosts: string[] = []
  const seen = new Set<string>()
  for (const host of [extractHost(input.finalUrl), extractHost(input.url), extractHost(input.referer)]) {
    if (!host || seen.has(host)) continue
    seen.add(host)
    hosts.push(host)
  }
  return hosts
}

function hostMatches(pattern: string, host: string): boolean {
  return picomatch.isMatch(host, pattern, { nocase: true })
}

export function findMatchingUserAgentRule(input: UserAgentRuleMatchInput): UserAgentRuleMatch | null {
  const profiles = normalizeUserAgentProfiles(input.profiles)
  const rules = normalizeUserAgentRules(input.rules, profiles)
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
  const hosts = collectCandidateHosts(input)

  for (const rule of rules) {
    if (!rule.enabled) continue
    const profile = profileById.get(rule.profileId)
    if (!profile) continue
    const host = hosts.find((candidate) => hostMatches(rule.hostPattern, candidate))
    if (host) return { rule, profile, host }
  }

  return null
}

export function resolveUserAgent(input: UserAgentResolutionInput): UserAgentResolution {
  const manualUserAgent = sanitizeSingleHeaderValue(input.manualUserAgent)
  if (manualUserAgent) return { userAgent: manualUserAgent, source: 'manual' }

  const pluginUserAgent = sanitizeSingleHeaderValue(input.pluginUserAgent)
  const match = findMatchingUserAgentRule(input)
  if (match?.rule.overridePlugin) {
    return {
      userAgent: match.profile.value,
      source: 'rule',
      profileId: match.profile.id,
      ruleId: match.rule.id,
    }
  }

  if (pluginUserAgent) return { userAgent: pluginUserAgent, source: 'plugin' }

  if (match) {
    return {
      userAgent: match.profile.value,
      source: 'rule',
      profileId: match.profile.id,
      ruleId: match.rule.id,
    }
  }

  const defaultUserAgent = sanitizeSingleHeaderValue(input.defaultUserAgent)
  if (defaultUserAgent) return { userAgent: defaultUserAgent, source: 'default' }
  return { userAgent: '', source: 'empty' }
}

export function resolveUserAgentFromContext(input: {
  formUserAgent?: string
  context?: ExternalDownloadContext
  url?: string
  finalUrl?: string
  defaultUserAgent?: string
  profiles: readonly UserAgentProfile[]
  rules: readonly UserAgentRule[]
}): UserAgentResolution {
  return resolveUserAgent({
    manualUserAgent: input.formUserAgent,
    pluginUserAgent: input.context?.userAgent,
    defaultUserAgent: input.defaultUserAgent,
    url: input.url,
    finalUrl: input.finalUrl,
    referer: input.context?.referer,
    profiles: input.profiles,
    rules: input.rules,
  })
}

export function buildUserAgentSelectionItems(input: UserAgentSelectionInput): UserAgentSelectionItem[] {
  const profiles = normalizeUserAgentProfiles(input.profiles)
  const rules = normalizeUserAgentRules(input.rules, profiles)
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
  const result: UserAgentSelectionItem[] = []
  const seen = new Set<string>()
  const match = findMatchingUserAgentRule({ ...input, profiles, rules })

  if (match) {
    result.push({ section: 'matched', profile: match.profile, rule: match.rule })
    seen.add(match.profile.id)
  }

  for (const id of normalizeRecentUserAgentProfileIds(input.recentProfileIds, profiles)) {
    if (seen.has(id)) continue
    const profile = profileById.get(id)
    if (!profile) continue
    result.push({ section: 'recent', profile })
    seen.add(id)
    const recentCount = result.filter((item) => item.section === 'recent').length
    if (recentCount >= (input.maxRecent ?? MAX_RECENT_USER_AGENT_PROFILES)) break
  }

  const remainingProfiles = profiles
    .filter((profile) => !seen.has(profile.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  for (const profile of remainingProfiles) {
    result.push({ section: 'saved', profile })
  }

  return result
}

export function recordRecentUserAgentProfileId(
  current: readonly string[],
  profileId: string,
  profiles: readonly UserAgentProfile[],
): string[] {
  return normalizeRecentUserAgentProfileIds([profileId, ...current.filter((id) => id !== profileId)], profiles)
}
