#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = path.resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(path.join(os.tmpdir(), 'intentaiops-package-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tarball = path.join(projectRoot, 'dist', 'intent-ai-ops.tgz')

try {
  const checksum = readFileSync(`${tarball}.sha256`, 'utf8').trim()
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  assert.equal(checksum, `${digest}  intent-ai-ops.tgz`)

  const prefix = path.join(temporary, 'prefix')
  run(npm, ['install', '--global', '--prefix', prefix, pathToFileURL(tarball).href], temporary)

  const executable = process.platform === 'win32'
    ? path.join(prefix, 'intentaiops.cmd')
    : path.join(prefix, 'bin', 'intentaiops')
  const help = run(executable, ['--help'], temporary)
  assert.match(help.stdout, /^Usage: intentaiops/mu)
  assert.match(help.stdout, /https:\/\/intentaiops\.top/u)

  const modules = run(npm, ['root', '--global', '--prefix', prefix], temporary).stdout.trim()
  const packageRoot = path.join(modules, 'intent-ai-ops')
  const installedPackage = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(installedPackage.scripts?.prepare, undefined)
  assert.equal(installedPackage.dependencies?.['better-sqlite3'], '13.0.3')
  assert.equal(installedPackage.scripts?.install, undefined)
  assert.equal(installedPackage.scripts?.['verify:sqlite'], 'node scripts/install-better-sqlite3.js')
  assert.equal(existsSync(path.join(packageRoot, 'dist', 'intent-ai-ops.tgz')), false)
  assert.equal(existsSync(path.join(packageRoot, 'dist', 'intent-ai-ops.tgz.sha256')), false)
  for (const artifact of [
    'webminai.plugin',
    'webminai.plugin-freebsd-amd64',
    'webminai.plugin-kubernetes-amd64',
    'webminai.plugin-macos-amd64',
    'webminai.plugin-windows-amd64.exe'
  ]) assert.equal(readFileSync(path.join(packageRoot, 'dist', 'SHA256SUMS'), 'utf8').includes(`  ${artifact}`), true, artifact)

  const storeModule = pathToFileURL(path.join(packageRoot, 'src', 'task-store.js')).href
  const databaseRoot = path.join(temporary, 'database')
  const smoke = `import { TaskStore } from ${JSON.stringify(storeModule)}; const store = new TaskStore(${JSON.stringify(databaseRoot)}); const task = store.create('package-smoke', 'Validate installed SQLite'); if (task.status !== 'planning') process.exit(1); store.cancel('package-smoke', task.id); if (store.get('package-smoke', task.id).status !== 'cancelled') process.exit(1)`
  run(process.execPath, ['--input-type=module', '--eval', smoke], temporary)
  process.stdout.write(`PASS: installed dist/intent-ai-ops.tgz on ${process.platform}/${process.arch}\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

function run (command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  }
  return result
}
