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
import { executeApprovedPlan } from '../src/plan-validator.js'
import { MultiHostService } from '../src/multi-host-service.js'

const command = id => ({ id, command: `echo ${id}`, purpose: 'Inspect', risk: 'read', timeoutMs: 1000, requiresSudo: false, dependsOn: [] })
const plan = ids => ({ summary: 'Inspect', changeOverview: 'Inspect state', modifiedFiles: [], commands: ids.map(command), revertCommands: [] })

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

test('unknown dispatch requires remote evidence or explicit attestation, never an automatic rerun', async t => {
  const { tasks, task, controller, calls, admin } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_dispatched', commandId: 'first', attemptId: 'attempt' })
  tasks.releaseExecution('host', task.id, lease.owner)
  let view = controller.inspect('host', task.id)
  await assert.rejects(controller.resume('host', task.id, view.stateVersion, view.fingerprint), /reconciliation/u)
  assert.deepEqual(calls, [])
  assert.throws(() => controller.resolve('host', task.id, view.stateVersion, 'first', 'pending', 'Remote evidence'), /reviewed/u)
  controller.resolve('host', task.id, view.stateVersion, 'first', 'completed', 'Confirmed against remote audit record')
  view = controller.inspect('host', task.id)
  await controller.resume('host', task.id, view.stateVersion, view.fingerprint)
  assert.deepEqual(calls, ['echo second'])
  const other = tasks.savePlan('host', tasks.create('host', 'Inspect durable job').id, plan(['remote']))
  const otherLease = tasks.acquireExecution('host', other.id, other.plan)
  tasks.appendExecutionEvent('host', other.id, otherLease.owner, { type: 'command_acknowledged', commandId: 'remote', attemptId: 'remote-attempt', metadata: { jobId: 'job-1' } })
  tasks.releaseExecution('host', other.id, otherLease.owner)
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
  await assert.rejects(controller.resume('host', task.id, approved.stateVersion, approved.fingerprint), /rollback has started/u)
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
