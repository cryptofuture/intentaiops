import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildOdooTask, odooRelease } from '../src/odoo-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const ubuntu = context('ubuntu', '24.04', 'debian', 'apt', 'systemd')
const debian = context('debian', '13', 'debian', 'apt', 'systemd')
const fedora = context('fedora', '44', 'rhel', 'dnf', 'systemd')
const alpine = context('alpine', '3.23.5', 'alpine', 'apk', 'openrc')

test('Odoo Compose route pins official images and materializes protected app config', () => {
  const built = buildOdooTask(31, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /odoo@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /postgres@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /nginx@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/database_password/u)
  assert.match(commands, /admin_passwd = \$\$admin/u)
  assert.match(commands, /db_password = \$\$password/u)
  assert.match(commands, /chown odoo:odoo \/etc\/odoo\/odoo\.conf/u)
  assert.doesNotMatch(commands, /app:[^]*PASSWORD_FILE/u)
  assert.match(commands, /WEBMINAI_ODOO_OK/u)
  assert.doesNotMatch(commands, /POSTGRES_PASSWORD=[a-f0-9]{32,}/u)
  assert.match(built.plan.revertCommands[0].command, /already-reverted/u)
  assertShellSyntax(built)
})

test('Debian-family Odoo route verifies the official package and PostgreSQL 13+', () => {
  const built = buildOdooTask(32, ubuntu, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  const revert = built.plan.revertCommands.map(item => item.command).join('\n')
  assert.match(commands, /odoo_19\.0\.20260810_all\.deb/u)
  assert.match(commands, /c6b65878756626cd890161e70d0a214604f7a032418558755f6ce62a8a263984/u)
  assert.match(commands, /pg_createcluster/u)
  assert.match(commands, /version\[1\].*-ge 13/u)
  assert.match(commands, /--without-demo=all --stop-after-init/u)
  assert.match(commands, /LoadCredential=odoo\.conf:\/root\/odoo_credentials\/odoo\.conf/u)
  assert.match(commands, /--config=%d\/odoo\.conf/u)
  assert.match(commands, /PASSWORD :'password';\nSQL\n:;/u)
  assert.doesNotMatch(commands, /addons_path/u)
  assert.match(revert, /pg_dropcluster --stop/u)
  assert.doesNotMatch(revert, /apt-get autoremove/u)
  assertShellSyntax(built)
})

test('Fedora Odoo route records the current official RPM dependency incompatibility', () => {
  const built = buildOdooTask(33, fedora, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.match(commands, /official RPM requires Python 3\.13/u)
  assert.doesNotMatch(commands, /dnf install|curl/u)
  assertShellSyntax(built)
})

test('Debian 13 Odoo route records the removed python3-pypdf2 dependency', () => {
  const built = buildOdooTask(35, debian, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.match(commands, /requires python3-pypdf2/u)
  assert.doesNotMatch(commands, /apt-get install|curl/u)
  assertShellSyntax(built)
})

test('unsupported Odoo package distributions produce a reversible no-change result', () => {
  const built = buildOdooTask(34, alpine, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.equal(built.plan.commands.length, 1)
  assert.doesNotMatch(built.plan.commands[0].command, /apk add|docker|curl/u)
  assertShellSyntax(built)
})

test('Odoo release matrix is pinned', () => {
  assert.equal(odooRelease().version, '19.0.20260810')
  assert.equal(odooRelease().debSha256.length, 64)
  assert.equal(odooRelease().rpmSha256.length, 64)
  assert.equal(odooRelease().images.length, 3)
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
