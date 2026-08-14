import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const versionFile = fileURLToPath(new URL('../plugin/VERSION', import.meta.url))

export const PLUGIN_VERSION = readFileSync(versionFile, 'utf8').trim()

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(PLUGIN_VERSION)) {
  throw new Error(`invalid Intent AI Ops plugin version: ${PLUGIN_VERSION}`)
}
