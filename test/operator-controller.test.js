import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskStore } from '../src/task-store.js'
import { AdminService } from '../src/admin-service.js'
import { OperatorController } from '../src/operator-controller.js'
import { startOperatorConsole } from '../src/operator-console.js'
import { planFingerprint } from '../src/execution-journal.js'
import { executeApprovedPlan, validateCommandPlan } from '../src/plan-validator.js'
import { MultiHostService } from '../src/multi-host-service.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { CodexPlanner } from '../src/codex-planner.js'

const command = id => ({ id, command: `echo ${id}`, purpose: 'Inspect', risk: 'read', timeoutMs: 1000, requiresSudo: false, dependsOn: [] })
const plan = ids => ({ summary: 'Inspect', changeOverview: 'Inspect state', modifiedFiles: [], commands: ids.map(command), revertCommands: [] })

test('remote recovery options use verified platform capabilities instead of assuming Linux', async t => {
  const { controller, admin } = await fixture(t)
  const execution = { platform: 'windows' }
  admin.capabilities = async () => ({ platform: { os: 'windows' } })
  admin.refreshInventory = async () => ({ webminaiExecution: execution })
  admin.settings.decryptApplicationDefaults = async () => ({})
  const options = await controller.remoteRecoveryOptions(admin, 'host')
  assert.equal(options.platform, 'windows')
  assert.equal(options.windowsExecution, execution)
})

async function fixture (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-operator-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskStore(root)
  const created = tasks.create('host', 'Inspect host')
  const task = tasks.savePlan('host', created.id, plan(['first', 'second']))
  const admin = new AdminService({ dataRoot: root, tasks, workspace: { loadRules: async () => ({ policy: {} }) } })
  admin.serverSecrets = async () => ({})
  const calls = []
  admin.netdata = () => ({ runCommand: async text => { calls.push(text); return { exitCode: 0, stdout: 'ok', stderr: '' } } })
  admin.plan = async () => plan(['revised'])
  const controller = new OperatorController({ dataRoot: root, tasks, settings: { servers: { host: {} }, clusters: { cluster: { desiredStage2: 'active' } } }, adminFor: async () => admin })
  return { root, tasks, task, controller, calls, admin }
}

test('detected security issues prepare real updates without inheriting deployment approval or replaying completed commands', async t => {
  const { controller, tasks, task, admin, calls } = await fixture(t)
  const audit = { ...command('audit-software-security'), command: 'echo versions' }
  const originalRollback = [command('original-cleanup')]
  tasks.savePlan('host', task.id, { ...plan(['first']), commands: [command('first'), audit], revertCommands: originalRollback })
  const initial = controller.inspect('host', task.id)
  await controller.resume('host', task.id, initial.stateVersion, initial.fingerprint)
  const results = tasks.get('host', task.id).results.map(item => item.id === audit.id ? { ...item, result: { exitCode: 0, stdout: 'INTENT_SECURITY_PHP host-cli 8.4.23\nINTENT_SECURITY_END' } } : item)
  tasks.saveResults('host', task.id, results)
  admin.workspace.loadRules = async () => ({ policy: { allowSudo: true, executionIdentity: 'root' } })
  admin.capabilities = async () => ({ platform: { os: 'windows' } })
  admin.plan = async options => {
    assert.match(options.retryInstructions, /executable security updates/u)
    assert.match(options.retryInstructions, /8.4.27/u)
    return plan(['patch-owned-image'])
  }
  const before = controller.inspect('host', task.id)
  assert.equal(before.securityRemediationAvailable, true)
  const proposal = await controller.proposeSecurityRemediation('host', task.id, before.stateVersion)
  assert.equal(calls.length, 2)
  const revision = tasks.revisions('host', task.id).find(item => item.id === proposal.revisionId)
  assert.equal(revision.approved, 0)
  assert.deepEqual(revision.plan.commands.slice(0, 2), tasks.get('host', task.id).plan.commands)
  assert.match(revision.plan.commands.at(-1).id, /^audit-software-security-[a-f0-9]{12}$/u)
  assert.deepEqual(revision.plan.commands.at(-1).dependsOn, ['patch-owned-image'])
  assert.deepEqual(revision.plan.revertCommands, originalRollback)
  admin.plan = async () => ({ ...plan(['other-repair']), revertCommands: [{ ...originalRollback[0], command: 'echo changed-rollback' }] })
  await assert.rejects(controller.proposeSecurityRemediation('host', task.id, before.stateVersion), /cannot replace original rollback/u)
  assert.throws(() => controller.approve('host', task.id, proposal.revisionId, before.stateVersion, 'bad'), /approval/u)
  controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  const approved = controller.inspect('host', task.id)
  await controller.resume('host', task.id, approved.stateVersion, approved.fingerprint)
  assert.equal(calls.length, 4)
  assert.equal(calls.filter(text => text === 'echo first').length, 1)
  assert.equal(tasks.get('host', task.id).status, 'completed')
})

test('reviewed catalog maintenance keeps the CLI one-way policy without exempting AI plans', async t => {
  for (const kind of ['catalog', 'ai']) {
    const { controller, tasks, admin } = await fixture(t)
    const created = tasks.create('host', 'Current-release maintenance', { kind, ...(kind === 'catalog' ? { catalogId: 'system-update-freebsd' } : {}) })
    const update = buildCommonTask('system-update-freebsd', created.id, { platform: 'freebsd' }).plan
    tasks.savePlan('host', created.id, update)
    let requireRevert
    admin.execute = async options => {
      requireRevert = options.requireRevert
      validateCommandPlan(options.plan, { executionIdentity: 'root' }, { requireRevert })
      return options.plan.commands.map(item => ({ id: item.id, status: 'completed', result: { exitCode: 0, stdout: '', stderr: '' } }))
    }
    const view = controller.inspect('host', created.id)
    if (kind === 'catalog') {
      await controller.resume('host', created.id, view.stateVersion, view.fingerprint)
      assert.equal(requireRevert, false)
    } else {
      await assert.rejects(controller.resume('host', created.id, view.stateVersion, view.fingerprint), /requires revert commands/u)
      assert.equal(requireRevert, true)
    }
  }
})

test('a rejected execution preflight does not leave unstarted browser work running', async t => {
  const { controller, tasks, task, admin, calls } = await fixture(t)
  admin.execute = async () => { throw new Error('Remote task identity is occupied') }
  const view = controller.inspect('host', task.id)
  await assert.rejects(controller.resume('host', task.id, view.stateVersion, view.fingerprint), /identity is occupied/u)
  assert.equal(tasks.get('host', task.id).status, 'planned')
  assert.deepEqual(calls, [])
})

