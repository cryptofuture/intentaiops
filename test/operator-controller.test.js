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
import { buildCommonTask } from '../src/common-tasks.js'

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
  await assert.rejects(controller.resume('host', task.id, approved.stateVersion, approved.fingerprint), /rollback has started/u)
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

test('a reviewed changing rollback does not require a rollback of its own', async t => {
  const { tasks, task, controller, admin, calls } = await fixture(t)
  const lease = tasks.acquireExecution('host', task.id, task.plan)
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'confirmed' })
  tasks.releaseExecution('host', task.id, lease.owner)
  admin.plan = async () => ({ ...plan(['cleanup']), commands: [{ ...command('cleanup'), command: 'rm -f /tmp/intent-fixture', risk: 'change' }] })
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
