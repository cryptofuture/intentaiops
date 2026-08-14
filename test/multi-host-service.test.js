import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MultiHostService, parallelMap } from '../src/multi-host-service.js'
import { TaskStore } from '../src/task-store.js'

test('parallelMap rejects invalid concurrency before invoking the mapper', async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    let invoked = false
    await assert.rejects(
      parallelMap(['host'], concurrency, async () => { invoked = true }),
      new TypeError('concurrency must be a positive integer')
    )
    assert.equal(invoked, false)
  }
})

test('parallelMap preserves input order with valid concurrency', async () => {
  const results = await parallelMap([3, 1, 2], 2, async value => {
    await new Promise(resolve => setTimeout(resolve, value))
    return value * 10
  })

  assert.deepEqual(results, [30, 10, 20])
})

test('multi-host execution is parallel while each host keeps an independent child task', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-multi-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tracker = { active: 0, maximum: 0, executions: {} }
  const admins = Object.fromEntries(['alpha', 'beta', 'gamma'].map(serverId => [serverId, fakeAdmin(root, serverId, tracker)]))
  const service = new MultiHostService({ dataRoot: root, adminFor: serverId => admins[serverId], concurrency: 2 })

  const run = await service.run({
    settings: {},
    passphrase: 'test',
    serverIds: Object.keys(admins),
    request: 'Install nginx test site',
    kind: 'catalog',
    catalogId: 'nginx-static-site',
    review: async ({ hosts }) => hosts.length === 3,
    externalVerify: async ({ serverId }) => ({ ok: true, message: `${serverId} reachable` })
  })

  assert.equal(run.status, 'completed')
  assert.equal(tracker.maximum, 2)
  assert.deepEqual(run.hosts.map(host => host.status), ['completed', 'completed', 'completed'])
  assert.equal(new Set(run.hosts.map(host => host.taskId)).size, 1, 'per-host task ids may match because each host owns its database')
  for (const host of run.hosts) {
    const task = admins[host.serverId].getTask(host.serverId, host.taskId)
    assert.equal(task.groupRunId, run.id)
    assert.equal(task.status, 'completed')
    assert.match(host.verification.message, /reachable/)
  }
  const reverted = await service.revert({ settings: {}, passphrase: 'test', runId: run.id })
  assert.equal(reverted.status, 'reverted')
  assert.deepEqual(reverted.hosts.map(host => host.status), ['reverted', 'reverted', 'reverted'])
})

test('a retry run can target only failed hosts and links their task history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-multi-retry-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tracker = { active: 0, maximum: 0, executions: {}, failOnce: new Set(['beta']) }
  const admins = Object.fromEntries(['alpha', 'beta'].map(serverId => [serverId, fakeAdmin(root, serverId, tracker)]))
  const service = new MultiHostService({ dataRoot: root, adminFor: serverId => admins[serverId], concurrency: 2 })
  const first = await service.run({
    settings: {},
    passphrase: 'test',
    serverIds: ['alpha', 'beta'],
    request: 'Install nginx test site',
    kind: 'catalog',
    catalogId: 'nginx-static-site'
  })

  assert.equal(first.status, 'partial')
  assert.equal(first.hosts.find(host => host.serverId === 'alpha').status, 'completed')
  assert.equal(first.hosts.find(host => host.serverId === 'beta').status, 'failed')

  const retry = await service.run({
    settings: {},
    passphrase: 'test',
    serverIds: ['beta'],
    request: first.request,
    kind: first.kind,
    catalogId: first.catalogId,
    retryOfRunId: first.id,
    retryInstructions: 'Retry only the failed host'
  })

  assert.equal(retry.status, 'completed')
  assert.deepEqual(tracker.executions, { alpha: 1, beta: 2 })
  const firstBeta = first.hosts.find(host => host.serverId === 'beta')
  const retryTask = admins.beta.getTask('beta', retry.hosts[0].taskId)
  assert.equal(retryTask.retryOfTaskId, firstBeta.taskId)
  assert.equal(retryTask.groupRunId, retry.id)
})

test('multi-host AI tasks consume each host consultation context independently', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-multi-consultation-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tracker = { active: 0, maximum: 0, executions: {} }
  const admins = Object.fromEntries(['alpha', 'beta'].map(serverId => [serverId, fakeAdmin(root, serverId, tracker)]))
  for (const [serverId, admin] of Object.entries(admins)) {
    const consultation = admin.createTask(serverId, '? How should nginx be deployed?', { kind: 'consultation' })
    admin.saveConsultation(serverId, consultation.id, {
      answer: `Use the package on ${serverId}.`,
      contextSummary: `Prefer the native package on ${serverId}.`
    })
  }

  const service = new MultiHostService({ dataRoot: root, adminFor: serverId => admins[serverId], concurrency: 2 })
  const run = await service.run({
    settings: {},
    passphrase: 'test',
    serverIds: ['alpha', 'beta'],
    request: 'Install nginx using the native package',
    kind: 'ai'
  })

  assert.equal(run.status, 'completed')
  for (const host of run.hosts) {
    const task = admins[host.serverId].getTask(host.serverId, host.taskId)
    assert.equal(task.consultationIds.length, 1)
    assert.equal(admins[host.serverId].listPendingConsultations(host.serverId).length, 0)
    assert.match(admins[host.serverId].getTaskConsultations(host.serverId, task.id)[0].consultationSummary, new RegExp(host.serverId))
  }
})

