/** @fileoverview Config key conversion, diffing, and engine option formatting. */
import { camelCase, isEmpty, kebabCase, omitBy, pick, isEqual } from 'lodash-es'
import { engineOptionKeys, nonHotReloadableKeys, needRestartKeys } from '@shared/configKeys'
import type { Aria2EngineOptions } from '@shared/types'

const changeKeysCase = (
  obj: Record<string, unknown>,
  caseConverter: (s: string) => string,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [k, value] of Object.entries(obj)) {
    result[caseConverter(k)] = value
  }
  return result
}

export const changeKeysToCamelCase = (obj: Record<string, unknown> = {}): Record<string, unknown> => {
  return changeKeysCase(obj, camelCase)
}

export const changeKeysToKebabCase = (obj: Record<string, unknown> = {}): Record<string, unknown> => {
  return changeKeysCase(obj, (key) =>
    kebabCase(key)
      .replace(/^ed-2-k-/, 'ed2k-')
      .replace(/^aria-2-/, 'aria2-'),
  )
}

export const diffConfig = (
  current: Record<string, unknown> = {},
  next: Record<string, unknown> = {},
): Record<string, unknown> => {
  const curr = pick(current, Object.keys(next))
  return omitBy(next, (value, key) => isEqual(curr[key], value))
}

export const formatOptionsForEngine = (
  options: Aria2EngineOptions | Record<string, unknown> = {},
): Record<string, string> => {
  const result: Record<string, string> = {}
  Object.keys(options).forEach((key) => {
    const val = options[key]
    if (val === undefined || val === null) return
    const kebabCaseKey = changeKeysToKebabCase({ [key]: val })
    const [engineKey] = Object.keys(kebabCaseKey)
    if (Array.isArray(val)) {
      result[engineKey] = (val as string[]).join('\n')
    } else {
      result[engineKey] = `${val}`
    }
  })
  return result
}

export const checkIsNeedRestart = (changed: Record<string, unknown> = {}): boolean => {
  if (isEmpty(changed)) return false
  const kebabCaseChanged = changeKeysToKebabCase(changed)
  return needRestartKeys.some((key) => Object.keys(kebabCaseChanged).includes(key))
}

const SUPPORTED_ENGINE_KEYS = new Set(engineOptionKeys)
const NON_HOT_RELOADABLE = new Set(nonHotReloadableKeys)

/**
 * Filters a system config object to only keys that aria2 accepts via
 * `changeGlobalOption` RPC. Used to hot-reload settings at runtime
 * without requiring an engine restart.
 */
export const filterHotReloadableKeys = (config: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(config).filter(([key]) => SUPPORTED_ENGINE_KEYS.has(key) && !NON_HOT_RELOADABLE.has(key)),
  )