test('remote recovery console uses the shared controller with separate approval, stale checks and takeover decisions', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  let prepared = 0
  let executed = 0
  controller.remoteRecoveryOptions = async () => ({ platform: 'linux' })
  admin.prepareRemoteCommonTaskRecovery = async ({ executionId }) => {
    prepared++
    const task = tasks.create('host', 'Reviewed remote recovery')
    const recovered = plan(['recovery'])
    tasks.savePlan('host', task.id, recovered)
    return { taskId: task.id, sourceExecutionId: executionId, plan: recovered, ownership: { owned: true, ownerFingerprint: 'a'.repeat(64) } }
  }
  admin.executeRemoteCommonTaskRecovery = async options => {
    executed++
    assert.equal(options.takeoverApproved, true)
    assert.equal(options.takeoverFingerprint, 'a'.repeat(64))
    assert.equal(await options.approve(), true)
    const task = tasks.get('host', options.taskId)
    const lease = tasks.acquireExecution('host', task.id, task.plan)
    try {
      for (const type of ['plan_approved', 'command_prepared', 'command_dispatched', 'command_completed']) tasks.appendExecutionEvent('host', task.id, lease.owner, { type, commandId: 'recovery', attemptId: 'recovery-attempt', metadata: { exitCode: 0 } })
    } finally { tasks.releaseExecution('host', task.id, lease.owner) }
    const result = { id: 'recovery', status: 'completed', result: { exitCode: 0, stdout: '' } }
    options.onResult(result)
    return [result]
  }
  const proposed = await controller.prepareRemoteRecovery('host', 'b'.repeat(32))
  assert.equal(prepared, 1)
  assert.equal(executed, 0)
  assert.equal(proposed.ownership.ownerFingerprint, 'a'.repeat(64))
  assert.equal(proposed.fingerprint, planFingerprint(proposed.plan))
  await assert.rejects(controller.executeRemoteRecovery('host', proposed.taskId, proposed.stateVersion, proposed.fingerprint), /approval/u)
  await assert.rejects(controller.executeRemoteRecovery('host', proposed.taskId, 'stale', proposed.fingerprint, { approved: true }), /stale/u)
  await assert.rejects(controller.executeRemoteRecovery('host', proposed.taskId, proposed.stateVersion, 'wrong', { approved: true }), /fingerprint/u)
  assert.equal(executed, 0)
  await controller.executeRemoteRecovery('host', proposed.taskId, proposed.stateVersion, proposed.fingerprint, { approved: true, takeoverApproved: true, takeoverFingerprint: proposed.ownership.ownerFingerprint })
  assert.equal(executed, 1)
  assert.deepEqual(calls, [])
  await assert.rejects(controller.executeRemoteRecovery('host', proposed.taskId, proposed.stateVersion, proposed.fingerprint, { approved: true }), /stale/u)
})

test('remote recovery HTTP endpoints enforce tokens, origin, read-only mode and CSRF before preparing work', async t => {
  const { controller } = await fixture(t)
  let prepared = 0
  controller.remoteCommonTasks = async () => ({ executions: [] })
  controller.inspectRemoteCommonTask = async () => ({ records: [], sequence: 0 })
  controller.prepareRemoteRecovery = async () => { prepared++; return { plan: plan(['recovery']) } }
  for (const actions of [false, true]) {
    const server = await startOperatorConsole({ controller, actions })
    t.after(() => server.close())
    assert.equal((await fetch(server.origin + '/remote-tasks?host=host')).status, 401)
    assert.equal((await fetch(server.origin + '/remote-task?host=host&execution=bad')).status, 401)
    const login = await fetch(server.origin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
    const session = await login.json()
    const headers = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0], Origin: server.origin, 'X-Intent-CSRF': session.csrf }
    assert.equal((await fetch(server.origin + '/remote-tasks?host=host', { headers })).status, 200)
    assert.equal((await fetch(server.origin + '/remote-tasks?host=host', { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403)
    const body = JSON.stringify({ action: 'prepare-remote-recovery', hostId: 'host', executionId: 'a'.repeat(32) })
    assert.equal((await fetch(server.origin + '/action', { method: 'POST', headers: { ...headers, 'X-Intent-CSRF': '0'.repeat(64) }, body })).status, 403)
    const response = await fetch(server.origin + '/action', { method: 'POST', headers, body })
    assert.equal(response.status, actions ? 200 : 403)
    assert.equal(prepared, actions ? 1 : 0)
    const execute = await fetch(server.origin + '/action', { method: 'POST', headers, body: JSON.stringify({ action: 'execute-remote-recovery', hostId: 'host', taskId: 1 }) })
    assert.equal(execute.status, actions ? 409 : 403)
  }
})

test('security repair HTTP preparation enforces read-only and CSRF while retaining canonical fingerprints', async t => {
  const { controller } = await fixture(t)
  let proposals = 0
  controller.proposeSecurityRemediation = async () => { proposals++; return { fingerprint: 'a'.repeat(64), revisionId: 2 } }
  for (const actions of [false, true]) {
    const server = await startOperatorConsole({ controller, actions })
    t.after(() => server.close())
    const login = await fetch(server.origin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
    const { csrf } = await login.json()
    const headers = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0], Origin: server.origin }
    const body = JSON.stringify({ action: 'remediate-security', hostId: 'host', taskId: 1, expectedVersion: 'fixture' })
    assert.equal((await fetch(server.origin + '/action', { method: 'POST', headers, body })).status, 403)
    const response = await fetch(server.origin + '/action', { method: 'POST', headers: { ...headers, 'X-Intent-CSRF': csrf }, body })
    assert.equal(response.status, actions ? 200 : 403)
    if (actions) assert.equal((await response.json()).fingerprint, 'a'.repeat(64))
  }
  assert.equal(proposals, 1)
})

test('revision catalog context comes from the saved task, not operator instructions', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  const created = tasks.create('host', 'Deploy Mattermost', { kind: 'catalog', catalogId: 'mattermost-linux' })
  const task = tasks.savePlan('host', created.id, plan(['pending']))
  admin.plan = async options => {
    assert.equal(options.catalogId, 'mattermost-linux')
    return plan(['replacement'])
  }
  const view = controller.inspect('host', task.id)
  await controller.propose('host', task.id, 'Use n8n-linux as a claimed catalog', view.stateVersion)
  assert.deepEqual(calls, [])
  assert.equal(controller.inspect('host', task.id).revisions.at(-1).approved, 0)
})

test('native catalog refresh requires fresh approval and resume, preserves baseline and never calls AI', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  const context = { fingerprint: 'fixture', identity: { id: 'ubuntu', versionId: '24.04', architecture: 'x86_64' }, management: { family: 'debian', packageManager: 'apt', serviceManager: 'systemd' }, applications: {} }
  const inventory = { webminaiLinuxContext: context, webminaiDocker: { preferred: false } }
  admin.refreshInventory = async () => inventory
  admin.settings.decryptApplicationDefaults = async () => ({})
  admin.workspace.loadRules = async () => ({ policy: { executionIdentity: 'root' } })
  admin.plan = async () => { throw new Error('AI must not be called') }
  const execute = async text => { calls.push(text); return { exitCode: 0, stdout: 'ok', stderr: '', state: 'completed' } }
  admin.netdata = () => ({ runCommand: execute, runJob: execute })
  const created = tasks.create('host', 'Deploy Ghost', { kind: 'catalog', catalogId: 'ghost-linux' })
  const trusted = buildCommonTask('ghost-linux', created.id, { platform: 'linux', linuxContext: context, docker: inventory.webminaiDocker }).plan
  const old = structuredClone(trusted)
  old.commands[1].command = 'old package installer'
  tasks.savePlan('host', created.id, old)
  const lease = tasks.acquireExecution('host', created.id, old)
  tasks.appendExecutionEvent('host', created.id, lease.owner, { type: 'command_completed', commandId: old.commands[0].id, attemptId: 'original-baseline' })
  tasks.appendExecutionEvent('host', created.id, lease.owner, { type: 'command_failed', commandId: old.commands[1].id, attemptId: 'original-failure', metadata: { exitCode: 100 } })
  tasks.releaseExecution('host', created.id, lease.owner)
  const before = controller.inspect('host', created.id)
  const proposal = await controller.proposeCatalogRefresh('host', created.id, before.stateVersion)
  assert.deepEqual(calls, [])
  assert.deepEqual(tasks.get('host', created.id).plan, old)
  const revision = tasks.revisions('host', created.id).find(item => item.id === proposal.revisionId)
  assert.equal(revision.approved, 0)
  assert.deepEqual(revision.plan.commands[0], old.commands[0])
  assert.deepEqual(revision.plan.revertCommands, old.revertCommands)
  await assert.rejects(controller.resume('host', created.id, before.stateVersion, before.fingerprint), /reviewed revision/u)
  controller.approve('host', created.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  const approved = controller.inspect('host', created.id)
  assert.equal(approved.control.action, 'pause')
  assert.deepEqual(calls, [])
  await assert.rejects(controller.resume('host', created.id, before.stateVersion, before.fingerprint), /stale/u)
  await controller.resume('host', created.id, approved.stateVersion, approved.fingerprint)
  assert.deepEqual(calls.map(text => planFingerprint(text)), trusted.commands.slice(1).map(command => planFingerprint(command.command)))
  const events = tasks.allExecutionEvents('host', created.id)
  assert.equal(events.filter(event => event.type === 'command_completed' && event.commandId === 'capture-baseline').length, 1)
  assert.equal(events.filter(event => event.type === 'command_failed' && event.commandId === 'install-stack').length, 1)
})