test('multi-host custom planning receives host-specific verified candidate intelligence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-multi-candidate-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tracker = { active: 0, maximum: 0, executions: {}, planOptions: {} }
  const admin = fakeAdmin(root, 'alpha', tracker)
  const service = new MultiHostService({ dataRoot: root, adminFor: () => admin })
  const run = await service.run({
    settings: {},
    passphrase: 'test',
    serverIds: ['alpha'],
    request: 'Build a custom PHP portal using our reviewed deployment practices',
    kind: 'ai',
    applicationDefaults: { adminEmail: 'owner@example.test' },
    planningHints: {
      alpha: {
        inventory: { webminaiLinuxContext: { identity: { id: 'ubuntu' } }, webminaiDocker: { preferred: false } },
        routing: {
          decision: 'informed_planning',
          catalogId: null,
          relevantCatalogIds: ['wordpress-linux'],
          confidence: 'high',
          rationale: 'Reuse the reviewed PHP foundation.'
        }
      }
    }
  })
  assert.equal(run.status, 'completed')
  assert.equal(tracker.planOptions.alpha.inventory.webminaiLinuxContext.identity.id, 'ubuntu')
  assert.equal(tracker.planOptions.alpha.candidateContext[0].catalogId, 'wordpress-linux')
  assert.deepEqual(tracker.planOptions.alpha.applicationDefaults, { adminEmail: 'owner@example.test' })
})

function fakeAdmin (root, serverId, tracker) {
  const tasks = new TaskStore(root)
  return {
    async capabilities () {
      return { platform: { os: 'linux' } }
    },
    async serverSecrets () {
      return { connectionUrl: `ssh://${serverId}.example`, actionKey: '00'.repeat(32) }
    },
    createTask: (host, request, options) => tasks.create(host, request, options),
    getTask: (host, taskId) => tasks.get(host, taskId),
    getTaskRetryHistory: (host, taskId) => [tasks.get(host, taskId)],
    listPendingConsultations: host => tasks.listPendingConsultations(host),
    getTaskConsultations: (host, taskId) => tasks.consultationsForTask(host, taskId),
    saveConsultation: (host, taskId, consultation) => tasks.saveConsultation(host, taskId, consultation),
    saveTaskPlan: (host, taskId, plan) => tasks.savePlan(host, taskId, plan),
    appendTaskProgress: (host, taskId, event) => tasks.appendProgress(host, taskId, event),
    markTaskRunning: (host, taskId) => tasks.markRunning(host, taskId),
    appendTaskResult: (host, taskId, result) => tasks.appendResult(host, taskId, result),
    saveTaskResults: (host, taskId, results) => tasks.saveResults(host, taskId, results),
    saveTaskError: (host, taskId, error) => tasks.saveError(host, taskId, error),
    cancelTask: (host, taskId) => tasks.cancel(host, taskId),
    markTaskReverting: (host, taskId) => tasks.markReverting(host, taskId),
    appendTaskRevertResult: (host, taskId, result) => tasks.appendRevertResult(host, taskId, result),
    saveTaskRevertResults: (host, taskId, results) => tasks.saveRevertResults(host, taskId, results),
    saveTaskRevertError: (host, taskId, error) => tasks.saveRevertError(host, taskId, error),
    async plan (options = {}) {
      tracker.planOptions ??= {}
      tracker.planOptions[serverId] = options
      return {
        summary: 'Install nginx',
        changeOverview: 'Install nginx using the native package',
        modifiedFiles: [],
        commands: [{ id: 'apply', command: 'install nginx', risk: 'change' }],
        revertCommands: [{ id: 'revert', command: 'remove nginx', risk: 'change' }]
      }
    },
    async revertTask () {
      await new Promise(resolve => setTimeout(resolve, 20))
      return [{ id: 'revert', status: 'completed' }]
    },
    async execute () {
      tracker.active++
      tracker.maximum = Math.max(tracker.maximum, tracker.active)
      tracker.executions[serverId] = (tracker.executions[serverId] ?? 0) + 1
      try {
        await new Promise(resolve => setTimeout(resolve, 30))
        if (tracker.failOnce?.delete(serverId)) throw new Error('simulated host failure')
        return [{ id: 'apply', status: 'completed' }]
      } finally {
        tracker.active--
      }
    }
  }
}
