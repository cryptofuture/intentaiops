#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dependencyRoot = path.resolve(import.meta.dirname, '..', 'node_modules', 'better-sqlite3')

if (!bindingWorks()) {
  if (!existsSync(dependencyRoot)) throw new Error('better-sqlite3 is not installed')
  const env = { ...process.env }
  if (!env.PYTHON && process.platform === 'freebsd') {
    env.PYTHON = ['/usr/local/bin/python3', '/usr/local/bin/python3.13', '/usr/local/bin/python3.12']
      .find(existsSync)
    if (!env.PYTHON) {
      throw new Error('FreeBSD requires Python to build better-sqlite3; install python312 or set PYTHON')
    }
  }
  process.stdout.write('No compatible better-sqlite3 prebuild was found; building its native binding...\n')
  const npmCli = process.env.npm_execpath
  const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  const args = npmCli
    ? [npmCli, 'run', 'build-release', '--prefix', dependencyRoot]
    : ['run', 'build-release', '--prefix', dependencyRoot]
  const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 300000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`better-sqlite3 native build failed with exit code ${result.status}`)
  if (!bindingWorks()) throw new Error('better-sqlite3 native binding is unavailable after its build completed')
}

function bindingWorks () {
  try {
    const Database = require('better-sqlite3')
    const database = new Database(':memory:')
    try {
      return database.prepare('SELECT 1 AS value').get().value === 1
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}