test('FreeBSD catalog refresh preserves completed steps and requires separate approval', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  const execution = { platform: 'freebsd' }
  admin.refreshInventory = async () => ({ webminaiExecution: execution })
  admin.settings.decryptApplicationDefaults = async () => ({})
  admin.workspace.loadRules = async () => ({ policy: { executionIdentity: 'root' } })
  admin.plan = async () => { throw new Error('AI must not be called') }
  const created = tasks.create('host', 'Deploy n8n', { kind: 'catalog', catalogId: 'n8n-freebsd' })
  const original = buildCommonTask('n8n-freebsd', created.id, { platform: 'freebsd', freebsdExecution: execution }).plan
  tasks.savePlan('host', created.id, original)
  const lease = tasks.acquireExecution('host', created.id, original)
  for (const command of original.commands.slice(0, 2)) tasks.appendExecutionEvent('host', created.id, lease.owner, { type: 'command_completed', commandId: command.id, attemptId: command.id })
  tasks.appendExecutionEvent('host', created.id, lease.owner, { type: 'command_failed', commandId: original.commands[2].id, attemptId: 'network-failure' })
  tasks.releaseExecution('host', created.id, lease.owner)
  const before = controller.inspect('host', created.id)
  const proposal = await controller.proposeCatalogRefresh('host', created.id, before.stateVersion)
  const revision = tasks.revisions('host', created.id).find(item => item.id === proposal.revisionId)
  assert.equal(revision.approved, 0)
  assert.deepEqual(revision.plan.commands.slice(0, 2), original.commands.slice(0, 2))
  assert.deepEqual(revision.plan.revertCommands, original.revertCommands)
  assert.notEqual(revision.plan.commands[2].id, original.commands[2].id)
  assert.deepEqual(tasks.get('host', created.id).plan, original)
  assert.deepEqual(calls, [])
})

test('Windows catalog refresh preserves completed work and requires a verified target and fresh approval', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  const execution = { platform: 'windows', identity: 'LocalSystem', docker: { serverOs: 'linux', serverVersion: '29' } }
  const docker = { preference: 'auto', ready: true, preferred: true }
  admin.settings.decryptApplicationDefaults = async () => ({})
  admin.workspace.loadRules = async () => ({ policy: { executionIdentity: 'root' } })
  admin.plan = async () => { throw new Error('AI must not be called') }
  const created = tasks.create('host', 'Deploy Magento', { kind: 'catalog', catalogId: 'magento-windows' })
  const original = buildCommonTask('magento-windows', created.id, { platform: 'windows', windowsExecution: execution, docker }).plan
  original.commands.at(-1).command = 'old restart verifier'
  tasks.savePlan('host', created.id, original)
  const lease = tasks.acquireExecution('host', created.id, original)
  for (const command of original.commands.slice(0, -1)) tasks.appendExecutionEvent('host', created.id, lease.owner, { type: 'command_completed', commandId: command.id, attemptId: command.id })
  tasks.appendExecutionEvent('host', created.id, lease.owner, { type: 'command_failed', commandId: original.commands.at(-1).id, attemptId: 'failed-verifier' })
  tasks.releaseExecution('host', created.id, lease.owner)
  const before = controller.inspect('host', created.id)
  admin.refreshInventory = async () => ({ webminaiExecution: { platform: 'linux' }, webminaiDocker: docker })
  await assert.rejects(controller.proposeCatalogRefresh('host', created.id, before.stateVersion), /verified windows/u)
  assert.equal(tasks.revisions('host', created.id).length, 0)
  admin.refreshInventory = async () => ({ webminaiExecution: execution, webminaiDocker: docker })
  const proposal = await controller.proposeCatalogRefresh('host', created.id, before.stateVersion)
  const revision = tasks.revisions('host', created.id).find(item => item.id === proposal.revisionId)
  assert.equal(revision.approved, 0)
  assert.deepEqual(revision.plan.commands.slice(0, -1), original.commands.slice(0, -1))
  assert.deepEqual(revision.plan.revertCommands, original.revertCommands)
  assert.notEqual(revision.plan.commands.at(-1).id, original.commands.at(-1).id)
  assert.deepEqual(tasks.get('host', created.id).plan, original)
  controller.approve('host', created.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  const approved = controller.inspect('host', created.id)
  assert.equal(approved.control.action, 'pause')
  await assert.rejects(controller.resume('host', created.id, before.stateVersion, before.fingerprint), /stale/u)
  assert.deepEqual(calls, [])
})

test('catalog refresh rejects stale inventory decisions and non-native targets without mutating history', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  const context = { fingerprint: 'fixture', identity: { id: 'ubuntu', versionId: '24.04', architecture: 'x86_64' }, management: { family: 'debian', packageManager: 'apt', serviceManager: 'systemd' }, applications: {} }
  admin.settings.decryptApplicationDefaults = async () => ({})
  const created = tasks.create('host', 'Deploy Ghost', { kind: 'catalog', catalogId: 'ghost-linux' })
  const original = buildCommonTask('ghost-linux', created.id, { platform: 'linux', linuxContext: context, docker: { preferred: false } }).plan
  tasks.savePlan('host', created.id, original)
  let before = controller.inspect('host', created.id)
  admin.refreshInventory = async () => ({ webminaiExecution: { platform: 'windows' } })
  await assert.rejects(controller.proposeCatalogRefresh('host', created.id, before.stateVersion), /native Linux/u)
  admin.refreshInventory = async () => ({ webminaiLinuxContext: context, webminaiDocker: { preferred: true } })
  await assert.rejects(controller.proposeCatalogRefresh('host', created.id, before.stateVersion), /native Linux/u)
  admin.refreshInventory = async () => {
    controller.control('host', created.id, 'pause', before.stateVersion)
    return { webminaiLinuxContext: context, webminaiDocker: { preferred: false } }
  }
  await assert.rejects(controller.proposeCatalogRefresh('host', created.id, before.stateVersion), /stale/u)
  before = controller.inspect('host', created.id)
  assert.deepEqual(before.task.plan, controller.sanitize(original))
  assert.equal(before.revisions.length, 0)
  assert.deepEqual(calls, [])
})

