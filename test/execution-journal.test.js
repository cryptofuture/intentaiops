import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TaskStore } from '../src/task-store.js'
import { executeApprovedPlan } from '../src/plan-validator.js'
import { detectOperationLoop } from '../src/operation-loop-detector.js'
import { AdminService } from '../src/admin-service.js'
import { planFingerprint } from '../src/execution-journal.js'

test('Linux crash worker requires explicit lab opt-in and rejects unrelated hosts', () => {
  const worker = fileURLToPath(new URL('../scripts/linux-reliability-worker.js', import.meta.url))
  const disabled = spawnSync(process.execPath, [worker, 'webminai-test', '1', 'prepared'], { env: { ...process.env, INTENT_LINUX_LAB_ALLOW: '0' }, encoding: 'utf8' })
  assert.notEqual(disabled.status, 0)
  assert.match(disabled.stderr, /explicit disposable lab configuration required/u)
  const unrelated = spawnSync(process.execPath, [worker, 'production', '1', 'prepared'], { env: { ...process.env, INTENT_LINUX_LAB_ALLOW: '1', VAULT_TEST: 'fixture-only', WEBMINAI_DATA_ROOT: '/nonexistent-intent-test-vault' }, encoding: 'utf8' })
  assert.notEqual(unrelated.status, 0)
  assert.match(unrelated.stderr, /invalid crash fixture/u)
})

function plan () {
  return {
    summary: 'Inspect',
    changeOverview: 'Read state',
    modifiedFiles: [],
    revertCommands: [],
    commands: [
      { id: 'first', command: 'uptime', risk: 'read', timeoutMs: 1000, dependsOn: [] },
      { id: 'second', command: 'date', risk: 'read', timeoutMs: 1000, dependsOn: ['first'] }
    ]
  }
}

test('journal is durable, redacted, lease protected, and blocks plan replacement', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-execution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)
  const task = store.create('host', 'Inspect', { groupRunId: 4 })
  store.savePlan('host', task.id, plan())
  const lease = store.acquireExecution('host', task.id, plan())
  assert.throws(() => store.acquireExecution('host', task.id, plan()), /another operator/u)
  const write = event => store.appendExecutionEvent('host', task.id, lease.owner, event)
  write({ type: 'command_prepared', commandId: 'first', attemptId: 'attempt-1' })
  assert.equal(store.executionState('host', task.id)[0].status, 'pending')
  write({ type: 'command_dispatched', commandId: 'first', attemptId: 'attempt-1', metadata: { password: 'known-secret', stdout: 'private-output' } })
  write({ type: 'command_acknowledged', commandId: 'first', attemptId: 'attempt-1', metadata: { jobId: 'a'.repeat(32) } })
  write({ type: 'command_outcome_unknown', commandId: 'first', attemptId: 'attempt-1' })
  assert.equal(store.executionState('host', task.id)[0].jobId, 'a'.repeat(32))
  assert.equal(new TaskStore(root).executionState('host', task.id)[0].status, 'uncertain')
  assert.doesNotMatch(JSON.stringify(store.executionEvents('host', task.id)), /known-secret|private-output/u)
  assert.throws(() => store.savePlan('host', task.id, plan()), /immutable/u)
  store.releaseExecution('host', task.id, lease.owner)
  assert.throws(() => write({ type: 'execution_resumed' }), /ownership/u)
})

test('lease diagnostics distinguish expiry, replacement and removal without renewing expired ownership', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-lease-diagnostics-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const store = new TaskStore(root)
  const task = store.create('host', 'Inspect lease')
  store.savePlan('host', task.id, plan())
  const original = store.acquireExecution('host', task.id, plan())
  now += 30001
  assert.throws(() => store.renewExecution('host', task.id, original.owner), { code: 'EXECUTION_LEASE_EXPIRED' })
  const next = store.acquireExecution('host', task.id, plan())
  assert.throws(() => store.renewExecution('host', task.id, original.owner), { code: 'EXECUTION_LEASE_REPLACED' })
  store.renewExecution('host', task.id, next.owner)
  store.releaseExecution('host', task.id, next.owner)
  assert.throws(() => store.renewExecution('host', task.id, original.owner), { code: 'EXECUTION_LEASE_MISSING' })
  assert.equal(store.executionEvents('host', task.id).length, 0)
})

