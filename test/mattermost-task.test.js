import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  assert.match(commands, /0fc1637ca6cec0a53fc7112a22f67651dba50fe3667e5ed957acf0d3bbb9da93/u)
  assert.match(commands, /apt-get install -y[^;]*postgresql/u)
  assert.match(commands, /pg_createcluster/u)
  assert.match(commands, /postgres-cluster\.created/u)
  assert.match(commands, /postgres-cluster\.before/u)
  assert.match(commands, /MM_SQLSETTINGS_DRIVERNAME=postgres/u)
  assert.match(commands, /127\.0\.0\.1:8065\/api\/v4\/system\/ping/u)
  assert.match(commands, /createuser --login 'webminai_mattermost'/u)
  assert.match(commands, /ALTER ROLE webminai_mattermost WITH LOGIN PASSWORD/u)
  assert.match(commands, /PASSWORD :'password';\nSQL\n:;/u)
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