test('Windows Docker continuation refresh preserves completed installers and the existing BITS transfer', async t => {
  const { tasks, admin, controller, calls } = await fixture(t)
  const execution = { platform: 'windows' }
  const docker = { preference: 'auto', ready: false, preferred: false }
  admin.settings.decryptApplicationDefaults = async () => ({})
  admin.workspace.loadRules = async () => ({ policy: { executionIdentity: 'root' } })
  admin.plan = async () => { throw new Error('AI must not be called') }
  admin.refreshInventory = async () => ({ webminaiExecution: execution, webminaiDocker: docker })
  const task = tasks.create('host', 'Continue Docker installation', { kind: 'catalog', catalogId: 'docker-desktop-windows' })
  const original = buildCommonTask(task.catalogId, task.id, { platform: 'windows', windowsExecution: execution, docker }).plan
  tasks.savePlan('host', task.id, original)
  const index = original.commands.findIndex(command => command.id === 'wait-docker-download')
  const lease = tasks.acquireExecution('host', task.id, original)
  for (const command of original.commands.slice(0, index)) tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: command.id, attemptId: command.id })
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_failed', commandId: 'wait-docker-download', attemptId: 'bounded-poll-ended', metadata: { exitCode: 75 } })
  tasks.releaseExecution('host', task.id, lease.owner)
  const before = controller.inspect('host', task.id)
  const proposal = await controller.proposeCatalogRefresh('host', task.id, before.stateVersion)
  const revised = tasks.revisions('host', task.id).find(item => item.id === proposal.revisionId)
  assert.equal(revised.approved, 0)
  assert.deepEqual(revised.plan.commands.slice(0, index), original.commands.slice(0, index))
  assert.equal(revised.plan.commands[index].command, original.commands[index].command)
  assert.notEqual(revised.plan.commands[index].id, original.commands[index].id)
  assert.deepEqual(revised.plan.revertCommands, original.revertCommands)
  assert.equal(revised.plan.commands.filter(command => command.command === original.commands[index - 1].command).length, 1)
  assert.deepEqual(calls, [])
})

test('an empty replacement proposal cannot erase pending catalog work', async t => {
  const { controller, task, admin, calls } = await fixture(t)
  admin.plan = async () => ({ ...plan([]), summary: 'Inspect remaining registry differences before cleanup' })
  const before = controller.inspect('host', task.id)
  await assert.rejects(controller.propose('host', task.id, 'Update pending work', before.stateVersion), /no executable replacement commands.*Inspect remaining registry differences/iu)
  const after = controller.inspect('host', task.id)
  assert.deepEqual(after.task.plan, before.task.plan)
  assert.deepEqual(after.revisions, before.revisions)
  assert.deepEqual(calls, [])
})

test('an older empty proposal cannot receive fresh approval', async t => {
  const { controller, task, tasks, calls } = await fixture(t)
  const before = controller.inspect('host', task.id)
  const replacement = plan([])
  const id = tasks.proposeRevision('host', task.id, replacement, before.stateVersion)
  const view = controller.inspect('host', task.id)
  assert.throws(() => controller.approve('host', task.id, id, view.stateVersion, planFingerprint(replacement)), /no executable replacement commands/iu)
  assert.equal(tasks.revisions('host', task.id).find(item => item.id === id).approved, 0)
  assert.deepEqual(tasks.get('host', task.id).plan, before.task.plan)
  assert.deepEqual(calls, [])
})

test('pending revisions expose canonical review fingerprints without granting execution', async t => {
  const { controller, task, calls } = await fixture(t)
  const before = controller.inspect('host', task.id)
  const proposal = await controller.propose('host', task.id, 'Replace remaining inspection', before.stateVersion)
  const view = controller.inspect('host', task.id)
  const pending = view.revisions.find(revision => revision.id === proposal.revisionId)
  assert.equal(pending.approved, 0)
  assert.equal(pending.fingerprint, proposal.fingerprint)
  assert.deepEqual(pending.differences, proposal.differences)
  assert.throws(() => controller.approve('host', task.id, pending.id, view.stateVersion, 'invalid'), /approval does not match/u)
  controller.approve('host', task.id, pending.id, view.stateVersion, pending.fingerprint)
  assert.deepEqual(calls, [])
  assert.equal(controller.inspect('host', task.id).control.action, 'pause')
})

test('operator events enforce their UTF-8 byte limit without persisting oversized payloads', async t => {
  const { controller } = await fixture(t)
  assert.throws(() => controller.record({ type: 'inspection', evidence: '界'.repeat(50000) }), /size limit/u)
  assert.deepEqual(controller.events(), [])
  controller.record({ type: 'inspection', evidence: '界'.repeat(1000) })
  assert.equal(controller.events().length, 1)
})

test('pause takes effect only at a command boundary and resume skips confirmed commands', async t => {
  const { tasks, task, controller, admin, calls } = await fixture(t)
  const results = await admin.execute({
    settings: {},
    serverId: 'host',
    taskId: task.id,
    plan: task.plan,
    approve: async () => true,
    onResult: result => {
      tasks.appendResult('host', task.id, result)
      controller.control('host', task.id, 'pause', tasks.stateVersion('host', task.id))
    }
  })
  assert.equal(results.length, 1)
  assert.deepEqual(calls, ['echo first'])
  const view = controller.inspect('host', task.id)
  await controller.resume('host', task.id, view.stateVersion, view.fingerprint)
  assert.deepEqual(calls, ['echo first', 'echo second'])
})

test('immutable completed prefix and fresh approval are enforced across revisions', async t => {
  const { tasks, task, controller, calls } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'done' })
  tasks.releaseExecution('host', task.id, lease.owner)
  const view = controller.inspect('host', task.id)
  assert.throws(() => tasks.proposeRevision('host', task.id, plan(['bad']), view.stateVersion), /immutable/u)
  const proposal = await controller.propose('host', task.id, 'Use a different inspection', view.stateVersion)
  assert.equal(proposal.proposed.commands[0].id, 'first')
  assert.throws(() => controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, 'bad'), /approval/u)
  controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  await assert.rejects(controller.resume('host', task.id, view.stateVersion, view.fingerprint), /stale/u)
  const revised = controller.inspect('host', task.id)
  await controller.resume('host', task.id, revised.stateVersion, revised.fingerprint)
  assert.deepEqual(calls, ['echo revised'])
  assert.equal(tasks.revisions('host', task.id)[0].plan.commands[1].id, 'second')
})

test('replay and exports have no remote effects and stable event cursors', async t => {
  const { controller, tasks, task, calls } = await fixture(t)
  const run = controller.runs.create({ request: 'Inspect', serverIds: ['host'] })
  controller.runs.updateHost(run.id, 'host', { taskId: task.id })
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_prepared', commandId: 'first', metadata: { secret: 'known-secret' } })
  tasks.releaseExecution('host', task.id, lease.owner)
  const events = controller.events()
  assert.ok(events.length)
  assert.deepEqual(controller.events(events.at(-1).id), [])
  assert.doesNotMatch(JSON.stringify(controller.exportRun(run.id)), /known-secret/u)
  assert.deepEqual(calls, [])
})

test('event catch-up reads and commits each host page without per-event database opens', async t => {
  const { controller, tasks, task } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  for (let index = 0; index < 32; index++) tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_prepared', commandId: 'first', attemptId: `attempt-${index}` })
  tasks.releaseExecution('host', task.id, lease.owner)
  let taskAccess = 0
  let controllerAccess = 0
  const taskDatabase = tasks.withDatabase.bind(tasks)
  const eventDatabase = controller.database.bind(controller)
  tasks.withDatabase = (...args) => { taskAccess++; return taskDatabase(...args) }
  controller.database = (...args) => { controllerAccess++; return eventDatabase(...args) }
  const events = controller.events()
  assert.equal(events.length, 32)
  assert.ok(taskAccess <= 2, `host database opened ${taskAccess} times`)
  assert.ok(controllerAccess <= 4, `event database opened ${controllerAccess} times`)
  assert.deepEqual(controller.events(events.at(-1).id), [])
  assert.equal(controller.events().length, 32)
})

