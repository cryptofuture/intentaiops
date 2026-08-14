import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { buildGhostTask, ghostRelease } from '../src/ghost-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const ubuntu = context('ubuntu', '24.04', 'debian', 'apt', 'systemd')
const debian = context('debian', '13', 'debian', 'apt', 'systemd')

test('Ghost Compose route pins official production images and protects MySQL credentials', () => {
  const built = buildGhostTask(7, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /ghost@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /mysql@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /NODE_ENV: production/u)
  assert.match(commands, /database__client: mysql/u)
  assert.match(commands, /127\.0\.0\.1:2368\/blog\//u)
  assert.match(commands, /proxy_pass http:\/\/ghost:2368;/u)
  assert.match(commands, /url=http:\/\/%s:18110\/blog\//u)
  assert.doesNotMatch(commands, /for \(index=/u)
  assert.match(commands, /\/root\/ghost_credentials\/credentials\.env/u)
  assert.match(commands, /WEBMINAI_GHOST_OK/u)
  assert.doesNotMatch(commands, /MYSQL_PASSWORD=[a-f0-9]{32,}/u)
  assert.match(built.plan.revertCommands[0].command, /already-reverted/u)
  assert.match(built.plan.revertCommands.at(-1).command, /already-reverted/u)
  assertShellSyntax(built)
})

test('Ubuntu Ghost route uses Node 22, Oracle MySQL 8, nginx, and a protected service environment', () => {
  const built = buildGhostTask(11, ubuntu, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /deb\.nodesource\.com\/node_22\.x/u)
  assert.match(commands, /mysql-server/u)
  assert.match(commands, /Ver 8\\\.0/u)
  assert.match(commands, /ghost-cli@1\.29\.1/u)
  assert.match(commands, /pnpm@11\.15\.1/u)
  assert.match(commands, /ghost' install '6\.57\.0'/u)
  assert.match(commands, /current\/index\.js/u)
  assert.match(commands, /\/config\.production\.json/u)
  assert.doesNotMatch(commands, /\/\.config\.production\.json/u)
  assert.match(commands, /content\/themes\/source/u)
  assert.match(commands, /EnvironmentFile=\/root\/ghost_credentials\/service\.env/u)
  assert.match(commands, /proxy_pass http:\/\/127\.0\.0\.1:2368/u)
  assert.match(commands, /WEBMINAI_GHOST_OK/u)
  assert.equal(built.plan.commands.find(item => item.id === 'initialize-database').executionMode, 'job')
  assert.equal(built.plan.commands.find(item => item.id === 'initialize-database').timeoutMs, 900000)
  assert.doesNotMatch(commands, /database__connection__password=[a-f0-9]{32,}/u)
  assert.match(built.plan.revertCommands.at(-1).command, /already-reverted/u)
  assert.match(built.plan.revertCommands.at(-1).command, /systemctl cat mysql/u)
  assertShellSyntax(built)
})

test('unsupported native distributions produce a reversible no-change compatibility result', () => {
  const built = buildGhostTask(13, debian, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.equal(built.plan.commands.length, 1)
  assert.match(built.plan.commands[0].command, /MariaDB or production SQLite substitutions are forbidden/u)
  assert.doesNotMatch(built.plan.commands[0].command, /apt-get|dnf|apk add|pacman|zypper|docker/u)
  assertShellSyntax(built)
})

test('Ghost release matrix is pinned', () => {
  assert.deepEqual(ghostRelease(), {
    version: '6.57.0',
    composeVersion: '6.56.0',
    images: ghostRelease().images
  })
  assert.equal(ghostRelease().images.length, 3)
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
