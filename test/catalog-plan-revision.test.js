import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { regenerateCatalogRevision } from '../src/catalog-plan-revision.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const context = { fingerprint: 'fixture', identity: { id: 'ubuntu', versionId: '24.04', architecture: 'x86_64' }, management: { family: 'debian', packageManager: 'apt', serviceManager: 'systemd' }, applications: {} }

function fixture () {
  const trusted = buildCommonTask('ghost-linux', 57, { platform: 'linux', linuxContext: context, docker: { preferred: false } }).plan
  const task = { kind: 'catalog', catalogId: 'ghost-linux', plan: structuredClone(trusted) }
  task.plan.commands[1].command = 'old package installer'
  const execution = task.plan.commands.map((command, index) => ({ commandId: command.id, status: index === 0 ? 'completed' : index === 1 ? 'failed' : 'pending' }))
  return { trusted, task, execution }
}

test('catalog refresh preserves completed evidence and rollback while giving pending work fresh identities', () => {
  const { task, trusted, execution } = fixture()
  const refreshed = regenerateCatalogRevision(task, execution, trusted)
  validateCommandPlan(refreshed, { executionIdentity: 'root' })
  assert.deepEqual(refreshed.commands[0], task.plan.commands[0])
  assert.deepEqual(refreshed.revertCommands, task.plan.revertCommands)
  for (const [index, command] of refreshed.commands.slice(1).entries()) {
    assert.notEqual(command.id, trusted.commands[index + 1].id)
    assert.equal(command.command, trusted.commands[index + 1].command)
    assert.ok(command.dependsOn.every(id => refreshed.commands.some(candidate => candidate.id === id)))
  }
  assert.equal(task.plan.commands[1].command, 'old package installer')
  assert.match(refreshed.warnings.at(-1), /not fresh-install verified recovery/u)
})

test('catalog refresh rejects uncertain work, changed completed definitions and incompatible rollback or routes', () => {
  for (const change of [
    ({ execution }) => { execution[1].status = 'uncertain' },
    ({ task }) => { task.kind = 'ai' },
    ({ task }) => { task.plan.commands[0].command = 'different completed baseline' },
    ({ trusted }) => { trusted.revertCommands[0].command += '; true' },
    ({ trusted }) => { trusted.compatibilityManifest.selectedRoute.id = 'compose-mysql8' },
    ({ trusted }) => { trusted.compatibilityManifest.application.version = 'different' },
    ({ trusted }) => { trusted.compatibilityManifest.application.id = 'another' },
    ({ trusted }) => { trusted.compatibilityManifest.host.distribution = 'debian' },
    ({ execution }) => { execution[3].status = 'completed' }
  ]) {
    const value = fixture()
    change(value)
    assert.throws(() => regenerateCatalogRevision(value.task, value.execution, value.trusted))
  }
})

test('catalog refresh never reintroduces already completed catalog work', () => {
  const { task, trusted, execution } = fixture()
  task.plan = structuredClone(trusted)
  execution.forEach(command => { command.status = 'completed' })
  assert.throws(() => regenerateCatalogRevision(task, execution, trusted), /No remaining/u)
})
