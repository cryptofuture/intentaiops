import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AdminService } from '../src/admin-service.js'
import { TaskStore } from '../src/task-store.js'

test('task store persists per-server planning history and outcomes in SQLite', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-tasks-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)

  const first = store.create('edge-1', 'install htop', { groupRunId: 7 })
  store.appendProgress('edge-1', first.id, { type: 'reasoning', message: 'Inspecting package state' })
  store.savePlan('edge-1', first.id, {
    summary: 'Install',
    changeOverview: 'Install htop',
    modifiedFiles: ['/usr/bin/htop'],
    commands: [],
    revertCommands: [{ id: 'remove', command: 'remove htop' }]
  })
  store.markRunning('edge-1', first.id)
  store.appendResult('edge-1', first.id, { id: 'install', status: 'completed' })
  store.saveResults('edge-1', first.id, [{ id: 'install', status: 'completed' }])
  const second = store.create('edge-1', 'inspect system')
  store.saveError('edge-1', second.id, new Error('planner unavailable'))
  const retry = store.create('edge-1', second.request, {
    retryOfTaskId: second.id,
    retryInstructions: 'Use the saved error to correct the endpoint'
  })

  assert.equal(store.get('edge-1', first.id).status, 'completed')
  assert.equal(store.get('edge-1', first.id).groupRunId, 7)
  assert.equal(store.get('edge-1', first.id).plan.summary, 'Install')
  assert.equal(store.get('edge-1', first.id).changeOverview, 'Install htop')
  assert.deepEqual(store.get('edge-1', first.id).modifiedFiles, ['/usr/bin/htop'])
  assert.equal(store.get('edge-1', first.id).progress[0].type, 'reasoning')
  store.markReverting('edge-1', first.id)
  store.appendRevertResult('edge-1', first.id, { id: 'remove', status: 'completed' })
  store.saveRevertResults('edge-1', first.id, [{ id: 'remove', status: 'completed' }])
  assert.equal(store.get('edge-1', first.id).status, 'reverted')
  assert.ok(store.get('edge-1', first.id).revertedAt)
  assert.equal(store.get('edge-1', second.id).error, 'planner unavailable')
  assert.equal(store.get('edge-1', retry.id).retryOfTaskId, second.id)
  assert.equal(store.get('edge-1', retry.id).retryInstructions, 'Use the saved error to correct the endpoint')
  const admin = new AdminService({ dataRoot: root, tasks: store })
  assert.deepEqual(admin.getTaskRetryHistory('edge-1', retry.id).map(task => task.id), [second.id, retry.id])
  assert.deepEqual(store.list('edge-1').map(task => task.id), [retry.id, second.id, first.id])
  assert.throws(() => store.create('edge-1', 'bad retry', { retryOfTaskId: 999 }), /unknown retry task/)
  assert.deepEqual(store.list('edge-2'), [])
  assert.equal((await stat(path.join(root, 'edge-1', 'tasks.sqlite3'))).mode & 0o777, 0o600)
})

test('consultations are saved, minimized, and consumed by the next AI task', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-consultations-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TaskStore(root)

  const first = store.create('edge-1', '? Should nginx run in a container?', { kind: 'consultation' })
  store.saveConsultation('edge-1', first.id, {
    answer: 'Use the host package for this small static site.',
    contextSummary: 'Prefer host nginx; preserve the existing firewall policy.'
  })
  const second = store.create('edge-1', '? What about rollback?', {
    kind: 'consultation',
    consultationIds: [first.id],
    consumeConsultations: false
  })
  assert.deepEqual(store.listPendingConsultations('edge-1').map(item => item.id), [first.id])
  store.saveConsultation('edge-1', second.id, {
    answer: 'Capture configuration before changing it.',
    contextSummary: 'Prefer host nginx, preserve firewall policy, and restore the previous nginx configuration on rollback.'
  })

  assert.deepEqual(store.listPendingConsultations('edge-1').map(item => item.id), [second.id])
  assert.equal(store.get('edge-1', first.id).consumedByTaskId, second.id)
  const task = store.create('edge-1', 'Install the static site', {
    consultationIds: [second.id]
  })
  assert.deepEqual(task.consultationIds, [second.id])
  assert.equal(store.listPendingConsultations('edge-1').length, 0)
  assert.equal(store.get('edge-1', second.id).consumedByTaskId, task.id)
  assert.deepEqual(store.consultationsForTask('edge-1', task.id).map(item => item.consultationSummary), [
    'Prefer host nginx, preserve firewall policy, and restore the previous nginx configuration on rollback.'
  ])

  const retry = store.create('edge-1', task.request, {
    retryOfTaskId: task.id,
    consultationIds: task.consultationIds,
    consumeConsultations: false
  })
  assert.deepEqual(retry.consultationIds, task.consultationIds)
  assert.throws(() => store.create('edge-1', 'Unrelated task', {
    consultationIds: [second.id]
  }), /already used/)
  assert.throws(() => store.saveConsultation('edge-1', retry.id, {
    answer: 'Not a consultation.',
    contextSummary: 'Not a consultation.'
  }), /is not a consultation/)
})
