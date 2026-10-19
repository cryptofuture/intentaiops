import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { listCommonTasks } from '../src/common-tasks.js'
import { executeApprovedPlan } from '../src/plan-validator.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { resolveServerDirectory, validateServerId } from '../src/server-id.js'
import { assertCliTaskExecutionEvidence, assertCliReviewedRollbackEvidence, findCliLifecycleEvidence } from './assert-cli-lifecycle.js'

export async function assertCompletedExecutionIsNotReplayed (task) {
  assertCliTaskExecutionEvidence(task)
  const forbidden = () => assert.fail('completed history must never contact a host or request new approval')
  const results = await executeApprovedPlan({
    plan: task.plan,
    policy: rootExecutionPolicy(),
    netdata: new Proxy({}, { get: () => forbidden }),
    approve: forbidden,
    beforeCommand: forbidden,
    onExecutionEvent: forbidden,
    completedCommandIds: task.plan.commands.map(command => command.id)
  })
  assert.deepEqual(results, [])
}

async function main () {
  const [dataRoot, mode] = process.argv.slice(2)
  assert.ok(dataRoot && process.argv.length <= 4 && (!mode || mode === '--require-repeat-restoration'), 'Usage: node scripts/audit-linux-cli-history.js DATA_ROOT [--require-repeat-restoration]')
  const settings = JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8'))
  const applications = new Set(listCommonTasks({ platform: 'linux', category: 'application' }).filter(task => !task.prerequisite).map(task => task.id))
  let total = 0
  let reviewedRecoveries = 0
  let repeated = 0
  for (const [host, server] of Object.entries(settings.servers)) {
    validateServerId(host)
    assert.ok(host.startsWith('webminai-'), 'this audit is restricted to the configured disposable Linux lab')
    const database = new Database(path.join(resolveServerDirectory(dataRoot, server.historyId ?? host), 'tasks.sqlite3'), { readonly: true, fileMustExist: true })
    try {
      const cases = []
      const seen = new Set()
      const lifecycleTasks = mode ? readLifecycleTasks(database) : null
      for (const row of database.prepare("SELECT id, status, catalog_id FROM tasks WHERE kind = 'catalog' AND status = 'reverted' ORDER BY id DESC").iterate()) {
        if (!applications.has(row.catalog_id) || seen.has(row.catalog_id)) continue
        seen.add(row.catalog_id)
        const payload = database.prepare('SELECT plan_json, results_json, revert_results_json FROM tasks WHERE id = ?').get(row.id)
        assert.ok(Object.values(payload).every(value => value === null || value.length <= 2 * 1024 * 1024), 'task evidence exceeds inspection limit')
        const events = database.prepare('SELECT id, command_id AS commandId, attempt_id AS attemptId, revision, type, metadata_json FROM execution_events WHERE task_id = ? ORDER BY id LIMIT 1001').all(row.id)
        const revisions = database.prepare('SELECT approved, plan_json FROM plan_revisions WHERE task_id = ? AND approved = 1 ORDER BY id LIMIT 33').all(row.id)
        assert.ok(events.length <= 1000 && revisions.length <= 32 && revisions.every(item => item.plan_json.length <= 2 * 1024 * 1024), 'execution evidence exceeds inspection limit')
        const task = { id: row.id, kind: 'catalog', status: row.status, plan: JSON.parse(payload.plan_json), results: JSON.parse(payload.results_json ?? '[]'), revertResults: JSON.parse(payload.revert_results_json ?? '[]'), revisions: revisions.map(item => ({ approved: item.approved, plan: JSON.parse(item.plan_json) })), events: events.map(event => ({ ...event, metadata: JSON.parse(event.metadata_json) })) }
        await assertCompletedExecutionIsNotReplayed(task)
        const reviewed = task.revisions.some(item => item.plan.operatorRollback)
        if (reviewed) { assertCliReviewedRollbackEvidence(task); reviewedRecoveries++ } else assertCliTaskExecutionEvidence(task, true)
        const repeatRestoration = lifecycleTasks ? findCliLifecycleEvidence(lifecycleTasks, { ...task, kind: 'catalog' }) : undefined
        if (repeatRestoration) repeated++
        cases.push({ catalogId: row.catalog_id, taskId: row.id, reviewedRecovery: reviewed, ...(lifecycleTasks ? { repeatRestoration } : {}) })
      }
      total += cases.length
      console.log(JSON.stringify({ host, cases, passed: cases.length }))
    } finally { database.close() }
  }
  const passed = !mode || (total > 0 && repeated === total)
  console.log(JSON.stringify({ passed, applicationCycles: total, reviewedRecoveries, completedReplayChecks: total, ...(mode ? { repeatRestorationCycles: repeated, missingRepeatRestoration: total - repeated } : {}), hostConnections: 0, scope: mode ? 'ordered reviewed repeated execution and exact selected-probe restoration, not whole-host restoration' : 'journal correctness and completed-step skipping, not universal filesystem restoration' }))
  if (!passed) process.exitCode = 1
}

