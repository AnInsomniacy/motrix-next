import { writeFileSync } from 'node:fs'

const publicKey = process.env.RAYBURST_UPDATER_PUBLIC_KEY?.trim()
if (!publicKey) throw new Error('RAYBURST_UPDATER_PUBLIC_KEY is required for a release build')
writeFileSync(
  'src-tauri/tauri.release.local.json',
  JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: publicKey } } }, null, 2) +
    '\n',
)
