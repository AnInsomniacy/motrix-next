import { execFileSync } from 'node:child_process'
import { copyFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = mkdtempSync(join(tmpdir(), 'rayburst-icons-'))
try {
  execFileSync(
    process.execPath,
    ['node_modules/@tauri-apps/cli/tauri.js', 'icon', 'public/logo.svg', '--output', output],
    { stdio: 'inherit' },
  )
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile()) copyFileSync(join(output, entry.name), join('src-tauri/icons', entry.name))
  }
} finally {
  rmSync(output, { recursive: true, force: true })
}