test('event page and cursor roll back together when mirroring fails', async t => {
  const { controller, tasks, task } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  for (const attemptId of ['first', 'second']) tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_prepared', commandId: 'first', attemptId })
  tasks.releaseExecution('host', task.id, lease.owner)
  const record = controller.record.bind(controller)
  let calls = 0
  controller.record = (...args) => { if (++calls === 2) throw new Error('fixture mirror failure'); return record(...args) }
  assert.throws(() => controller.events(), /mirror failure/u)
  assert.equal(controller.database(database => database.prepare('SELECT COUNT(*) count FROM events').get().count), 0)
  assert.equal(controller.database(database => database.prepare('SELECT COUNT(*) count FROM cursors').get().count), 0)
  controller.record = record
  assert.equal(controller.events().length, 2)
  assert.equal(controller.events().length, 2)
})

test('a stale catch-up page cannot rewind another console session cursor', async t => {
  const { controller, tasks, task, root } = await fixture(t)
  const append = attemptId => {
    const lease = tasks.acquireExecution('host', task.id, task.plan)
    tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_prepared', commandId: 'first', attemptId })
    tasks.releaseExecution('host', task.id, lease.owner)
  }
  append('one')
  append('two')
  const other = new OperatorController({ dataRoot: root, settings: controller.settings })
  const read = tasks.hostExecutionEvents.bind(tasks)
  let interleaved = false
  tasks.hostExecutionEvents = (...args) => {
    const rows = read(...args)
    if (!interleaved) {
      interleaved = true
      append('three')
      assert.equal(other.events().length, 3)
    }
    return rows
  }
  assert.equal(controller.events().length, 3)
  const cursor = controller.database(database => database.prepare('SELECT event_id FROM cursors WHERE host_id = ?').get('host').event_id)
  assert.equal(cursor, tasks.executionEvents('host', task.id).at(-1).id)
  assert.equal(controller.events().length, 3)
  for (const options of [{ after: -1 }, { after: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 1001 }]) assert.throws(() => read('host', options), /range/u)
})

test('attempt-bound memory evidence survives reconciliation, streaming and sanitized replay without authorizing work', async t => {
  const { controller, tasks, task, calls, admin } = await fixture(t)
  const baseline = { availability: 'available', platform: 'linux', bootId: 'boot-a', scopeId: 'scope-a', oomKills: 0, observedAt: '2026-10-16T01:00:00Z' }
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_prepared', commandId: 'first', attemptId: 'old', metadata: { evidenceBefore: { ...baseline, oomKills: 99 } } })
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_prepared', commandId: 'first', attemptId: 'current', metadata: { evidenceBefore: baseline } })
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_dispatched', commandId: 'first', attemptId: 'current' })
  tasks.releaseExecution('host', task.id, lease.owner)
  admin.netdata = () => ({ collectExecutionEvidence: async () => ({ ...baseline, oomKills: 1, observedAt: '2026-10-16T01:05:00Z' }) })
  await controller.reconcile('host', task.id, tasks.stateVersion('host', task.id))
  assert.equal(tasks.executionState('host', task.id)[0].status, 'uncertain')
  const events = controller.events()
  const evidence = events.find(event => event.metadata.diagnostics?.some(value => value.code === 'OOM_KILL'))
  assert.equal(evidence.attemptId, 'current')
  assert.equal(evidence.metadata.diagnostics.find(value => value.code === 'OOM_KILL').evidence.delta, 1)
  assert.equal(controller.inspect('host', task.id).task.executionDiagnostics.length, 1)
  const run = controller.runs.create({ request: 'Inspect', serverIds: ['host'] })
  controller.runs.updateHost(run.id, 'host', { taskId: task.id })
  const bundle = controller.exportRun(run.id)
  assert.match(JSON.stringify(bundle), /OOM_KILL/u)
  assert.deepEqual(calls, [])
})

test('rollback attestation uses the original revision identifier without disclosing evidence', async t => {
  const { tasks, task, controller, calls } = await fixture(t)
  const rollbackRevision = planFingerprint([command('cleanup')])
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_outcome_unknown', commandId: 'cleanup', attemptId: 'rollback-attempt', metadata: { operation: 'rollback', rollbackRevision } })
  tasks.releaseExecution('host', task.id, lease.owner)
  const view = controller.inspect('host', task.id)
  const pending = view.rollbackCommands[0]
  assert.equal(pending.rollbackRevision, rollbackRevision)
  const resolved = controller.resolve('host', task.id, view.stateVersion, pending.commandId, 'failed', 'Independent evidence: password=private-value; partial cleanup remains', pending.rollbackRevision)
  assert.equal(resolved.rollbackCommands[0].status, 'failed')
  assert.deepEqual(calls, [])
  assert.doesNotMatch(JSON.stringify(resolved), /private-value/u)
  assert.throws(() => controller.resolve('host', task.id, view.stateVersion, pending.commandId, 'completed', 'Independent evidence', pending.rollbackRevision), /stale/u)
})

test('reviewed resolution clears interrupted status only after every uncertain apply outcome is resolved', async t => {
  const { tasks, task, controller, calls } = await fixture(t)
  tasks.markRunning('host', task.id)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  for (const commandId of ['first', 'second']) tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_dispatched', commandId, attemptId: commandId + '-attempt' })
  tasks.releaseExecution('host', task.id, lease.owner)
  controller.resolve('host', task.id, tasks.stateVersion('host', task.id), 'first', 'completed', 'Authoritative remote job result verified by operator')
  assert.equal(tasks.get('host', task.id).status, 'running')
  assert.equal(tasks.interruptedTasks('host').length, 1)
  controller.resolve('host', task.id, tasks.stateVersion('host', task.id), 'second', 'failed', 'Authoritative remote failure verified by operator')
  assert.equal(tasks.get('host', task.id).status, 'partial')
  assert.equal(tasks.interruptedTasks('host').length, 0)
  assert.deepEqual(tasks.executionState('host', task.id).map(command => command.status), ['completed', 'failed'])
  assert.deepEqual(calls, [])
})