test('retry descendants cannot acquire execution while an ancestor outcome is uncertain', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-retry-uncertain-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)
  const original = store.savePlan('host', store.create('host', 'Inspect').id, plan())
  const lease = store.acquireExecution('host', original.id, plan())
  store.appendExecutionEvent('host', original.id, lease.owner, { type: 'command_dispatched', commandId: 'first', attemptId: 'lost' })
  store.releaseExecution('host', original.id, lease.owner)
  const child = store.savePlan('host', store.create('host', 'Retry', { retryOfTaskId: original.id }).id, plan())
  const grandchild = store.savePlan('host', store.create('host', 'Retry again', { retryOfTaskId: child.id }).id, plan())
  for (const task of [child, grandchild]) assert.throws(() => store.acquireExecution('host', task.id, task.plan), /reconcil/u)
  let called = false
  const admin = new AdminService({ dataRoot: root, tasks: store, workspace: { loadRules: async () => ({ policy: {} }) } })
  admin.serverSecrets = async () => ({})
  admin.netdata = () => ({ runCommand: async () => { called = true; return { exitCode: 0 } } })
  await assert.rejects(admin.execute({ settings: {}, serverId: 'host', taskId: child.id, plan: child.plan, approve: async () => true }), /reconcil/u)
  assert.equal(called, false)
  const reconciler = store.acquireExecution('host', original.id, plan())
  store.appendExecutionEvent('host', original.id, reconciler.owner, { type: 'command_failed', commandId: 'first', attemptId: 'lost', metadata: { exitCode: 1 } })
  store.releaseExecution('host', original.id, reconciler.owner)
  const reviewed = store.acquireExecution('host', child.id, child.plan)
  store.releaseExecution('host', child.id, reviewed.owner)
})

test('execution leases exclude retry siblings and ancestors but not unrelated tasks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-retry-lease-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)
  const original = store.savePlan('host', store.create('host', 'Inspect').id, plan())
  const children = [1, 2].map(() => store.savePlan('host', store.create('host', 'Retry', { retryOfTaskId: original.id }).id, plan()))
  const lease = store.acquireExecution('host', children[0].id, plan())
  for (const task of [original, children[1]]) assert.throws(() => store.acquireExecution('host', task.id, plan()), /another operator/u)
  const separate = store.savePlan('host', store.create('host', 'Separate task').id, plan())
  const independent = store.acquireExecution('host', separate.id, plan())
  store.releaseExecution('host', separate.id, independent.owner)
  store.releaseExecution('host', children[0].id, lease.owner)
  const next = store.acquireExecution('host', original.id, plan())
  store.releaseExecution('host', original.id, next.owner)
})

test('legacy interrupted retry ancestors need review while completed legacy history remains usable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-retry-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)
  for (const completed of [false, true]) {
    const original = store.savePlan('host', store.create('host', 'Legacy').id, plan())
    store.saveResults('host', original.id, original.plan.commands.map(item => ({ id: item.id, status: completed ? 'completed' : 'failed', result: { exitCode: completed ? 0 : null } })))
    const retry = store.savePlan('host', store.create('host', 'Retry', { retryOfTaskId: original.id }).id, plan())
    if (!completed) assert.throws(() => store.acquireExecution('host', retry.id, plan()), /reconcil|journal/u)
    else {
      const lease = store.acquireExecution('host', retry.id, plan())
      store.releaseExecution('host', retry.id, lease.owner)
    }
  }
})

test('retry family inspection rejects cycles and oversized families without blocking unrelated work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-retry-bounds-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)
  const cyclic = store.savePlan('host', store.create('host', 'Cycle fixture').id, plan())
  store.withDatabase('host', database => database.prepare('UPDATE tasks SET retry_of_task_id = ? WHERE id = ?').run(cyclic.id, cyclic.id))
  assert.throws(() => store.acquireExecution('host', cyclic.id, plan()), /cyclic/u)
  const original = store.savePlan('host', store.create('host', 'Large family fixture').id, plan())
  store.withDatabase('host', database => database.transaction(() => {
    const insert = database.prepare("INSERT INTO tasks (request, status, retry_of_task_id, plan_json, created_at, updated_at) VALUES ('Retry fixture', 'planned', ?, ?, 0, 0)")
    for (let index = 0; index < 1001; index++) insert.run(original.id, JSON.stringify(plan()))
  })())
  assert.throws(() => store.acquireExecution('host', original.id, plan()), /inspection limit/u)
  const separate = store.savePlan('host', store.create('host', 'Unrelated').id, plan())
  const lease = store.acquireExecution('host', separate.id, plan())
  store.releaseExecution('host', separate.id, lease.owner)
  assert.equal(store.withDatabase('host', database => database.prepare('SELECT count(*) AS total FROM execution_leases').get().total), 0)
})

