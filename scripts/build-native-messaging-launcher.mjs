#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tauriDir = join(root, 'src-tauri')
const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const extension = targetTriple.includes('windows') ? '.exe' : ''
const binaryName = `rayburst-browser-launcher${extension}`

execFileSync(
  'cargo',
  [
    'run',
    '--locked',
    '--release',
    '--package',
    'rayburst-browser-launcher',
    '--bin',
    'rayburst-browser-manifests',
    '--',
    'native-messaging/manifests',
  ],
  { cwd: tauriDir, stdio: 'inherit' },
)

const cargoArgs = [
  'build',
  '--locked',
  '--package',
  'rayburst-browser-launcher',
  '--bin',
  'rayburst-browser-launcher',
  '--target',
  targetTriple,
  '--release',
]

execFileSync('cargo', cargoArgs, { cwd: tauriDir, stdio: 'inherit' })

const source = join(tauriDir, 'target', targetTriple, 'release', binaryName)
const destination = join(tauriDir, 'generated-binaries', `rayburst-browser-launcher-${targetTriple}${extension}`)
mkdirSync(dirname(destination), { recursive: true })
const unchanged = existsSync(destination) && readFileSync(source).equals(readFileSync(destination))
if (!unchanged) copyFileSync(source, destination)
if (!extension && (statSync(destination).mode & 0o111) === 0) chmodSync(destination, 0o755)