test('unknown dispatch requires remote evidence or explicit attestation, never an automatic rerun', async t => {
  const { tasks, task, controller, calls, admin } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_dispatched', commandId: 'first', attemptId: 'attempt' })
  tasks.releaseExecution('host', task.id, lease.owner)
  let view = controller.inspect('host', task.id)
  await assert.rejects(controller.resume('host', task.id, view.stateVersion, view.fingerprint), /reconciliation/u)
  assert.deepEqual(calls, [])
  view = controller.inspect('host', task.id)
  assert.throws(() => controller.resolve('host', task.id, view.stateVersion, 'first', 'pending', 'Remote evidence'), /reviewed/u)
  controller.resolve('host', task.id, view.stateVersion, 'first', 'completed', 'Confirmed against remote audit record')
  view = controller.inspect('host', task.id)
  await controller.resume('host', task.id, view.stateVersion, view.fingerprint)
  assert.deepEqual(calls, ['echo second'])
  const other = tasks.savePlan('host', tasks.create('host', 'Inspect durable job').id, plan(['remote']))
  const otherLease = tasks.acquireExecution('host', other.id, other.plan)
  tasks.appendExecutionEvent('host', other.id, otherLease.owner, { type: 'command_acknowledged', commandId: 'remote', attemptId: 'remote-attempt', metadata: { jobId: 'job-1' } })
  tasks.releaseExecution('host', other.id, otherLease.owner)
  admin.netdata = () => ({ jobStatus: async () => ({ state: 'unknown', exitCode: null }) })
  await controller.reconcile('host', other.id, tasks.stateVersion('host', other.id))
  assert.equal(tasks.executionState('host', other.id)[0].status, 'uncertain')
  assert.ok(tasks.executionEvents('host', other.id).some(event => event.type === 'execution_recovery' && event.metadata.state === 'operator_review_required'))
  view = controller.inspect('host', other.id)
  await assert.rejects(controller.resume('host', other.id, view.stateVersion, view.fingerprint), /reconciliation/u)
  assert.deepEqual(calls, ['echo second'])
  admin.netdata = () => ({ jobStatus: async id => { assert.equal(id, 'job-1'); return { state: 'succeeded', exitCode: 0 } } })
  await controller.reconcile('host', other.id, tasks.stateVersion('host', other.id))
  assert.equal(tasks.executionState('host', other.id)[0].status, 'completed')
})

test('approved rollback is journaled, never repeated, and prevents deployment continuation', async t => {
  const { tasks, task, controller, calls } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  for (const commandId of ['first', 'second']) tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId, attemptId: commandId })
  tasks.releaseExecution('host', task.id, lease.owner)
  const view = controller.inspect('host', task.id)
  const proposal = await controller.propose('host', task.id, 'Revert confirmed changes', view.stateVersion, true)
  controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  let approved = controller.inspect('host', task.id)
  await controller.rollback('host', task.id, approved.stateVersion, approved.reviewedRollbackFingerprint, proposal.revisionId)
  approved = controller.inspect('host', task.id)
  await controller.rollback('host', task.id, approved.stateVersion, approved.reviewedRollbackFingerprint, proposal.revisionId)
  assert.deepEqual(calls, ['echo revised'])
  assert.equal(tasks.get('host', task.id).status, 'reverted')
  approved = controller.inspect('host', task.id)
  const events = tasks.allExecutionEvents('host', task.id)
  controller.adminFor = async () => { throw new Error('Reverted work must not open a remote session') }
  await assert.rejects(controller.resume('host', task.id, approved.stateVersion, approved.fingerprint), /rollback has started/u)
  assert.deepEqual(tasks.allExecutionEvents('host', task.id), events)
})

test('rollback checks uncertain outcomes after acquiring execution ownership', async t => {
  const { tasks, task, admin, calls } = await fixture(t)
  const saved = tasks.savePlan('host', task.id, { ...task.plan, revertCommands: [command('undo')] })
  admin.serverSecrets = async () => {
    const lease = tasks.acquireExecution('host', task.id, saved.plan)
    try {
      tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_dispatched', commandId: 'first', attemptId: 'other-operator' })
    } finally { tasks.releaseExecution('host', task.id, lease.owner) }
    return {}
  }
  await assert.rejects(admin.revertTask({ settings: {}, serverId: 'host', taskId: task.id, approve: async () => true }), /uncertain/u)
  assert.deepEqual(calls, [])
})

test('reviewed rollback rechecks newly completed commands after opening the host', async t => {
  const { tasks, task, admin, calls } = await fixture(t)
  admin.serverSecrets = async () => {
    const lease = tasks.acquireExecution('host', task.id, task.plan)
    try {
      tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'other-operator' })
    } finally { tasks.releaseExecution('host', task.id, lease.owner) }
    return {}
  }
  await assert.rejects(admin.revertTask({ settings: {}, serverId: 'host', taskId: task.id, reviewedPlan: { ...plan(['first']), operatorRollback: true }, approve: async () => true }), /executed deployment command/u)
  assert.deepEqual(calls, [])
})

test('operator rollback updates its linked host and aggregate run status', async t => {
  for (const [otherHost, exitCode, expected] of [[false, 0, 'reverted'], [true, 0, 'partial'], [true, 1, 'revert_failed']]) {
    await t.test(expected, async t => {
      const { tasks, controller, admin } = await fixture(t)
      const run = controller.runs.create({ request: 'Grouped operation', serverIds: otherHost ? ['host', 'other'] : ['host'] })
      const created = tasks.create('host', 'Grouped operation', { groupRunId: run.id })
      const task = tasks.savePlan('host', created.id, { ...plan(['first']), revertCommands: [command('undo')] })
      controller.runs.updateHost(run.id, 'host', { taskId: task.id, status: 'completed' })
      if (otherHost) controller.runs.updateHost(run.id, 'other', { status: 'completed' })
      const lease = tasks.acquireExecution('host', task.id, task.plan)
      tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'done' })
      tasks.releaseExecution('host', task.id, lease.owner)
      admin.netdata = () => ({ runCommand: async () => ({ exitCode, stdout: '', stderr: '' }) })
      const view = controller.inspect('host', task.id)
      await controller.rollback('host', task.id, view.stateVersion, view.rollbackFingerprint)
      const saved = controller.runs.get(run.id)
      assert.equal(saved.hosts.find(host => host.serverId === 'host').status, exitCode === 0 ? 'reverted' : 'revert_failed')
      assert.equal(saved.status, expected)
      if (otherHost) assert.equal(saved.hosts.find(host => host.serverId === 'other').status, 'completed')
    })
  }
})

test('public views exclude raw outputs, encoded database projections, and the vault passphrase', async t => {
  const { tasks, task, controller } = await fixture(t)
  controller.passphrase = 'known-vault-passphrase'
  tasks.appendResult('host', task.id, { id: 'first', status: 'completed', result: { exitCode: 0, stdout: 'unlabelled-password', stderr: 'private material' } })
  controller.record({ type: 'diagnostic', message: 'known-vault-passphrase', credential: 'credential-value' })
  const view = JSON.stringify(controller.inspect('host', task.id))
  assert.doesNotMatch(view, /unlabelled-password|private material|resultsJson/u)
  assert.doesNotMatch(JSON.stringify(controller.events()), /known-vault-passphrase|credential-value/u)
})

test('read-only analysis of a common-task plan redacts the vault secret and never executes commands', async t => {
  const { tasks, task, controller, admin, calls } = await fixture(t)
  const approved = buildCommonTask('host-health-linux', task.id, { platform: 'linux' }).plan
  tasks.savePlan('host', task.id, approved)
  controller.passphrase = 'known-vault-passphrase'
  const version = tasks.stateVersion('host', task.id)
  admin.consult = async options => {
    assert.ok(!options.question.includes(controller.passphrase))
    assert.match(options.question, /Recorded execution evidence/u)
    return { answer: 'Only recorded observations were analyzed.' }
  }
  const answer = await controller.analyze('host', task.id, 'Inspect this task. known-vault-passphrase')
  assert.equal(answer.answer, 'Only recorded observations were analyzed.')
  assert.deepEqual(calls, [])
  assert.equal(tasks.stateVersion('host', task.id), version)
  assert.deepEqual(tasks.get('host', task.id).plan, approved)
})

test('an AI-supplied rollback flag cannot turn an ordinary revision into cleanup', async t => {
  const { tasks, task, controller, admin, calls } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'confirmed' })
  tasks.releaseExecution('host', task.id, lease.owner)
  admin.plan = async () => ({ ...plan(['revised']), operatorRollback: true })
  const before = controller.inspect('host', task.id)
  const proposal = await controller.propose('host', task.id, 'Inspect remaining state', before.stateVersion)
  assert.equal(proposal.proposed.operatorRollback, false)
  controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  const saved = controller.inspect('host', task.id)
  assert.deepEqual(saved.task.plan.commands.map(item => item.id), ['first', 'revised'])
  assert.equal(saved.reviewedRollbackFingerprint, null)
  assert.deepEqual(calls, [])
})

