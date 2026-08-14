import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ServerWorkspace } from '../src/server-workspace.js'

test('server workspace keeps non-secret rules and observed inventory per directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-workspace-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = new ServerWorkspace(root)

  await workspace.initialize('edge-1', {
    allowSudo: false,
    deniedPatterns: ['rm\\s+-rf']
  })
  const rules = await workspace.loadRules('edge-1')
  assert.equal(rules.policy.allowSudo, false)
  assert.equal(rules.preferences.docker, 'auto')

  const dockerEnabled = await workspace.setDockerPreference('edge-1', 'enabled')
  assert.equal(dockerEnabled.preferences.docker, 'enabled')
  assert.equal((await workspace.loadRules('edge-1')).preferences.docker, 'enabled')
  await assert.rejects(workspace.setDockerPreference('edge-1', 'sometimes'), /auto, enabled, or disabled/)

  await workspace.writeJson('edge-1', 'rules.json', {
    format: 'webminai-server-rules',
    version: 1,
    policy: { allowSudo: false }
  })
  assert.equal((await workspace.loadRules('edge-1')).preferences.docker, 'auto')

  const privileged = await workspace.enableRootExecution('edge-1')
  assert.equal(privileged.policy.allowSudo, false)
  assert.equal(privileged.policy.executionIdentity, 'root')

  const observed = await workspace.saveObserved(
    'edge-1',
    { info: { os: 'linux' }, containers: ['api'] },
    new Date('2026-08-04T12:00:00.000Z')
  )
  assert.equal(observed.observedAt, '2026-08-04T12:00:00.000Z')
  assert.deepEqual((await workspace.loadObserved('edge-1')).inventory.containers, ['api'])
  await workspace.saveHostContext('edge-1', { format: 'webminai-linux-host-context', identity: { id: 'ubuntu' } })
  assert.equal((await workspace.loadHostContext('edge-1')).identity.id, 'ubuntu')
  await workspace.saveHealthContext('edge-1', { format: 'webminai-host-health-profile', platform: 'linux' })
  assert.equal((await workspace.loadHealthContext('edge-1')).platform, 'linux')
  await workspace.saveUpdateContext('edge-1', { format: 'webminai-system-update-profile', platform: 'linux' })
  assert.equal((await workspace.loadUpdateContext('edge-1')).platform, 'linux')
  assert.equal((await stat(path.join(root, 'edge-1', 'rules.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(root, 'edge-1', 'observed.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(root, 'edge-1', 'host-context.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(root, 'edge-1', 'health-context.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(path.join(root, 'edge-1', 'update-context.json'))).mode & 0o777, 0o600)
})

test('server workspace aliases a renamed host to its stable history directory without resetting rules', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-workspace-alias-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const aliases = new Map([['new-name', 'host-1234567890abcdef']])
  const workspace = new ServerWorkspace(root, { directoryAliases: aliases })
  await workspace.initialize('new-name', { maxCommands: 5 })
  await workspace.setDockerPreference('new-name', 'disabled')
  await workspace.ensureInitialized('new-name', { maxCommands: 99 })
  assert.equal((await workspace.loadRules('new-name')).policy.maxCommands, 5)
  assert.equal((await workspace.loadRules('new-name')).preferences.docker, 'disabled')
  assert.equal((await stat(path.join(root, 'host-1234567890abcdef', 'rules.json'))).mode & 0o777, 0o600)
})
