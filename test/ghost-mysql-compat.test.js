import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ghostMysqlCompatibilityDockerfile, ghostMysqlCompatibilityImage, GHOST_MYSQL_IMAGE } from '../src/ghost-mysql-compat.js'
import { buildGhostTask } from '../src/ghost-task.js'
import { buildMacosComposeTask } from '../src/macos-compose-task.js'

test('Ghost alternative uses maintained pinned MySQL packages and retains upstream license', () => {
  const file = ghostMysqlCompatibilityDockerfile()
  assert.match(file, /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}/u)
  assert.match(GHOST_MYSQL_IMAGE, /^mysql@sha256:[a-f0-9]{64}$/u)
  for (const name of ['mysql-common', 'mysql-community-client', 'mysql-community-client-core', 'mysql-community-client-plugins', 'mysql-community-server-core']) assert.ok(file.includes(name + '_8.4.13-1debian12_amd64.deb'))
  assert.equal((file.match(/sha256sum -c -/gu) ?? []).length, 7)
  assert.match(file, /COPYING/u)
  assert.match(file, /mysqld --version/u)
  assert.match(file, /mysqladmin --version/u)
  assert.doesNotMatch(file, /mysql-8\.0|allow-unauthenticated|trusted=yes|--privileged/u)
  for (const run of file.split('\n').filter(line => line.startsWith('RUN '))) assert.equal(spawnSync('/bin/sh', ['-n', '-c', run.slice(4)]).status, 0)
  assert.notEqual(ghostMysqlCompatibilityImage(1), ghostMysqlCompatibilityImage(2))
  assert.throws(() => ghostMysqlCompatibilityImage('../other'), /task id/u)
})

test('Ghost baseline refuses existing project data before creating task state', () => {
  const context = { fingerprint: 'test', identity: { id: 'ubuntu', versionId: '26.04', architecture: 'x86_64' }, management: { family: 'debian' } }
  const built = buildGhostTask(21, context, { preferred: true, ready: true })
  const baseline = built.plan.commands[0].command
  assert.ok(baseline.indexOf('docker volume ls') < baseline.indexOf('install -d'))
  assert.ok(baseline.indexOf('docker network ls') < baseline.indexOf('install -d'))
  assert.match(baseline, /image-profile/u)
  const start = built.plan.commands.find(command => command.id === 'acquire-images').command
  assert.match(start, /standard\).*pull --quiet;; compat\)/u)
  assert.match(start, /trap cleanup_builder EXIT HUP INT TERM/u)
  assert.match(built.plan.commands.find(command => command.id === 'start-compose').command, /--pull never/u)
  assert.match(built.plan.commands.find(command => command.id === 'start-compose').command, /frontend_ready=; for attempt in \$\(seq 1 60\)/u)
  assert.match(built.plan.commands.find(command => command.id === 'start-compose').command, /\[ "\$frontend_ready" = yes \]/u)
  const rollback = built.plan.revertCommands[0].command
  assert.match(rollback, /compat-image\.after/u)
  assert.match(rollback, /docker buildx rm --force 'intentaiops-ghost-mysql-21'/u)
  assert.doesNotMatch(rollback, /docker (?:system|volume|image) prune/u)
})

test('Ghost cleanup removes only a builder marked as created by this task', () => {
  const context = { identity: { id: 'ubuntu', versionId: '26.04', architecture: 'x86_64' }, management: { family: 'debian' } }
  const source = buildGhostTask(21, context, { preferred: true, ready: true }).plan.revertCommands[0].command
  for (const owned of [false, true]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ghost-builder-'))
    const calls = path.join(directory, 'calls')
    try {
      writeFileSync(path.join(directory, 'image-profile'), owned ? 'compat' : 'standard')
      for (let index = 0; index < 5; index++) writeFileSync(path.join(directory, `image-${index}.existed`), '')
      if (owned) writeFileSync(path.join(directory, 'builder-created'), '')
      const command = source.replaceAll('/var/lib/webminai/task-state/21-ghost-compose', directory)
      const result = spawnSync('/bin/sh', ['-c', `docker () { printf '%s\\n' "$*" >> '${calls}'; if [ "$1 $2" = 'buildx inspect' ]; then return 1; fi; }; ${command}`], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      let output = ''
      try { output = readFileSync(calls, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      assert.equal(output.includes('buildx rm --force intentaiops-ghost-mysql-21'), owned)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('Ghost frontend readiness retries read-only probes and stops at its bound', () => {
  const context = { identity: { id: 'ubuntu', versionId: '26.04', architecture: 'x86_64' }, management: { family: 'debian' } }
  const command = buildGhostTask(22, context, { preferred: true, ready: true }).plan.commands.find(command => command.id === 'start-compose').command
  for (const recovers of [true, false]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ghost-readiness-'))
    const calls = path.join(directory, 'calls')
    try {
      const mocks = `docker () { if [ "$1" = inspect ]; then printf healthy; fi; }; sleep () { :; }; curl () { printf x >> '${calls}'; ${recovers ? `if [ "$(wc -c < '${calls}')" -ge 2 ]; then printf 'WEBMINAI_GHOST_OK\\n'; return 0; fi;` : ''} return 56; }; `
      const result = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
      assert.equal(result.status, recovers ? 0 : 1, result.stderr)
      assert.equal(readFileSync(calls, 'utf8').length, recovers ? 2 : 60)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('macOS Ghost retains the standard route and protects existing volumes', () => {
  const built = buildMacosComposeTask('ghost', 21, { platform: 'macos', runtimeUser: 'operator', runtimeHome: '/Users/operator', architecture: 'x86_64' }, { ready: true })
  const capture = built.plan.commands.find(command => command.id === 'capture-baseline').command
  assert.ok(capture.indexOf('docker volume ls') < capture.indexOf('install -d'))
  assert.match(capture, /standard > .*image-profile/u)
  assert.match(capture, new RegExp(GHOST_MYSQL_IMAGE + "'[^;]*; then : > '[^']*image-1\\.existed"))
  for (const command of built.plan.commands) assert.doesNotMatch(command.command, /\/proc\/cpuinfo/u)
})