test('a competing execution cannot slip between plan immutability validation and persistence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-plan-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)
  const other = new TaskStore(root)
  const task = store.create('host', 'Inspect')
  const original = plan()
  const replacement = { ...original, summary: 'Replacement' }
  store.savePlan('host', task.id, original)
  const access = store.withDatabase.bind(store)
  let armed = true
  let executed = false
  store.withDatabase = (host, callback) => {
    const result = access(host, callback)
    if (armed) {
      armed = false
      let lease
      try {
        lease = other.acquireExecution(host, task.id, original)
        other.appendExecutionEvent(host, task.id, lease.owner, { type: 'command_prepared', commandId: 'first', attemptId: 'competing-attempt' })
        executed = true
      } catch (error) { assert.match(error.message, /execution plan differs/u) } finally {
        if (lease) other.releaseExecution(host, task.id, lease.owner)
      }
    }
    return result
  }
  let failure
  try { store.update('host', task.id, 'planned', { plan: replacement }) } catch (error) { failure = error }
  assert.deepEqual(store.get('host', task.id).plan, executed ? original : replacement)
  if (executed) assert.match(failure?.message ?? '', /immutable/u)
  else assert.equal(failure, undefined)
})

test('confirmed steps are skipped and dispatch intent precedes remote execution', async () => {
  const events = []
  const dispatched = []
  const results = await executeApprovedPlan({
    plan: plan(),
    policy: {},
    completedCommandIds: ['first'],
    approve: async () => true,
    onExecutionEvent: event => events.push(event),
    netdata: {
      runCommand: async command => {
        assert.equal(events.at(-1).type, 'command_dispatched')
        dispatched.push(command)
        throw new Error('SSH disconnected')
      }
    }
  })
  assert.deepEqual(dispatched, ['date'])
  assert.ok(events.some(event => event.type === 'command_outcome_unknown'))
  assert.equal(events.at(-1).type, 'execution_paused')
  assert.equal(results[0].recoveryRequired, true)
  assert.equal(results[0].status, 'failed')
})

for (const pauseAt of ['approval', 'evidence']) {
  test(`pause during ${pauseAt} prevents dispatch at the final safe boundary`, async () => {
    let allowed = true
    const events = []
    const calls = []
    const results = await executeApprovedPlan({
      plan: plan(),
      policy: {},
      approve: async () => { if (pauseAt === 'approval') allowed = false; return true },
      beforeCommand: async () => allowed,
      onExecutionEvent: event => events.push(event.type),
      netdata: {
        collectExecutionEvidence: async () => { if (pauseAt === 'evidence') allowed = false },
        runCommand: async text => { calls.push(text); return { exitCode: 0, stdout: '', stderr: '' } }
      }
    })
    assert.deepEqual(calls, [])
    assert.deepEqual(results, [])
    assert.ok(!events.includes('command_dispatched'))
  })
}

test('pausing before a declared retry retains the confirmed failed attempt', async () => {
  const candidate = plan()
  candidate.commands[0].retry = { attempts: 2, intervalMs: 0, exitCodes: [75] }
  let allowed = true
  let calls = 0
  const results = await executeApprovedPlan({
    plan: candidate,
    policy: {},
    approve: async () => true,
    beforeCommand: async () => allowed,
    onProgress: async event => { if (event.phase === 'execution-retry') allowed = false },
    netdata: { runCommand: async () => { calls++; return { exitCode: 75, stdout: '', stderr: 'temporary failure' } } }
  })
  assert.equal(calls, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'failed')
  assert.equal(results[0].result.exitCode, 75)
})

test('journal write failure prevents remote dispatch', async () => {
  let called = false
  await assert.rejects(executeApprovedPlan({
    plan: plan(),
    policy: {},
    approve: async () => true,
    onExecutionEvent: event => { if (event.type === 'command_dispatched') throw new Error('disk failure') },
    netdata: { runCommand: async () => { called = true } }
  }), /disk failure/u)
  assert.equal(called, false)
})

