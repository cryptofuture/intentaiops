import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { HostSessionFactory } from '../src/host-session-factory.js'
import { SystemSsh } from '../src/system-ssh.js'
import { OperatorController } from '../src/operator-controller.js'
import { startOperatorConsole } from '../src/operator-console.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { detectOperationLoop } from '../src/operation-loop-detector.js'

const allowed = process.env.INTENT_LINUX_LAB_ALLOW === '1'

test('Linux common-task reliability and operator workflows', { skip: !allowed, timeout: 20 * 60 * 1000 }, async t => {
  assert.ok(process.env.WEBMINAI_DATA_ROOT && process.env.VAULT_TEST, 'explicit test vault required')
  const store = new SettingsStore(process.env.WEBMINAI_DATA_ROOT)
  const settings = await store.load()
  const passphrase = process.env.VAULT_TEST
  const hosts = process.env.INTENT_LINUX_TEST_HOSTS?.split(',') ?? Object.keys(settings.servers)
  assert.ok(hosts.length >= 2 && new Set(hosts).size === hosts.length, 'select at least two distinct disposable hosts')
  assert.ok(hosts.every(id => id.startsWith('webminai-') && settings.servers[id]), 'only configured Linux lab hosts may be selected')
  const workspace = new ServerWorkspace(store.dataRoot, { directoryAliases: new Map(Object.entries(settings.servers).map(([id, host]) => [id, host.historyId ?? id])) })
  const ssh = new SystemSsh({ terminalCheck: () => true, transport: settings.ssh })
  t.after(() => ssh.closeSessions())
  const factory = new HostSessionFactory({ dataRoot: store.dataRoot, settingsStore: store, workspace, baseSsh: ssh })
  const opened = new Map()
  for (const host of hosts) {
    try {
      const value = await factory.open({ settings, passphrase, serverId: host, requireActive: true })
      opened.set(host, value)
      t.after(() => value.session.close())
    } catch (error) { throw new Error(`${host}: ${error.message}`, { cause: error }) }
  }
  const controller = new OperatorController({ dataRoot: store.dataRoot, settings, passphrase, adminFor: async host => opened.get(host).admin })
  const tasks = controller.tasks
  const health = buildCommonTask('host-health-linux', 1, { platform: 'linux' }).plan
  health.commands = health.commands.filter(item => item.id !== 'collect-health-maintenance')
  const firstHost = hosts[0]

  function fixture (host, { mutate = false, job = false } = {}) {
    const admin = opened.get(host).admin
    const created = admin.createTask(host, 'Validate Linux reliability: common-task fixture', { kind: 'catalog', catalogId: mutate ? 'system-user' : 'host-health-linux' })
    const built = mutate ? buildCommonTask('system-user', created.id, { platform: 'linux' }) : { plan: health }
    const commands = mutate
      ? [...built.plan.commands, ...health.commands.map(item => ({ ...item, dependsOn: [...item.dependsOn, built.plan.commands[0].id] }))]
      : structuredClone(health.commands)
    if (job) commands[0] = { ...commands[0], executionMode: 'job', command: `sleep 2; ${commands[0].command}` }
    const plan = { ...built.plan, commands }
    admin.saveTaskPlan(host, created.id, plan)
    return { host, admin, taskId: created.id, plan, built, client: admin.netdata(opened.get(host).server) }
  }

  async function execute (value, options = {}) {
    value.admin.markTaskRunning(value.host, value.taskId)
    const results = await value.admin.execute({ settings, passphrase, serverId: value.host, taskId: value.taskId, plan: value.plan, approve: async () => true, onResult: result => value.admin.appendTaskResult(value.host, value.taskId, result), ...options })
    value.admin.saveTaskResults(value.host, value.taskId, results)
    return results
  }

  async function resume (value) {
    const view = controller.inspect(value.host, value.taskId)
    return controller.resume(value.host, value.taskId, view.stateVersion, view.fingerprint)
  }

  async function probe (value, command) {
    const result = await value.client.runCommand(command, { timeoutSeconds: 15 })
    assert.equal(result.exitCode, 0)
    return result.stdout
  }

  async function cleanup (value, baseline) {
    const state = tasks.executionState(value.host, value.taskId)
    assert.ok(!state.some(item => item.status === 'uncertain'), 'uncertain fixture requires reconciliation before cleanup')
    if (state[0].status === 'completed') {
      const reviewedPlan = { ...value.plan, summary: 'Reviewed common-task fixture cleanup', commands: value.built.plan.revertCommands, revertCommands: [] }
      const results = await value.admin.revertTask({ settings, passphrase, serverId: value.host, taskId: value.taskId, reviewedPlan, approve: async () => true })
      assert.ok(results.every(result => result.status === 'completed'))
      value.admin.saveTaskRevertResults(value.host, value.taskId, results)
    }
    await probe(value, value.built.verifyReverted)
    assert.equal(await probe(value, value.built.stateProbe), baseline)
  }

  for (const host of hosts) {
    await t.test(`${host}: common diagnostics pause, independent leases, durable resume`, async () => {
      const value = fixture(host)
      const lease = await factory.open({ settings, passphrase, serverId: host, requireActive: true })
      await lease.session.close()
      const result = await execute(value, {
        onResult: entry => {
          value.admin.appendTaskResult(host, value.taskId, entry)
          controller.control(host, value.taskId, 'pause', tasks.stateVersion(host, value.taskId))
        }
      })
      assert.equal(result.length, 1)
      assert.equal(tasks.executionState(host, value.taskId)[0].status, 'completed')
      await resume(value)
      const events = tasks.allExecutionEvents(host, value.taskId)
      for (const command of value.plan.commands) assert.equal(events.filter(event => event.type === 'command_dispatched' && event.commandId === command.id).length, 1)
      assert.equal(controller.inspect(host, value.taskId).task.status, 'completed')
    })
  }

  await t.test('signed remote deadlines permit only the two explicitly reviewed retry attempts', async () => {
    const value = fixture(firstHost, { job: true })
    value.plan.commands[0] = { ...value.plan.commands[0], timeoutMs: 1000, command: 'sleep 3', retry: { attempts: 2, intervalMs: 0, exitCodes: [143], states: ['timed_out'] } }
    value.admin.saveTaskPlan(firstHost, value.taskId, value.plan)
    const results = await execute(value)
    assert.equal(results[0].status, 'failed')
    assert.equal(results[0].attempts, 2)
    assert.ok(results[0].diagnostics.some(item => item.code === 'EXECUTION_TIMEOUT' && item.confidence === 'confirmed'))
    const events = tasks.allExecutionEvents(firstHost, value.taskId)
    const prepared = events.filter(event => event.type === 'command_prepared')
    assert.equal(prepared.length, 2)
    assert.equal(new Set(prepared.map(event => event.attemptId)).size, 2)
    assert.equal(events.filter(event => event.type === 'command_failed').length, 2)
    assert.equal(events.filter(event => event.type === 'command_outcome_unknown').length, 0)
  })

  for (const phase of ['prepared', 'completed', 'remote-completed', 'job-acknowledged']) {
    await t.test(`real process crash at ${phase} preserves common-task execution evidence`, async () => {
      const mutate = ['remote-completed', 'job-acknowledged'].includes(phase)
      const value = fixture(firstHost, { mutate, job: phase === 'job-acknowledged' })
      const baseline = mutate ? await probe(value, value.built.stateProbe) : null
      const child = spawn(process.execPath, ['scripts/linux-reliability-worker.js', firstHost, String(value.taskId), phase], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''
      child.stderr.on('data', data => { error += data })
      const stopped = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
      assert.equal(stopped.signal, 'SIGKILL', `worker did not reach crash boundary: ${error.slice(0, 300)}`)
      assert.ok(tasks.interruptedTasks(firstHost).some(task => task.id === value.taskId), 'restart must identify the interrupted task')
      assert.throws(() => tasks.acquireExecution(firstHost, value.taskId, value.plan), /another operator/u)
      await delay(30500)
      let state = tasks.executionState(firstHost, value.taskId)
      const jobId = state[0].jobId
      if (phase === 'remote-completed') {
        assert.equal(state[0].status, 'uncertain')
        await assert.rejects(resume(value), /reconciliation/u)
        await probe(value, value.built.verifyApplied)
        controller.resolve(firstHost, value.taskId, tasks.stateVersion(firstHost, value.taskId), state[0].commandId, 'completed', 'The common-task verifyApplied probe succeeded on the selected host after remote completion.')
      } else if (phase === 'job-acknowledged') {
        assert.ok(jobId)
        await controller.reconcile(firstHost, value.taskId, tasks.stateVersion(firstHost, value.taskId))
        state = tasks.executionState(firstHost, value.taskId)
        assert.equal(state[0].status, 'completed')
        await probe(value, value.built.verifyApplied)
      } else assert.equal(state[0].status, phase === 'prepared' ? 'pending' : 'completed')
      await resume(value)
      const dispatched = tasks.allExecutionEvents(firstHost, value.taskId).filter(event => event.commandId === value.plan.commands[0].id && event.type === 'command_dispatched')
      assert.equal(dispatched.length, 1, 'confirmed or uncertain changes must never be replayed')
      if (mutate) await cleanup(value, baseline)
      if (jobId) await value.client.cleanupJob(jobId)
    })
  }

  await t.test('an owned SSH master disconnect during a real job pauses remaining common diagnostics', async () => {
    const value = fixture(firstHost, { job: true })
    const original = value.admin.netdata
    let jobId
    value.admin.netdata = server => {
      const client = original.call(value.admin, server)
      const run = client.runJob.bind(client)
      client.runJob = (command, options) => run(command, {
        ...options,
        onStarted: async status => {
          jobId = status.jobId
          await options.onStarted(status)
          const transport = [...ssh.sessions.entries.values()].find(entry => entry.session?.connectionUrl === opened.get(firstHost).server.connectionUrl).session
          const result = await ssh.runner(ssh.sshBinary, ['-S', transport.controlPath, '-O', 'exit', firstHost])
          assert.equal(result.code, 0)
        }
      })
      return client
    }
    try {
      const results = await execute(value)
      assert.equal(results.length, 1)
      assert.equal(results[0].status, 'completed')
      assert.equal(results[0].recoveryRequired, true)
      assert.equal(tasks.control(firstHost, value.taskId).action, 'pause')
    } finally { value.admin.netdata = original }
    await resume(value)
    assert.equal(tasks.allExecutionEvents(firstHost, value.taskId).filter(event => event.type === 'command_dispatched').length, value.plan.commands.length)
    await value.client.cleanupJob(jobId)
  })

  await t.test('reviewed common-task revision preserves completed changes and rejects stale approval', async () => {
    const value = fixture(firstHost, { mutate: true })
    const baseline = await probe(value, value.built.stateProbe)
    const originalPlanner = value.admin.planner
    try {
      await execute(value, {
        onResult: result => {
          value.admin.appendTaskResult(firstHost, value.taskId, result)
          controller.control(firstHost, value.taskId, 'pause', tasks.stateVersion(firstHost, value.taskId))
        }
      })
      await probe(value, value.built.verifyApplied)
      const before = controller.inspect(firstHost, value.taskId)
      const replacement = { ...health, summary: 'Reviewed remaining common diagnostic', commands: [{ ...health.commands[0], id: 'revised-health', dependsOn: [] }], revertCommands: value.plan.revertCommands }
      value.admin.planner = { plan: async () => replacement }
      const proposed = await controller.propose(firstHost, value.taskId, 'Keep the completed common-task change; replace only the remaining diagnostics.', before.stateVersion)
      assert.deepEqual(proposed.proposed.commands[0], value.plan.commands[0])
      assert.throws(() => controller.approve(firstHost, value.taskId, proposed.revisionId, proposed.expectedVersion, 'stale'), /approval/u)
      controller.approve(firstHost, value.taskId, proposed.revisionId, proposed.expectedVersion, proposed.fingerprint)
      await assert.rejects(controller.resume(firstHost, value.taskId, before.stateVersion, before.fingerprint), /stale/u)
      await resume(value)
      assert.equal(tasks.allExecutionEvents(firstHost, value.taskId).filter(event => event.type === 'command_dispatched' && event.commandId === 'apply').length, 1)
      assert.equal(tasks.revisions(firstHost, value.taskId)[0].plan.commands.length, value.plan.commands.length)
    } finally {
      value.admin.planner = originalPlanner
      await cleanup(value, baseline)
    }
  })

  await t.test('real failed common-task probes trigger loop protection but successful evidence resets it', async () => {
    const history = []
    for (let index = 0; index < 3; index++) {
      const value = fixture(firstHost)
      const user = buildCommonTask('system-user', value.taskId, { platform: 'linux' })
      value.plan = { ...health, commands: [{ ...health.commands[0], command: user.verifyApplied, dependsOn: [] }] }
      value.admin.saveTaskPlan(firstHost, value.taskId, value.plan)
      const result = await execute(value)
      assert.equal(result[0].status, 'failed')
      history.push(value.admin.getTask(firstHost, value.taskId))
    }
    assert.equal(detectOperationLoop(history).detected, true)
    const admin = opened.get(firstHost).admin
    await assert.rejects(admin.plan({ settings, passphrase, serverId: firstHost, request: 'Repeat the unchanged failure', previousAttempts: history }), /alternative operator instructions/u)
    const success = fixture(firstHost)
    await execute(success)
    assert.equal(detectOperationLoop([...history, success.admin.getTask(firstHost, success.taskId)]).detected, false)
  })

  await t.test('a failed common-task command that changed state needs a separately approved rollback', async () => {
    const value = fixture(firstHost, { mutate: true })
    const baseline = await probe(value, value.built.stateProbe)
    value.plan.commands[0] = { ...value.plan.commands[0], command: `${value.plan.commands[0].command}; exit 23` }
    value.admin.saveTaskPlan(firstHost, value.taskId, value.plan)
    const results = await execute(value)
    assert.equal(results[0].status, 'failed')
    await probe(value, value.built.verifyApplied)
    await assert.rejects(value.admin.revertTask({ settings, passphrase, serverId: firstHost, taskId: value.taskId, approve: async () => true }), /separately reviewed/u)
    const originalPlanner = value.admin.planner
    try {
      value.admin.planner = { plan: async () => ({ ...value.plan, commands: value.plan.revertCommands, revertCommands: [] }) }
      const before = controller.inspect(firstHost, value.taskId)
      const proposed = await controller.propose(firstHost, value.taskId, 'The signed verifyApplied probe confirms the fixture exists despite exit 23. Remove only this verified fixture.', before.stateVersion, true)
      controller.approve(firstHost, value.taskId, proposed.revisionId, proposed.expectedVersion, proposed.fingerprint)
      const approved = controller.inspect(firstHost, value.taskId)
      await controller.rollback(firstHost, value.taskId, approved.stateVersion, approved.reviewedRollbackFingerprint, proposed.revisionId)
      await probe(value, value.built.verifyReverted)
      assert.equal(await probe(value, value.built.stateProbe), baseline)
    } finally { value.admin.planner = originalPlanner }
  })

  await t.test('an explicitly approved one-way common fixture resumes only its pending diagnostics', async () => {
    const value = fixture(firstHost, { mutate: true })
    const baseline = await probe(value, value.built.stateProbe)
    value.plan = { ...value.plan, revertCommands: [] }
    value.admin.saveTaskPlan(firstHost, value.taskId, value.plan)
    try {
      const results = await execute(value, {
        requireRevert: false,
        onResult: result => {
          value.admin.appendTaskResult(firstHost, value.taskId, result)
          controller.control(firstHost, value.taskId, 'pause', tasks.stateVersion(firstHost, value.taskId))
        }
      })
      assert.equal(results.length, 1)
      await resume(value)
      assert.equal(tasks.get(firstHost, value.taskId).status, 'completed')
      assert.equal(tasks.allExecutionEvents(firstHost, value.taskId).filter(event => event.type === 'command_dispatched' && event.commandId === 'apply').length, 1)
    } finally { await cleanup(value, baseline) }
  })

  await t.test('aborted common diagnostics cannot resume without a newly approved revision', async () => {
    const value = fixture(firstHost)
    const before = controller.inspect(firstHost, value.taskId)
    controller.control(firstHost, value.taskId, 'abort', before.stateVersion)
    await assert.rejects(resume(value), /aborted/u)
    const originalPlanner = value.admin.planner
    try {
      value.admin.planner = { plan: async () => ({ ...health, commands: health.commands.map(item => ({ ...item, id: `new-${item.id}` })) }) }
      const aborted = controller.inspect(firstHost, value.taskId)
      const proposed = await controller.propose(firstHost, value.taskId, 'Replace the aborted common diagnostics without changing the host.', aborted.stateVersion)
      controller.approve(firstHost, value.taskId, proposed.revisionId, proposed.expectedVersion, proposed.fingerprint)
      await resume(value)
      assert.equal(tasks.get(firstHost, value.taskId).status, 'completed')
    } finally { value.admin.planner = originalPlanner }
  })

  await t.test('operator pause does not terminate an already running signed common-task job', async () => {
    const value = fixture(firstHost, { job: true })
    const original = value.admin.netdata
    let jobId
    value.admin.netdata = server => {
      const client = original.call(value.admin, server)
      const run = client.runJob.bind(client)
      client.runJob = (command, options) => run(command, {
        ...options,
        onStarted: async status => {
          jobId = status.jobId
          await options.onStarted(status)
          controller.control(firstHost, value.taskId, 'pause', tasks.stateVersion(firstHost, value.taskId))
        }
      })
      return client
    }
    try {
      const results = await execute(value)
      assert.equal(results.length, 1)
      assert.equal(results[0].status, 'completed')
      assert.equal((await value.client.jobStatus(jobId)).state, 'succeeded')
      assert.equal(tasks.executionState(firstHost, value.taskId)[1].status, 'pending')
    } finally { value.admin.netdata = original }
    await resume(value)
    await value.client.cleanupJob(jobId)
  })

  let replayRun
  await t.test('common-task rollout halts at failed canary and continues only individually approved hosts', async () => {
    const selected = hosts.slice(0, 3)
    const run = await controller.run({ settings, passphrase, serverIds: selected, request: 'Validate Linux reliability: staged common health', kind: 'catalog', catalogId: 'host-health-linux', rollout: { canaryHostId: selected[0], batchSize: 1 }, review: async () => true, externalVerify: async () => ({ ok: false, message: 'Deliberate canary gate failure' }) })
    replayRun = run.id
    for (const host of run.hosts.filter(host => host.serverId !== selected[0])) assert.equal(tasks.allExecutionEvents(host.serverId, host.taskId).filter(event => event.type === 'command_dispatched').length, 0)
    const next = run.hosts.find(host => host.serverId === selected[1])
    const decision = controller.inspect(next.serverId, next.taskId)
    await controller.resumeRun(run.id, [{ hostId: next.serverId, taskId: next.taskId, expectedVersion: decision.stateVersion, fingerprint: decision.fingerprint }])
    const after = controller.runs.get(run.id)
    assert.equal(after.hosts.find(host => host.serverId === next.serverId).status, 'completed')
    const count = ssh.sessions.diagnostics().channels
    await controller.resumeRun(run.id, [{ hostId: next.serverId, taskId: next.taskId }])
    assert.equal(ssh.sessions.diagnostics().channels, count, 'completed hosts must not rerun')
    assert.equal(after.hosts.find(host => host.serverId === selected[0]).status, 'failed')
  })

  await t.test('run pause during planning holds all common-task command queues', async () => {
    const run = await controller.run({ settings, passphrase, serverIds: hosts.slice(0, 2), request: 'Validate Linux reliability: queued rollout pause', kind: 'catalog', catalogId: 'host-health-linux', rollout: { canaryHostId: firstHost }, review: async () => true, onEvent: event => { if (event.type === 'planning') controller.pauseRun(event.runId) } })
    assert.equal(controller.runs.control(run.id).action, 'pause')
    for (const host of run.hosts) assert.equal(tasks.allExecutionEvents(host.serverId, host.taskId).length, 0)
  })

  await t.test('successful common-task canary verification releases the next rollout stage', async () => {
    const selected = [firstHost, hosts.find(host => host === 'webminai-ubuntu-2404') ?? hosts[1]]
    const verified = []
    const run = await controller.run({ settings, passphrase, serverIds: selected, request: 'Validate Linux reliability: healthy common-task rollout', kind: 'catalog', catalogId: 'host-health-linux', rollout: { canaryHostId: firstHost, batchSize: 1 }, review: async () => true, verifyStage: async ({ stage }) => { verified.push(stage.id); return true } })
    assert.equal(run.status, 'completed')
    assert.equal(verified.length, 2)
    for (const host of run.hosts) assert.ok(tasks.executionState(host.serverId, host.taskId).every(command => command.status === 'completed'))
  })

  await t.test('writable console requires CSRF and fresh explicit approval for real common diagnostics', async () => {
    const value = fixture(firstHost)
    const server = await startOperatorConsole({ controller, actions: true })
    try {
      const login = await fetch(`${server.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
      const session = await login.json()
      const headers = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] }
      const before = controller.inspect(firstHost, value.taskId)
      const body = { action: 'pause', hostId: firstHost, taskId: value.taskId, expectedVersion: before.stateVersion }
      const post = (data, auth = headers) => fetch(`${server.origin}/action`, { method: 'POST', headers: auth, body: JSON.stringify(data) })
      assert.equal((await post(body)).status, 403)
      headers['X-Intent-CSRF'] = session.csrf
      assert.equal((await post(body)).status, 200)
      assert.equal((await post(body)).status, 409)
      const paused = controller.inspect(firstHost, value.taskId)
      const decision = { ...body, action: 'resume', expectedVersion: paused.stateVersion, fingerprint: paused.fingerprint }
      assert.equal((await post(decision)).status, 409)
      assert.equal((await post({ action: 'execute', command: 'unreviewed command' })).status, 409)
      assert.equal((await post({ ...decision, approved: true })).status, 200)
      const deadline = Date.now() + 10000
      while (tasks.get(firstHost, value.taskId).status !== 'completed' && Date.now() < deadline) await delay(50)
      assert.equal(tasks.get(firstHost, value.taskId).status, 'completed')
      assert.equal(tasks.allExecutionEvents(firstHost, value.taskId).filter(event => event.type === 'command_dispatched').length, value.plan.commands.length)
    } finally { await server.close() }
  })

  await t.test('authenticated console streams and exports real common-task history without remote actions', async () => {
    const server = await startOperatorConsole({ controller })
    try {
      assert.equal((await fetch(`${server.origin}/snapshot`)).status, 401)
      const headers = { 'Content-Type': 'application/json' }
      const login = await fetch(`${server.origin}/session`, { method: 'POST', headers, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
      assert.equal(login.status, 200)
      const cookie = login.headers.get('set-cookie').split(';')[0]
      const auth = { ...headers, Cookie: cookie }
      assert.equal((await fetch(`${server.origin}/snapshot`, { headers: { ...auth, Origin: 'https://invalid.example' } })).status, 403)
      const count = ssh.sessions.diagnostics().channels
      const response = await fetch(`${server.origin}/export?run=${replayRun}`, { headers: auth })
      const bundle = await response.json()
      assert.equal(response.status, 200)
      assert.equal(bundle.replayOnly, true)
      assert.ok(bundle.events.some(event => event.type === 'command_completed'))
      assert.ok(!JSON.stringify(bundle).includes(passphrase), 'vault passphrase must not appear in diagnostics')
      assert.equal((await fetch(`${server.origin}/action`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'resume' }) })).status, 403)
      let cursor = 0
      for (;;) {
        const batch = controller.events(cursor)
        if (!batch.length) break
        cursor = batch.at(-1).id
      }
      controller.record({ type: 'lab-replay-checkpoint' })
      cursor = controller.events(cursor).at(-1).id
      controller.record({ type: 'lab-replay-reconnected' })
      // Let expired HTTP keep-alive timers run after synchronous history reads.
      await delay(0)
      const events = await fetch(`${server.origin}/events`, { headers: { ...auth, 'Last-Event-ID': String(cursor) }, signal: AbortSignal.timeout(5000) })
      const reader = events.body.getReader()
      let chunk = ''
      while (!chunk.includes('lab-replay-reconnected')) {
        const next = await reader.read()
        assert.equal(next.done, false)
        chunk += new TextDecoder().decode(next.value)
      }
      assert.match(chunk, /lab-replay-reconnected/u)
      assert.doesNotMatch(chunk, /lab-replay-checkpoint/u)
      await reader.cancel()
      assert.equal(ssh.sessions.diagnostics().channels, count, 'read-only replay must never contact a host')
    } finally { await server.close() }
  })

  await t.test('real CLI terminal unlock launches read-only and action-enabled consoles and exits cleanly', { skip: process.platform !== 'linux' || passphrase.length < 12 }, async () => {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`
    for (const actions of [false, true]) {
      const command = `${quote(process.execPath)} bin/intentaiops.js console --data-root ${quote(store.dataRoot)}${actions ? ' --console-actions' : ''}`
      const child = spawn('script', ['-qefc', command, '/dev/null'], { env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'ignore'] })
      let output = ''
      let entered = false
      let resolveReady
      let rejectReady
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      const timeout = setTimeout(() => rejectReady(new Error('CLI console did not become ready')), 15000)
      child.once('error', rejectReady)
      child.stdout.on('data', data => {
        output += data.toString('utf8')
        if (!entered && output.includes('Vault passphrase:')) {
          entered = true
          delay(50).then(() => { if (!child.stdin.destroyed) child.stdin.write(`${passphrase}\r`) })
        }
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/u)
        if (match) resolveReady(match[0])
      })
      const exited = new Promise(resolve => child.once('close', (code, signal) => { rejectReady(new Error('CLI exited before console startup')); resolve({ code, signal }) }))
      try {
        const url = new URL(await ready)
        assert.ok(!output.includes(passphrase), 'terminal must not echo the vault passphrase')
        const login = await fetch(`${url.origin}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: url.hash.slice(1) }) })
        assert.equal(login.status, 200)
        assert.equal((await login.json()).actions, actions)
        child.stdin.write('\u0003')
        const stopped = await Promise.race([exited, delay(5000).then(() => { throw new Error('CLI did not shut down after Ctrl+C') })])
        assert.equal(stopped.code, 0)
      } finally {
        clearTimeout(timeout)
        child.stdin.end()
        if (child.exitCode === null) child.kill('SIGTERM')
      }
    }
  })

  await t.test('real browser authenticates, inspects common tasks, and replays history without remote execution', { skip: !existsSync('/usr/bin/google-chrome') }, async () => {
    const server = await startOperatorConsole({ controller })
    const profile = await mkdtemp(path.join(os.tmpdir(), 'intent-console-browser-'))
    const browser = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe'] })
    const exited = new Promise(resolve => browser.once('close', resolve))
    let socket
    let timeout
    try {
      const endpoint = await new Promise((resolve, reject) => {
        let output = ''
        browser.once('error', reject)
        timeout = setTimeout(() => reject(new Error('headless browser did not start')), 10000)
        browser.stderr.on('data', data => {
          output += data.toString('utf8')
          const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/u)
          if (match) resolve(match[1])
        })
      })
      clearTimeout(timeout)
      const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json()
      const page = targets.find(target => target.type === 'page')
      assert.ok(page)
      socket = new globalThis.WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
      let sequence = 0
      const pending = new Map()
      socket.addEventListener('message', message => {
        const value = JSON.parse(message.data)
        const request = pending.get(value.id)
        if (!request) return
        pending.delete(value.id)
        if (value.error) request.reject(new Error('browser protocol request failed'))
        else request.resolve(value.result)
      })
      const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
      const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true })
        assert.ok(!result.exceptionDetails, 'browser script raised an exception')
        return result.result.value
      }
      const until = async expression => {
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(50) }
        throw new Error('browser UI did not reach the expected state')
      }
      const channels = ssh.sessions.diagnostics().channels
      await call('Page.navigate', { url: server.url })
      await until('document.querySelector("#token")?.value.length === 64')
      assert.equal(await evaluate('location.hash'), '')
      await evaluate('document.querySelector("#connect").click()')
      await until('document.querySelector("#main")?.hidden === false && document.querySelectorAll("#hosts button").length > 0')
      assert.equal(await evaluate('document.querySelector("#actions").hidden'), true)
      assert.equal(await evaluate('document.querySelector("#token").value'), '')
      await evaluate('document.querySelector("#hosts button").click()')
      await until('document.querySelector("#task").textContent.includes("stateVersion")')
      await evaluate(`document.querySelector('#run-id').value = ${replayRun}; document.querySelector('#replay').click()`)
      await until('Number(document.querySelector("#position").max) > 0')
      await evaluate('document.querySelector("#position").value = 1; document.querySelector("#position").dispatchEvent(new Event("input"))')
      assert.ok((await evaluate('document.querySelector("#replay-event").textContent')).includes('timestamp'))
      assert.equal(await evaluate('document.querySelector("#message").textContent'), '')
      assert.equal(ssh.sessions.diagnostics().channels, channels)
    } finally {
      clearTimeout(timeout)
      socket?.close()
      await server.close()
      browser.kill('SIGTERM')
      await exited
      await rm(profile, { recursive: true, force: true })
    }
  })
})