function readLifecycleTasks (database) {
  const size = database.prepare("SELECT count(*) AS count, coalesce(sum(length(coalesce(plan_json, '')) + length(coalesce(results_json, '')) + length(coalesce(revert_results_json, ''))), 0) AS bytes FROM tasks WHERE status IN ('completed', 'reverted') AND plan_json IS NOT NULL").get()
  assert.ok(size.count <= 1024 && size.bytes <= 64 * 1024 * 1024, 'lifecycle history exceeds the inspection limit')
  const rows = database.prepare("SELECT id, kind, status, substr(plan_json, 1, 2097153) AS plan_json, substr(results_json, 1, 2097153) AS results_json, substr(revert_results_json, 1, 2097153) AS revert_results_json FROM tasks WHERE status IN ('completed', 'reverted') AND plan_json IS NOT NULL ORDER BY id LIMIT 1025").all()
  assert.ok(rows.length <= 1024, 'lifecycle history exceeds the inspection limit')
  let bytes = 0
  return rows.map(row => {
    for (const field of ['plan_json', 'results_json', 'revert_results_json']) {
      const size = Buffer.byteLength(row[field] ?? '')
      bytes += size
      assert.ok(size <= 2 * 1024 * 1024 && bytes <= 64 * 1024 * 1024, 'lifecycle payload exceeds the inspection limit')
    }
    const events = database.prepare('SELECT id, command_id AS commandId, attempt_id AS attemptId, revision, type, substr(metadata_json, 1, 65537) AS metadata_json FROM execution_events WHERE task_id = ? ORDER BY id LIMIT 1001').all(row.id)
    const revisions = database.prepare('SELECT approved, substr(plan_json, 1, 2097153) AS plan_json FROM plan_revisions WHERE task_id = ? AND approved = 1 ORDER BY id LIMIT 33').all(row.id)
    assert.ok(events.length <= 1000 && revisions.length <= 32, 'lifecycle journal exceeds the inspection limit')
    for (const event of events) {
      const size = Buffer.byteLength(event.metadata_json)
      bytes += size
      assert.ok(size <= 65536 && bytes <= 64 * 1024 * 1024, 'lifecycle events exceed the inspection limit')
    }
    for (const revision of revisions) {
      const size = Buffer.byteLength(revision.plan_json)
      bytes += size
      assert.ok(size <= 2 * 1024 * 1024 && bytes <= 64 * 1024 * 1024, 'lifecycle revisions exceed the inspection limit')
    }
    return { id: row.id, kind: row.kind, status: row.status, plan: JSON.parse(row.plan_json), results: JSON.parse(row.results_json ?? '[]'), revertResults: JSON.parse(row.revert_results_json ?? '[]'), revisions: revisions.map(revision => ({ approved: revision.approved, plan: JSON.parse(revision.plan_json) })), events: events.map(event => ({ ...event, metadata: JSON.parse(event.metadata_json) })) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