test('loop evidence distinguishes identical failures from new diagnostics and progress', () => {
  const attempt = id => ({ id, plan: plan(), results: [{ id: 'first', status: 'failed', result: { exitCode: 1, stderr: 'connection refused' } }] })
  assert.equal(detectOperationLoop([attempt(1), attempt(2), attempt(3)]).detected, true)
  const jobs = [1, 2, 3].map(id => {
    const value = attempt(id)
    value.results[0].result.jobId = `job-${id}`
    value.results[0].result.observedAt = `2026-10-18T09:00:0${id}Z`
    return value
  })
  assert.equal(detectOperationLoop(jobs).detected, true)
  assert.equal(jobs[0].results[0].result.jobId, 'job-1')
  jobs[2].results[0].result.stderr = 'new diagnostic information'
  assert.equal(detectOperationLoop(jobs).detected, false)
  const changed = attempt(3)
  changed.results[0].result.stderr = 'service started, new error'
  assert.equal(detectOperationLoop([attempt(1), attempt(2), changed]).detected, false)
  assert.equal(detectOperationLoop([attempt(1), { id: 2, plan: plan(), results: [{ id: 'first', status: 'completed' }] }]).detected, false)
})

test('alternating repairs stop, while a successful bounded retry remains valid', async () => {
  const attempts = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, plan: { ...plan(), commands: [{ ...plan().commands[0], command: index % 2 ? 'echo inspect-b' : 'echo inspect-a' }] }, results: [{ id: 'first', status: 'failed', result: { exitCode: 1, stderr: index % 2 ? 'state-b' : 'state-a' } }] }))
  assert.equal(detectOperationLoop(attempts).detected, true)
  let calls = 0
  const retryPlan = { ...plan(), commands: [{ ...plan().commands[0], retry: { attempts: 3, intervalMs: 0, exitCodes: [1] } }] }
  const results = await executeApprovedPlan({ plan: retryPlan, policy: {}, approve: async () => true, netdata: { runCommand: async () => ({ exitCode: ++calls < 3 ? 1 : 0 }) } })
  assert.equal(results[0].status, 'completed')
  assert.equal(calls, 3)
  assert.equal(detectOperationLoop([{ plan: retryPlan, results }]).detected, false)
})

test('Admin recovery skips completed commands and refuses ambiguous dispatch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-admin-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskStore(root)
  const task = tasks.create('host', 'Inspect')
  tasks.savePlan('host', task.id, plan())
  const lease = tasks.acquireExecution('host', task.id, plan())
  tasks.appendExecutionEvent('host', task.id, lease.owner, { type: 'command_completed', commandId: 'first', attemptId: 'confirmed' })
  tasks.releaseExecution('host', task.id, lease.owner)
  const calls = []
  const admin = new AdminService({ dataRoot: root, tasks, workspace: { loadRules: async () => ({ policy: {} }) } })
  admin.serverSecrets = async () => ({})
  admin.netdata = () => ({ runCommand: async command => { calls.push(command); throw new Error('lost SSH') } })
  const results = await admin.execute({ settings: {}, serverId: 'host', taskId: task.id, plan: plan(), approve: async () => true })
  assert.deepEqual(calls, ['date'])
  assert.equal(results[0].status, 'completed')
  await assert.rejects(admin.execute({ settings: {}, serverId: 'host', taskId: task.id, plan: plan(), approve: async () => true }), /reconciliation/u)
  assert.deepEqual(calls, ['date'])
})

for (const approved of [true, false]) {
  test(`rollback reconciliation uses only fingerprint-matched approved diagnostic commands: ${approved}`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'intent-rollback-evidence-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const tasks = new TaskStore(root)
    const task = tasks.savePlan('host', tasks.create('host', 'Inspect').id, plan())
    const command = { id: 'reviewed-cleanup', command: 'true', risk: 'read', timeoutMs: 1000, diagnostic: { kind: 'filesystem', target: '/opt/task' } }
    const rollback = { ...plan(), commands: [command], operatorRollback: true }
    const version = tasks.stateVersion('host', task.id)
    const revisionId = tasks.proposeRevision('host', task.id, rollback, version)
    if (approved) tasks.approveRevision('host', task.id, revisionId, version, planFingerprint(rollback))
    const lease = tasks.acquireExecution('host', task.id, task.plan)
    const metadata = { operation: 'rollback', rollbackRevision: planFingerprint(rollback) }
    const before = { availability: 'available', platform: 'linux', observedAt: '2026-10-19T00:00:00Z' }
    for (const type of ['command_prepared', 'command_dispatched', 'command_acknowledged', 'command_outcome_unknown']) {
      tasks.appendExecutionEvent('host', task.id, lease.owner, { type, commandId: command.id, attemptId: 'interrupted-cleanup', metadata: { ...metadata, ...(type === 'command_prepared' ? { evidenceBefore: before } : {}), ...(type === 'command_acknowledged' ? { jobId: '12'.repeat(16) } : {}) } })
    }
    tasks.releaseExecution('host', task.id, lease.owner)
    const collected = []
    const admin = new AdminService({ dataRoot: root, tasks })
    admin.serverSecrets = async () => ({})
    admin.netdata = () => ({
      jobStatus: async id => { assert.equal(id, '12'.repeat(16)); return { state: 'succeeded', exitCode: 0 } },
      collectExecutionEvidence: async options => { collected.push(options); return { ...before, observedAt: '2026-10-19T00:00:01Z' } }
    })
    await admin.reconcileTask({ settings: {}, serverId: 'host', taskId: task.id })
    assert.deepEqual(collected, [{ item: approved ? command : undefined, before }])
    assert.equal(tasks.rollbackState('host', task.id)[0].status, 'completed')
    assert.equal(tasks.allExecutionEvents('host', task.id).filter(event => event.type === 'command_dispatched').length, 1)
  })
}