test('legacy reviewed rollback revisions cannot repeat completed deployment commands', async t => {
  const { tasks, task, controller, calls } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'confirmed' })
  tasks.releaseExecution('host', task.id, lease.owner)
  const revision = { ...plan(['first', 'cleanup']), operatorRollback: true }
  const version = tasks.stateVersion('host', task.id)
  const revisionId = tasks.proposeRevision('host', task.id, revision, version)
  controller.approve('host', task.id, revisionId, version, planFingerprint(revision))
  const approved = controller.inspect('host', task.id)
  await assert.rejects(controller.rollback('host', task.id, approved.stateVersion, approved.reviewedRollbackFingerprint, revisionId), /executed deployment command/u)
  assert.deepEqual(calls, [])
})

test('a reviewed changing rollback does not require a rollback of its own', async t => {
  const { root, tasks, task, controller, admin, calls } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'confirmed' })
  tasks.releaseExecution('host', task.id, lease.owner)
  const cleanup = { ...plan(['cleanup']), commands: [{ ...command('cleanup'), command: 'rm -f /tmp/intent-fixture', risk: 'change' }] }
  admin.planner = new CodexPlanner()
  admin.planner.runStructured = async () => JSON.stringify(cleanup)
  admin.plan = AdminService.prototype.plan.bind(admin)
  admin.refreshInventory = async () => ({ os: 'linux' })
  admin.workspace.loadRules = async () => ({ policy: {}, preferences: { docker: 'auto' } })
  admin.workspace.directory = () => root
  await assert.rejects(admin.plan({ settings: {}, serverId: 'host', request: 'Change a fixture' }), /requires revert commands/u)
  const before = controller.inspect('host', task.id)
  const proposed = await controller.propose('host', task.id, 'Revert the confirmed fixture change', before.stateVersion, true)
  assert.equal(proposed.proposed.operatorRollback, true)
  assert.deepEqual(calls, [])
  controller.approve('host', task.id, proposed.revisionId, proposed.expectedVersion, proposed.fingerprint)
  const approved = controller.inspect('host', task.id)
  await controller.rollback('host', task.id, approved.stateVersion, approved.reviewedRollbackFingerprint, proposed.revisionId)
  assert.deepEqual(calls, ['rm -f /tmp/intent-fixture'])
})

test('revision approval responses redact a vault secret present in the original request', async t => {
  const { tasks, controller } = await fixture(t)
  controller.passphrase = 'known-vault-passphrase'
  const task = tasks.savePlan('host', tasks.create('host', 'Inspect known-vault-passphrase').id, plan(['inspect']))
  const before = controller.inspect('host', task.id)
  const proposed = await controller.propose('host', task.id, 'Replace the pending inspection', before.stateVersion)
  const approved = controller.approve('host', task.id, proposed.revisionId, proposed.expectedVersion, proposed.fingerprint)
  assert.ok(!JSON.stringify(approved).includes(controller.passphrase))
})

test('an approved update can resume only its read-only report without reauthorizing changes', async t => {
  const { tasks, controller, calls } = await fixture(t)
  const approved = plan(['updated', 'report'])
  approved.commands[0].risk = 'change'
  const task = tasks.savePlan('host', tasks.create('host', 'Approved one-way update').id, approved)
  const lease = tasks.acquireExecution('host', task.id, approved)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'updated', attemptId: 'confirmed-update' })
  tasks.releaseExecution('host', task.id, lease.owner)
  const before = controller.inspect('host', task.id)
  await controller.resume('host', task.id, before.stateVersion, before.fingerprint)
  assert.deepEqual(calls, ['echo report'])
  const pending = tasks.savePlan('host', tasks.create('host', 'Unexecuted changing plan').id, approved)
  const view = controller.inspect('host', pending.id)
  await assert.rejects(controller.resume('host', pending.id, view.stateVersion, view.fingerprint), /requires revert commands/u)
  assert.deepEqual(calls, ['echo report'])
})

test('aborted work requires a newly approved revision and competing approvals are rejected', async t => {
  const { task, controller } = await fixture(t)
  const original = controller.inspect('host', task.id)
  controller.control('host', task.id, 'abort', original.stateVersion)
  const aborted = controller.inspect('host', task.id)
  await assert.rejects(controller.resume('host', task.id, aborted.stateVersion, aborted.fingerprint), /aborted/u)
  const proposal = await controller.propose('host', task.id, 'Replace aborted work', aborted.stateVersion)
  controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
  assert.throws(() => controller.approve('host', task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint), /stale/u)
  const approved = controller.inspect('host', task.id)
  assert.equal(approved.control.action, 'pause')
  await controller.resume('host', task.id, approved.stateVersion, approved.fingerprint)
})

