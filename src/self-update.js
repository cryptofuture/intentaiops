import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, mkdir, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const POSIX_UPDATE_URL = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh'
export const WINDOWS_UPDATE_URL = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.ps1'
export const PACKAGE_UPDATE_URL = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/dist/intent-ai-ops.tgz'
export const PACKAGE_CHECKSUM_URL = `${PACKAGE_UPDATE_URL}.sha256`

const MAX_INSTALLER_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 4096

export async function rememberPackageUpdate (dataRoot, state) {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  const file = path.join(dataRoot, 'package-update.json')
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
}

export async function checkStartupUpdate ({ dataRoot, ui, update = updateIntentAiOps, fetchChecksum = globalThis.fetch }) {
  const file = path.join(dataRoot, 'package-update.json')
  let saved
  try { saved = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const response = await fetchChecksum(PACKAGE_CHECKSUM_URL, { signal: AbortSignal.timeout(3000), redirect: 'follow' })
  if (!response?.ok) throw new Error(`update checksum download failed with HTTP ${response?.status ?? 'unknown'}`)
  const manifest = Buffer.from(await response.arrayBuffer())
  if (manifest.length > MAX_CHECKSUM_BYTES) throw new Error('update checksum is too large')
  const current = parsePackageChecksum(manifest)
  let baseline = saved?.installedSha256 ?? saved?.observedSha256
  if (!baseline) {
    try { baseline = createHash('sha256').update(await readFile(new URL('../dist/intent-ai-ops.tgz', import.meta.url))).digest('hex') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const persist = state => rememberPackageUpdate(dataRoot, state)
  if (!saved) await persist({ observedSha256: baseline ?? current, installedSha256: null })
  if (!baseline) {
    return false
  }
  if (baseline === current) return false
  ui.info(`A different Intent AI Ops package is available (SHA-256 ${current}).`)
  ui.info(process.platform === 'win32' ? `Installer: irm ${WINDOWS_UPDATE_URL}` : `Installer: curl -fsSL ${POSIX_UPDATE_URL}`)
  if (!await ui.confirm('Install this package now using the official checksum-verified installer?', false)) return false
  try { await update({ expectedChecksum: current }) } catch (cause) {
    throw Object.assign(new Error(`Update installer failed: ${cause.message}`, { cause }), { code: 'PACKAGE_UPDATE_FAILED' })
  }
  await persist({ observedSha256: current, installedSha256: current })
  ui.success('Intent AI Ops updated. Restart it to load the new version.')
  return true
}

export async function updateIntentAiOps ({
  platform = process.platform,
  fetchInstaller = globalThis.fetch,
  runInstaller = runInstallerProcess,
  temporaryRoot = os.tmpdir(),
  expectedChecksum
} = {}) {
  if (typeof fetchInstaller !== 'function') throw new TypeError('self-update requires fetch support')
  const windows = platform === 'win32'
  const url = windows ? WINDOWS_UPDATE_URL : POSIX_UPDATE_URL
  const [installerBytes, packageBytes, checksumBytes] = await Promise.all([
    download(fetchInstaller, url, 'update installer', MAX_INSTALLER_BYTES),
    download(fetchInstaller, PACKAGE_UPDATE_URL, 'update package', MAX_PACKAGE_BYTES),
    download(fetchInstaller, PACKAGE_CHECKSUM_URL, 'update checksum', MAX_CHECKSUM_BYTES)
  ])
  const source = installerBytes.toString('utf8')
  validateInstaller(source, { windows })
  validatePackageChecksum(packageBytes, checksumBytes)
  if (expectedChecksum && parsePackageChecksum(checksumBytes) !== expectedChecksum) throw new Error('update package changed after confirmation; check again before installing')

  const temporary = await mkdtemp(path.join(temporaryRoot, 'intentaiops-update-'))
  const installer = path.join(temporary, windows ? 'install.ps1' : 'install.sh')
  const packageArchive = path.join(temporary, 'intent-ai-ops.tgz')
  try {
    await Promise.all([
      writeFile(installer, installerBytes, { mode: 0o700 }),
      writeFile(packageArchive, packageBytes, { mode: 0o600 })
    ])
    const command = windows ? 'powershell.exe' : 'sh'
    const args = windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer]
      : [installer]
    const code = await runInstaller(command, args, { INTENTAI_OPS_PACKAGE_URL: packageArchive })
    if (code !== 0) throw new Error(`update installer exited with code ${code}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return { url, packageUrl: PACKAGE_UPDATE_URL, sha256: parsePackageChecksum(checksumBytes) }
}

async function download (fetchResource, url, label, maximumBytes) {
  const response = await fetchResource(url, { redirect: 'follow' })
  if (!response?.ok) throw new Error(`${label} download failed with HTTP ${response?.status ?? 'unknown'}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > maximumBytes) throw new Error(`downloaded ${label} has an invalid size`)
  return bytes
}

function validateInstaller (source, { windows }) {
  const expectedHeader = windows ? "$ErrorActionPreference = 'Stop'" : '#!/bin/sh'
  if (!source.startsWith(expectedHeader) || !source.includes('INTENTAI_OPS_PACKAGE_URL')) {
    throw new Error('downloaded update installer failed validation')
  }
}

function validatePackageChecksum (packageBytes, checksumBytes) {
  const expected = parsePackageChecksum(checksumBytes)
  const actual = createHash('sha256').update(packageBytes).digest('hex')
  if (actual !== expected) throw new Error('update package SHA-256 verification failed')
}

function parsePackageChecksum (checksumBytes) {
  const manifest = checksumBytes.toString('utf8').trim()
  const match = /^([a-f0-9]{64})\s+\*?intent-ai-ops\.tgz$/iu.exec(manifest)
  if (!match) throw new Error('downloaded update checksum has an invalid format')
  return match[1].toLowerCase()
}

async function runInstallerProcess (command, args, environmentOverrides = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...environmentOverrides },
      stdio: 'inherit',
      windowsHide: false
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`update installer terminated by signal ${signal}`))
      else resolve(code ?? 1)
    })
  })
}