test('recovered jobs pause remaining work until renewed operator approval', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-recovered-job-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskStore(root)
  const approved = plan()
  approved.commands[0].executionMode = 'job'
  const task = tasks.savePlan('host', tasks.create('host', 'Inspect').id, approved)
  const calls = []
  const progress = []
  const admin = new AdminService({ dataRoot: root, tasks, workspace: { loadRules: async () => ({ policy: {} }) } })
  admin.serverSecrets = async () => ({})
  admin.netdata = () => ({
    runJob: async (command, options) => {
      calls.push(command)
      await options.onStarted({ jobId: '12'.repeat(16), state: 'running' })
      await options.onStatus({ jobId: '12'.repeat(16), state: 'reconnecting', attempt: 1, attempts: 3 })
      await options.onStatus({ jobId: '12'.repeat(16), state: 'running' })
      return { exitCode: 0, recoveryRequired: true }
    },
    runCommand: async command => { calls.push(command); return { exitCode: 0 } }
  })
  const execute = () => admin.execute({ settings: {}, serverId: 'host', taskId: task.id, plan: approved, approve: async () => true, onProgress: event => progress.push(event) })
  const results = await execute()
  assert.deepEqual(calls, ['uptime'])
  assert.equal(results[0].status, 'completed')
  assert.equal(tasks.control('host', task.id).action, 'pause')
  assert.equal(tasks.saveResults('host', task.id, results).status, 'partial')
  assert.deepEqual(progress.map(event => event.state), ['reconnecting', 'job_running', 'operator_review_required'])
  await execute()
  assert.deepEqual(calls, ['uptime'])
  const control = tasks.control('host', task.id)
  tasks.setControl('host', task.id, 'run', control.version)
  await execute()
  assert.deepEqual(calls, ['uptime', 'date'])
})

for (const mode of ['normal', 'retry', 'approval', 'evidence']) {
  test(`final dispatch control check does not repeat interactive prompts: ${mode}`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'intent-boundary-ui-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const tasks = new TaskStore(root)
    const approved = { ...plan(), commands: [plan().commands[0]] }
    if (mode === 'retry') approved.commands[0].retry = { attempts: 2, intervalMs: 0, exitCodes: [75] }
    const task = tasks.savePlan('host', tasks.create('host', 'Inspect').id, approved)
    const admin = new AdminService({ dataRoot: root, tasks, workspace: { loadRules: async () => ({ policy: {} }) } })
    admin.serverSecrets = async () => ({})
    let prompts = 0
    let dispatches = 0
    const pause = () => tasks.setControl('host', task.id, 'pause', tasks.control('host', task.id).version)
    admin.netdata = () => ({
      collectExecutionEvidence: async () => { if (mode === 'evidence') pause() },
      runCommand: async () => ({ exitCode: ++dispatches === 1 && mode === 'retry' ? 75 : 0 })
    })
    await admin.execute({
      settings: {},
      serverId: 'host',
      taskId: task.id,
      plan: approved,
      beforeCommand: async () => { prompts++; return true },
      approve: async () => { if (mode === 'approval') pause(); return true }
    })
    assert.equal(prompts, mode === 'retry' ? 2 : 1)
    assert.equal(dispatches, ['approval', 'evidence'].includes(mode) ? 0 : mode === 'retry' ? 2 : 1)
  })
}