test('console error responses redact the vault passphrase even without a credential label', async t => {
  const { controller, task, calls } = await fixture(t)
  controller.passphrase = 'unlabelled-vault-fixture'
  controller.analyze = async () => { throw new Error(`Inspection of ${controller.passphrase} was denied`) }
  const consoleServer = await startOperatorConsole({ controller, actions: true })
  t.after(() => consoleServer.close())
  const headers = { 'Content-Type': 'application/json' }
  const login = await fetch(`${consoleServer.origin}/session`, { method: 'POST', headers, body: JSON.stringify({ token: new URL(consoleServer.url).hash.slice(1) }) })
  const session = await login.json()
  const response = await fetch(`${consoleServer.origin}/action`, {
    method: 'POST',
    headers: { ...headers, Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Intent-CSRF': session.csrf },
    body: JSON.stringify({ action: 'analyze', hostId: 'host', taskId: task.id, question: 'Inspect recorded state' })
  })
  assert.equal(response.status, 409)
  const body = await response.text()
  assert.ok(!body.includes(controller.passphrase))
  assert.match(body, /redacted/u)
  assert.deepEqual(calls, [])
})

test('console proposals require separate approval and resume with canonical decision tokens', async t => {
  const { controller, task, calls } = await fixture(t)
  const server = await startOperatorConsole({ controller, actions: true })
  t.after(() => server.close())
  const login = await fetch(`${server.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
  const session = await login.json()
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0], 'X-Intent-CSRF': session.csrf }
  const post = body => fetch(`${server.origin}/action`, { method: 'POST', headers, body: JSON.stringify(body) })
  const inspect = async () => (await fetch(`${server.origin}/task?host=host&task=${task.id}`, { headers })).json()
  const initial = await inspect()
  const proposed = await post({ action: 'propose', hostId: 'host', taskId: task.id, instructions: 'Replace pending inspection', expectedVersion: initial.stateVersion })
  assert.equal(proposed.status, 200)
  const proposal = await proposed.json()
  assert.match(proposal.fingerprint, /^[a-f0-9]{64}$/u)
  assert.equal(proposal.expectedVersion, initial.stateVersion)
  assert.equal((await inspect()).revisions.find(revision => revision.id === proposal.revisionId).fingerprint, proposal.fingerprint)
  const approval = { action: 'approve', hostId: 'host', taskId: task.id, expectedVersion: proposal.expectedVersion, fingerprint: proposal.fingerprint, revisionId: proposal.revisionId }
  assert.equal((await post(approval)).status, 409)
  assert.deepEqual(calls, [])
  assert.equal((await post({ ...approval, approved: true })).status, 200)
  const reviewed = await inspect()
  assert.equal(reviewed.control.action, 'pause')
  assert.deepEqual(calls, [])
  const resume = { action: 'resume', hostId: 'host', taskId: task.id, expectedVersion: reviewed.stateVersion, fingerprint: reviewed.fingerprint, approved: true }
  assert.equal((await post(resume)).status, 200)
  for (let attempt = 0; attempt < 100 && controller.inspect('host', task.id).task.status !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(controller.inspect('host', task.id).task.status, 'completed')
  assert.deepEqual(calls, ['echo revised'])
  assert.equal((await post(resume)).status, 409)
  assert.deepEqual(calls, ['echo revised'])
})

test('console enforces authentication, origin, CSRF, read-only mode, and stale approvals', async t => {
  const { controller, task } = await fixture(t)
  const consoleServer = await startOperatorConsole({ controller })
  t.after(() => consoleServer.close())
  const headers = { 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${consoleServer.origin}/snapshot`)).status, 401)
  assert.equal((await fetch(`${consoleServer.origin}/events`)).status, 401)
  const login = await fetch(`${consoleServer.origin}/session`, { method: 'POST', headers, body: JSON.stringify({ token: new URL(consoleServer.url).hash.slice(1) }) })
  const session = await login.json()
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const view = await (await fetch(`${consoleServer.origin}/task?host=host&task=${task.id}`, { headers: { Cookie: cookie } })).json()
  assert.equal(view.fingerprint, planFingerprint(task.plan))
  assert.equal((await fetch(`${consoleServer.origin}/snapshot`, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403)
  const body = JSON.stringify({ action: 'pause', hostId: 'host', taskId: task.id, expectedVersion: view.stateVersion })
  assert.equal((await fetch(`${consoleServer.origin}/action`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-Intent-CSRF': session.csrf }, body })).status, 403)
  const writable = await startOperatorConsole({ controller, actions: true })
  t.after(() => writable.close())
  const authorized = await fetch(`${writable.origin}/session`, { method: 'POST', headers, body: JSON.stringify({ token: new URL(writable.url).hash.slice(1) }) })
  const authorizedSession = await authorized.json()
  const authCookie = authorized.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(`${writable.origin}/action`, { method: 'POST', headers: { ...headers, Cookie: authCookie }, body })).status, 403)
  const safeHeaders = { ...headers, Cookie: authCookie, 'X-Intent-CSRF': authorizedSession.csrf }
  assert.equal((await fetch(`${writable.origin}/action`, { method: 'POST', headers: safeHeaders, body: JSON.stringify({ action: 'execute', command: 'echo unsafe' }) })).status, 409)
  assert.equal((await fetch(`${writable.origin}/action`, { method: 'POST', headers: safeHeaders, body })).status, 200)
  assert.equal((await fetch(`${writable.origin}/action`, { method: 'POST', headers: safeHeaders, body })).status, 409)
  controller.record({ type: 'stream-one' })
  const firstEvent = controller.events().at(-1)
  controller.record({ type: 'stream-two' })
  const signal = AbortSignal.timeout(3000)
  const subscription = await fetch(`${writable.origin}/events`, { headers: { Cookie: authCookie, 'Last-Event-ID': String(firstEvent.id) }, signal })
  const reader = subscription.body.getReader()
  const chunk = new TextDecoder().decode((await reader.read()).value)
  assert.match(chunk, /stream-two/u)
  assert.doesNotMatch(chunk, /stream-one/u)
  await reader.cancel()
})

test('a paused run prevents dispatch even when hosts were still being planned', async t => {
  const { root, tasks } = await fixture(t)
  const calls = []
  const controller = new OperatorController({ dataRoot: root, tasks, settings: { servers: { canary: {}, remaining: {} } } })
  const service = new MultiHostService({
    dataRoot: root,
    runs: controller.runs,
    adminFor: host => ({
      createTask: (id, request, options) => tasks.create(id, request, options),
      listPendingConsultations: () => [],
      plan: async () => plan(['inspect']),
      saveTaskPlan: (id, taskId, plan) => tasks.savePlan(id, taskId, plan),
      execute: async () => calls.push(host)
    })
  })
  const run = await service.run({ settings: {}, serverIds: ['canary', 'remaining'], request: 'Inspect', rollout: { canaryHostId: 'canary' }, onEvent: event => { if (event.type === 'planning') controller.pauseRun(event.runId) } })
  assert.deepEqual(calls, [])
  assert.ok(run.hosts.every(host => host.status === 'planned'))
  assert.equal(controller.runs.control(run.id).action, 'pause')
})

test('staged rollout stops after canary failure without executing remaining hosts', async t => {
  const { root } = await fixture(t)
  const called = []
  const tasks = new TaskStore(root)
  const adminFor = host => ({
    createTask: (id, request, options) => tasks.create(id, request, options),
    plan: async () => plan(['check']),
    listPendingConsultations: () => [],
    saveTaskPlan: (id, taskId, plan) => tasks.savePlan(id, taskId, plan),
    markTaskRunning: (id, taskId) => tasks.markRunning(id, taskId),
    saveTaskError: (id, taskId, error) => tasks.saveError(id, taskId, error),
    execute: async () => { called.push(host); throw new Error('canary health failed') }
  })
  const service = new MultiHostService({ dataRoot: root, adminFor })
  const run = await service.run({ settings: {}, serverIds: ['canary', 'remaining'], request: 'Inspect', rollout: { canaryHostId: 'canary', batchSize: 1 }, review: async () => true })
  assert.deepEqual(called, ['canary'])
  assert.equal(run.hosts.find(host => host.serverId === 'remaining').status, 'planned')
})

test('boundary pause never interrupts an in-flight command', async () => {
  let released
  let paused = false
  const calls = []
  const execution = executeApprovedPlan({ plan: plan(['first', 'second']), policy: {}, approve: async () => true, beforeCommand: async () => !paused, netdata: { runCommand: async text => { calls.push(text); await new Promise(resolve => { released = resolve }); return { exitCode: 0 } } } })
  await new Promise(resolve => setImmediate(resolve))
  paused = true
  assert.deepEqual(calls, ['echo first'])
  released()
  assert.equal((await execution).length, 1)
})

test('console streams large recorded events through backpressure without dropping the connection', async t => {
  const { controller } = await fixture(t)
  controller.record({ type: 'large-frame', message: 'x'.repeat(96 * 1024) })
  controller.record({ type: 'after-large-frame' })
  const server = await startOperatorConsole({ controller })
  t.after(() => server.close())
  const login = await fetch(`${server.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const stream = await fetch(`${server.origin}/events`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) })
  const reader = stream.body.getReader()
  let body = ''
  while (!body.includes('after-large-frame')) {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    body += new TextDecoder().decode(chunk.value)
  }
  assert.ok(body.includes('large-frame'))
  assert.ok(body.includes('x'.repeat(96 * 1024)))
  await reader.cancel()
})

test('console streams new events after an authenticated subscription is already open', async t => {
  const { controller } = await fixture(t)
  const server = await startOperatorConsole({ controller })
  t.after(() => server.close())
  const login = await fetch(`${server.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  await login.json()
  const stream = await fetch(`${server.origin}/events`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(4000) })
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/)
  controller.record({ type: 'recorded-after-subscription' })
  let body = ''
  while (!body.includes('recorded-after-subscription')) {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    body += new TextDecoder().decode(chunk.value)
  }
  await reader.cancel()
})
