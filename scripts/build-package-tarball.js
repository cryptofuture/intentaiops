#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const dist = path.join(projectRoot, 'dist')
const destination = path.join(dist, 'intent-ai-ops.tgz')
const checksumDestination = `${destination}.sha256`
const temporary = mkdtempSync(path.join(os.tmpdir(), 'intentaiops-build-package-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  const result = spawnSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180000
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm pack failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  const [manifest] = JSON.parse(result.stdout)
  const paths = manifest.files.map(file => file.path)
  for (const forbidden of ['dist/intent-ai-ops.tgz', 'dist/intent-ai-ops.tgz.sha256']) {
    if (paths.includes(forbidden)) throw new Error(`package recursively contains ${forbidden}`)
  }
  for (const required of [
    'LICENSE',
    'NOTICE',
    'bin/intentaiops.js',
    'scripts/install-better-sqlite3.js',
    'dist/SHA256SUMS',
    'dist/webminai.plugin',
    'dist/webminai.plugin-freebsd-amd64',
    'dist/webminai.plugin-kubernetes-amd64',
    'dist/webminai.plugin-macos-amd64',
    'dist/webminai.plugin-windows-amd64.exe'
  ]) {
    if (!paths.includes(required)) throw new Error(`package is missing ${required}`)
  }

  const packed = path.join(temporary, manifest.filename)
  const digest = createHash('sha256').update(readFileSync(packed)).digest('hex')
  const suffix = randomBytes(6).toString('hex')
  const temporaryDestination = path.join(dist, `.intent-ai-ops.tgz.${suffix}`)
  const temporaryChecksum = `${temporaryDestination}.sha256`
  copyFileSync(packed, temporaryDestination)
  writeFileSync(temporaryChecksum, `${digest}  intent-ai-ops.tgz\n`, { mode: 0o644 })
  renameSync(temporaryDestination, destination)
  renameSync(temporaryChecksum, checksumDestination)
  process.stdout.write(`Built dist/intent-ai-ops.tgz\nSHA-256: ${digest}\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
