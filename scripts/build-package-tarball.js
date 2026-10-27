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
  const web = spawnSync(npm, ['run', 'build:web'], { cwd: projectRoot, encoding: 'utf8', timeout: 180000 })
  if (web.status !== 0) throw new Error(`web build failed\n${web.stdout}\n${web.stderr}`)
  const result = spawnSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180000
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm pack failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  const [manifest] = JSON.parse(result.stdout)
  const paths = manifest.files.map(file => file.path)
  if (!paths.some(file => /^src\/operator-web\/assets\/ghostty-vt-[\w-]+\.wasm$/u.test(file))) throw new Error('package is missing the bundled terminal engine')
  if (!paths.some(file => /^src\/operator-web\/assets\/logo-[\w-]+\.png$/u.test(file))) throw new Error('package is missing the bundled Intent AI Ops logo')
  for (const forbidden of ['dist/intent-ai-ops.tgz', 'dist/intent-ai-ops.tgz.sha256']) {
    if (paths.includes(forbidden)) throw new Error(`package recursively contains ${forbidden}`)
  }
  for (const required of [
    'LICENSE',
    'bin/intentaiops.js',
    'src/operator-console.html',
    'src/operator-console-browser.js',
    'src/operator-controller.js',
    'src/operator-web/index.html',
    'src/operator-web/fonts/geist-400.ttf',
    'src/operator-web/fonts/geist-mono-400.ttf',
    'src/operator-web/licenses/OFL.txt',
    'src/operator-web/licenses/Muxin-LICENSE.txt',
    'src/operator-web/licenses/Preact-LICENSE.txt',
    'src/operator-web/licenses/Ghostty-web-LICENSE.txt',
    'src/operator-web/licenses/Lucide-LICENSE.txt',
    'web/themes/index.js',
    'web/themes/palettes.js',
    'src/catalog-plan-revision.js',
    'src/remote-common-task-recovery.js',
    'src/remote-recovery-record.js',
    'remote/recovery-store.sh',
    'remote/recovery-store.ps1',
    'remote/windows-cli-recovery-baseline.ps1',
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
