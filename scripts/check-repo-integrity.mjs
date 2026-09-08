#!/usr/bin/env node
/**
 * Cross-runtime locale checks that framework tooling cannot express.
 * Translation keys and usage are validated by @intlify/eslint-plugin-vue-i18n.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseCompile } from '@intlify/message-compiler'
import { INDIRECT_I18N_KEYS } from './i18n-key-contracts.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES_DIR = join(ROOT, 'src', 'shared', 'locales')
const NATIVE_LOCALES_DIR = join(ROOT, 'src-tauri', 'locales')
const problems = []

const catalog = JSON.parse(readFileSync(join(LOCALES_DIR, 'catalog.json'), 'utf8'))
const expectedLocales = Object.keys(catalog).sort()
const resourceLocales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function reportSetDifference(label, expected, actual) {
  const missing = expected.filter((value) => !actual.includes(value))
  const extra = actual.filter((value) => !expected.includes(value))
  if (missing.length) problems.push(`${label} missing: ${missing.join(', ')}`)
  if (extra.length) problems.push(`${label} unexpected: ${extra.join(', ')}`)
}

reportSetDifference('frontend locale resources', expectedLocales, resourceLocales)

for (const locale of resourceLocales) {
  const files = readdirSync(join(LOCALES_DIR, locale)).sort()
  if (files.length !== 1 || files[0] !== 'messages.json') {
    problems.push(`locale ${locale} must contain only messages.json; found: ${files.join(', ')}`)
  }
}

const nativeLocales = readdirSync(NATIVE_LOCALES_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/u, ''))
  .sort()
reportSetDifference('native locale resources', expectedLocales, nativeLocales)

const nativeReference = JSON.parse(readFileSync(join(NATIVE_LOCALES_DIR, 'en-US.json'), 'utf8'))
const nativeReferenceKeys = Object.keys(nativeReference).filter((key) => key !== '_version')
const rustPlaceholders = (message) => Array.from(message.matchAll(/%\{([^}]+)\}/gu), (match) => match[1]).sort()

for (const locale of nativeLocales) {
  const messages = JSON.parse(readFileSync(join(NATIVE_LOCALES_DIR, `${locale}.json`), 'utf8'))
  const keys = Object.keys(messages).filter((key) => key !== '_version')
  reportSetDifference(`native locale ${locale} keys`, nativeReferenceKeys, keys)
  for (const key of nativeReferenceKeys) {
    const sourceMessage = nativeReference[key]
    const targetMessage = messages[key]
    if (typeof sourceMessage !== 'string' || typeof targetMessage !== 'string') continue
    const expected = rustPlaceholders(sourceMessage)
    const actual = rustPlaceholders(targetMessage)
    if (expected.join('\0') !== actual.join('\0')) {
      problems.push(
        `native locale ${locale} placeholder mismatch at ${key}: expected [${expected.join(', ')}], found [${actual.join(', ')}]`,
      )
    }
  }
}

function flattenMessages(value, prefix = '', result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') result.set(path, child)
    else if (child && typeof child === 'object' && !Array.isArray(child)) flattenMessages(child, path, result)
    else problems.push(`locale message ${path} must be a string or object`)
  }
  return result
}

function collectPlaceholders(message) {
  const placeholders = new Set()
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 4) placeholders.add(`named:${node.key}`)
    if (node.type === 5) placeholders.add(`list:${node.index}`)
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'loc') visit(value)
    }
  }
  visit(baseCompile(message).ast)
  return [...placeholders].sort()
}

const reference = flattenMessages(JSON.parse(readFileSync(join(LOCALES_DIR, 'en-US', 'messages.json'), 'utf8')))
for (const key of INDIRECT_I18N_KEYS) {
  if (!reference.has(key)) problems.push(`indirect i18n contract references missing key: ${key}`)
}
for (const locale of resourceLocales.filter((value) => value !== 'en-US')) {
  const messages = flattenMessages(JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8')))
  for (const [key, sourceMessage] of reference) {
    const targetMessage = messages.get(key)
    if (targetMessage === undefined) continue
    const sourcePlaceholders = collectPlaceholders(sourceMessage)
    const targetPlaceholders = collectPlaceholders(targetMessage)
    if (sourcePlaceholders.join('\0') !== targetPlaceholders.join('\0')) {
      problems.push(
        `locale ${locale} placeholder mismatch at ${key}: expected [${sourcePlaceholders.join(', ')}], found [${targetPlaceholders.join(', ')}]`,
      )
    }
  }
}

if (problems.length) {
  console.error(`✗ repo-integrity: ${problems.length} problem(s)\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('✓ repo-integrity: locale structure and placeholders OK')
