import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildHomeAssistantTask, homeAssistantRelease } from '../src/home-assistant-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const ubuntu = context('ubuntu', '24.04', 'debian')

test('Home Assistant Compose route pins official images and excludes host integrations', () => {
  const built = buildHomeAssistantTask(51, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  assert.equal(built.plan.compatibilityManifest.selectedRoute.id, 'compose-official-isolated')
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /ghcr\.io\/home-assistant\/home-assistant@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /nginx@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /WEBMINAI_HOME_ASSISTANT_OK/u)
  assert.match(commands, /api\/onboarding\/users/u)
  assert.match(commands, /api\/onboarding\/integration/u)
  assert.match(commands, /home-assistant_v2\.db/u)
  assert.match(commands, /home_assistant_credentials\/admin_password/u)
  const compose = built.plan.commands.find(item => item.id === 'write-compose').command
  assert.match(compose, /location \/ \{/u)
  assert.match(compose, /proxy_pass http:\/\/app:8123/u)
  assert.doesNotMatch(compose, /privileged:|network_mode:|\/run\/dbus|devices:|\/dev\//u)
  assert.doesNotMatch(commands, /password[^\n]{0,20}[0-9a-f]{32}/iu)
  assertShellSyntax(built)
})

test('Linux hosts without preferred Docker receive a reversible supported-method result', () => {
  for (const [index, host] of ['ubuntu', 'debian', 'fedora', 'alpine', 'arch', 'opensuse-leap'].entries()) {
    const built = buildHomeAssistantTask(60 + index, context(host, 'test', family(host)), { preferred: false })
    validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
    assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
    assert.match(built.plan.commands[0].command, /Home Assistant OS and Home Assistant Container/u)
    assert.doesNotMatch(built.plan.commands[0].command, /docker|pip|python|apt-get|dnf|pacman|zypper|apk add/u)
    assertShellSyntax(built)
  }
})

test('Home Assistant release matrix is pinned', () => {
  const release = homeAssistantRelease()
  assert.equal(release.version, '2026.8.1')
  assert.equal(release.images.length, 2)
  for (const image of release.images) assert.match(image, /@sha256:[a-f0-9]{64}$/u)
})

function assertShellSyntax (built) {
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const checked = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${command.id}: ${checked.stderr}`)
  }
}

function family (id) {
  if (['ubuntu', 'debian'].includes(id)) return 'debian'
  if (id === 'arch') return 'arch'
  if (id === 'alpine') return 'alpine'
  if (id === 'opensuse-leap') return 'suse'
  return 'rhel'
}

function context (id, versionId, familyName) {
  return { fingerprint: `${id}-${versionId}`, identity: { id, versionId, architecture: 'x86_64' }, management: { family: familyName }, applications: {} }
}
