import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildMattermostTask, mattermostRelease } from '../src/mattermost-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const ubuntu = context('ubuntu', '24.04', 'debian', 'apt', 'systemd')
const rocky = context('rocky', '9.8', 'rhel', 'dnf', 'systemd')
const alpine = context('alpine', '3.23.5', 'alpine', 'apk', 'openrc')

test('Mattermost Compose route pins official images and protected PostgreSQL credentials', () => {
  const built = buildMattermostTask(21, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /mattermost\/mattermost-team-edition@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /postgres@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /MM_SQLSETTINGS_DATASOURCE/u)
  assert.match(commands, /MM_SERVICESETTINGS_SITEURL=http:\/\/%s:18111/u)
  assert.match(commands, /healthcheck:[^]*disable: true/u)
  assert.match(commands, /condition: service_started/u)
  assert.doesNotMatch(commands, /test: \["CMD", "curl"/u)
  assert.match(commands, /api\/v4\/system\/ping/u)
  assert.match(commands, /WEBMINAI_MATTERMOST_OK/u)
  assert.doesNotMatch(commands, /POSTGRES_PASSWORD=[a-f0-9]{32,}/u)
  assert.match(built.plan.revertCommands[0].command, /already-reverted/u)
  assertShellSyntax(built)
})

test('Debian-family Mattermost route verifies the official archive and PostgreSQL 14+', () => {
  const built = buildMattermostTask(22, ubuntu, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /mattermost-team-11\.7\.8-linux-amd64\.tar\.gz/u)
  assert.match(built.plan.commands.find(item => item.id === 'install-mattermost').command, /for attempt in 1 2 3 4 5 6/u)
  assert.match(built.plan.commands.find(item => item.id === 'install-mattermost').command, /--retry 0 --connect-timeout 15 --max-time 600/u)
  assert.match(built.plan.commands.find(item => item.id === 'install-mattermost').command, /--continue-at -/u)
  assert.equal(built.plan.commands.find(item => item.id === 'install-mattermost').timeoutMs, 3600000)
  assert.deepEqual(built.plan.commands.find(item => item.id === 'install-mattermost').retry, { attempts: 2, intervalMs: 2000, exitCodes: [143], states: ['timed_out'] })
  assert.match(commands, /0fc1637ca6cec0a53fc7112a22f67651dba50fe3667e5ed957acf0d3bbb9da93/u)
  assert.match(commands, /apt-get install -y[^;]*postgresql/u)
  assert.match(commands, /pg_createcluster/u)
  assert.match(commands, /postgres-cluster\.created/u)
  assert.match(commands, /postgres-cluster\.before/u)
  assert.match(commands, /MM_SQLSETTINGS_DRIVERNAME=postgres/u)
  assert.match(commands, /127\.0\.0\.1:8065\/api\/v4\/system\/ping/u)
  assert.match(commands, /CREATE ROLE webminai_mattermost LOGIN PASSWORD/u)
  assert.match(commands, /postgres-owned/u)
  assert.doesNotMatch(commands, /ALTER ROLE|-v password=/u)
  assertShellSyntax(built)
  assert.match(built.plan.revertCommands.map(item => item.command).join('\n'), /pg_dropcluster --stop/u)
  assert.doesNotMatch(built.plan.revertCommands.map(item => item.command).join('\n'), /apt-get autoremove/u)
})

test('EL9 Mattermost route selects and restores PostgreSQL 16 module state', () => {
  const built = buildMattermostTask(23, rocky, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  const revert = built.plan.revertCommands.map(item => item.command).join('\n')
  assert.match(commands, /dnf -y module enable postgresql:16/u)
  assert.match(commands, /postgresql-setup --initdb/u)
  assert.match(commands, /127\.0\.0\.1\/32 scram-sha-256/u)
  assert.match(revert, /postgres-hba\.before/u)
  assert.match(revert, /module reset postgresql/u)
  assert.match(revert, /postgres-module\.before/u)
  assertShellSyntax(built)
})

test('unsupported Mattermost production distributions produce a reversible no-change result', () => {
  const built = buildMattermostTask(24, alpine, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.equal(built.plan.commands.length, 1)
  assert.doesNotMatch(built.plan.commands[0].command, /apk add|docker|curl/u)
  assertShellSyntax(built)
})

test('Mattermost release matrix is pinned', () => {
  assert.equal(mattermostRelease().version, '11.7.8')
  assert.equal(mattermostRelease().archiveSha256.length, 64)
  assert.equal(mattermostRelease().images.length, 3)
})

test('Mattermost resumes from bytes retained after each broken download connection', { timeout: 20000 }, async t => {
  for (const scenario of ['resume', 'corrupt', 'retry-limit', 'not-found']) {
    await t.test(scenario, async t => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-mattermost-download-'))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const payload = Buffer.alloc(1048576, 'fixture-archive')
      const digest = createHash('sha256').update(payload).digest('hex')
      const offsets = []
      const server = createServer((request, response) => {
        const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/u)?.[1] ?? 0)
        offsets.push(offset)
        if (scenario === 'not-found') { response.writeHead(404); response.end(); return }
        response.writeHead(offset ? 206 : 200, {
          'Content-Length': payload.length - offset,
          ...(offset ? { 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}` } : {})
        })
        if (scenario === 'retry-limit' || (scenario === 'resume' && offsets.length <= 2)) response.write(payload.subarray(offset, offset + 65536), () => setTimeout(() => response.destroy(), 50))
        else response.end(scenario === 'corrupt' ? Buffer.alloc(payload.length - offset) : payload.subarray(offset))
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
      const state = path.join(directory, 'state')
      const root = path.join(directory, 'app')
      await mkdir(state)
      await writeFile(path.join(state, 'packages.before'), 'fixture-package\n')
      const artifact = path.join(state, 'mattermost-team-11.7.8-linux-amd64.tar.gz')
      await writeFile(artifact, payload.subarray(0, 131072))
      const original = buildMattermostTask(22, ubuntu, { preferred: false }).plan.commands.find(item => item.id === 'install-mattermost').command
      const command = original.replaceAll('/var/lib/webminai/task-state/22-mattermost-linux', state)
        .replaceAll('/opt/webminai-mattermost-18111', root)
        .replaceAll('https://releases.mattermost.com/11.7.8/mattermost-team-11.7.8-linux-amd64.tar.gz', `http://127.0.0.1:${server.address().port}/archive`)
        .replaceAll(mattermostRelease().archiveSha256, digest)
        .replaceAll('411962109', String(payload.length))
        .replaceAll('install -d -o root -g root -m 0755', 'install -d -m 0755')
      const mocks = 'sleep () { :; }; tar () { destination=; while [ "$#" -gt 0 ]; do if [ "$1" = -C ]; then shift; destination=$1; fi; shift; done; mkdir -p "$destination/bin"; printf \'#!/bin/sh\\nprintf "Version: 11.7.8\\\\n"\\n\' > "$destination/bin/mattermost"; chmod 0755 "$destination/bin/mattermost"; }; '
      const child = spawn('/bin/sh', ['-c', mocks + command], { stdio: ['ignore', 'pipe', 'pipe'] })
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
      let stderr = ''
      child.stdout.resume()
      child.stderr.on('data', value => { stderr += value })
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      if (scenario === 'resume') {
        assert.equal(code, 0, stderr)
        assert.deepEqual(offsets, [131072, 196608, 262144])
        assert.deepEqual(await readFile(artifact), payload)
      } else {
        assert.ok(scenario === 'retry-limit' ? [18, 56].includes(code) : code === (scenario === 'not-found' ? 22 : 1), stderr)
        assert.deepEqual(offsets, scenario === 'retry-limit' ? [131072, 196608, 262144, 327680, 393216, 458752] : [131072])
        await assert.rejects(readFile(path.join(root, 'bin/mattermost')), { code: 'ENOENT' })
        if (scenario === 'retry-limit') assert.equal((await readFile(artifact)).length, 524288)
        if (scenario === 'corrupt') await assert.rejects(readFile(artifact), { code: 'ENOENT' })
      }
    })
  }
})

function assertShellSyntax (built) {
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const checked = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${command.id}: ${checked.stderr}`)
  }
}

function context (id, versionId, family, packageManager, serviceManager) {
  return {
    fingerprint: `${id}-${versionId}`,
    identity: { id, versionId, architecture: 'x86_64' },
    management: { family, packageManager, serviceManager },
    applications: {}
  }
}
