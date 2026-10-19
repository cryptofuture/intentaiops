import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { assertCliLifecycleEvidence, assertCliReviewedRollbackEvidence } from '../scripts/assert-cli-lifecycle.js'
import { assertCompletedExecutionIsNotReplayed } from '../scripts/audit-linux-cli-history.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { planFingerprint } from '../src/execution-journal.js'

const command = (id, text, risk = 'change') => ({ id, command: text, risk, requiresSudo: true, timeoutMs: 1000, dependsOn: [] })
const probe = command('probe', 'read-fixed-managed-state', 'read')
const before = 'packages=original\nstate=absent'
const applied = 'packages=with-fixture\nstate=present'

function record (id, plan, status = 'completed', text = before) {
  const result = item => ({ id: item.id, status: 'completed', result: { exitCode: 0, signal: 0, timedOut: false, stdout: item.risk === 'read' ? text : 'ok' } })
  const events = (commands, rollback) => commands.flatMap(item => ['plan_approved', 'command_prepared', 'command_dispatched', 'command_completed'].map(type => ({ commandId: item.id, attemptId: type === 'plan_approved' ? null : `attempt-${item.id}`, revision: planFingerprint(plan), type, metadata: rollback ? { operation: 'rollback' } : {} })))
  return { id, kind: id === 2 ? 'catalog' : 'ai', status, plan, results: plan.commands.map(result), revertResults: status === 'reverted' ? plan.revertCommands.map(result) : [], events: [...events(plan.commands, false), ...(status === 'reverted' ? events(plan.revertCommands, true) : [])] }
}

function fixture () {
  const plan = { commands: [command('apply', 'apply-reviewed-fixture')], revertCommands: [command('undo', 'undo-reviewed-fixture')] }
  const read = { commands: [probe], revertCommands: [] }
  const value = {
    baseline: record(1, read),
    first: record(2, plan, 'reverted'),
    repeat: record(3, { commands: [{ ...probe, id: 'before-repeat' }, ...structuredClone(plan.commands), { ...probe, id: 'after-repeat' }], revertCommands: structuredClone(plan.revertCommands) }, 'reverted', applied),
    afterFirstRevert: record(4, read),
    afterSecondRevert: record(5, read)
  }
  return ordered(value)
}

function ordered (value) {
  const forward = task => task.events.filter(event => !event.metadata.operation)
  const rollback = task => task.events.filter(event => event.metadata.operation === 'rollback')
  let id = 1
  for (const phase of [forward(value.baseline), forward(value.first), forward(value.repeat), rollback(value.first), forward(value.afterFirstRevert), rollback(value.repeat), forward(value.afterSecondRevert)]) {
    for (const event of phase) event.id = id++
  }
  return value
}

test('CLI lifecycle evidence proves unchanged repeat state, both rollbacks and no duplicate dispatch', () => {
  assert.deepEqual(assertCliLifecycleEvidence(fixture()), { firstTask: 2, repeatTask: 3, commands: 1, rollbackCommands: 1, scope: 'reviewed state probe and single-dispatch journal evidence' })
})

test('completed common-task evidence can be replay-checked without contacting any target', async () => {
  const task = record(2, buildCommonTask('systemd-service', 2, { platform: 'linux' }).plan, 'reverted')
  await assertCompletedExecutionIsNotReplayed(task)
  task.events.find(event => event.type === 'command_completed').type = 'command_outcome_unknown'
  await assert.rejects(assertCompletedExecutionIsNotReplayed(task), /outcome|completion/u)
})

function reviewedRollbackFixture () {
  const task = fixture().first
  const cleanup = command('reviewed-cleanup', 'reviewed-guarded-cleanup')
  const plan = { commands: [cleanup], revertCommands: [], operatorRollback: true }
  task.revisions = [{ approved: 1, plan }]
  task.revertResults = [{ id: cleanup.id, status: 'completed', result: { exitCode: 0 } }]
  task.events = task.events.filter(event => event.metadata.operation !== 'rollback')
  task.events.push(...['plan_approved', 'command_prepared', 'command_dispatched', 'command_completed'].map((type, index) => ({ id: 100 + index, type, commandId: cleanup.id, attemptId: type === 'plan_approved' ? null : 'cleanup-attempt', revision: planFingerprint(task.plan), metadata: { operation: 'rollback', rollbackRevision: planFingerprint(plan), ...(type === 'command_completed' ? { exitCode: 0 } : {}) } })))
  return task
}

test('reviewed recovery rollback evidence binds approval, original plan, attempts and completion', () => {
  assertCliReviewedRollbackEvidence(reviewedRollbackFixture())
})

for (const [name, mutate] of [
  ['unapproved cleanup', task => { task.revisions[0].approved = 0 }],
  ['changed cleanup bytes', task => { task.revisions[0].plan.commands[0].command = 'different-cleanup' }],
  ['stale parent', task => { task.events.at(-1).revision = 'a'.repeat(64) }],
  ['unknown outcome', task => { task.events.at(-1).type = 'command_outcome_unknown' }],
  ['wrong attempt', task => { task.events.at(-1).attemptId = 'other-attempt' }],
  ['duplicate dispatch', task => { task.events.push({ ...task.events.at(-2), id: 104 }) }]
]) {
  test(`reviewed recovery audit rejects ${name}`, () => {
    const task = reviewedRollbackFixture()
    mutate(task)
    assert.throws(() => assertCliReviewedRollbackEvidence(task))
  })
}

function revisedFixture () {
  const value = fixture()
  const setup = command('setup', 'confirmed-original-setup')
  const obsolete = command('failed', 'confirmed-failed-configuration')
  const original = { commands: [setup, obsolete], revertCommands: value.first.plan.revertCommands }
  const revised = { commands: [setup, command('continued', 'reviewed-remaining-work')], revertCommands: original.revertCommands }
  value.first = record(2, revised, 'reverted')
  value.repeat = record(3, { commands: [{ ...probe, id: 'before-repeat' }, ...structuredClone(revised.commands), { ...probe, id: 'after-repeat' }], revertCommands: structuredClone(revised.revertCommands) }, 'reverted', applied)
  value.first.revisions = [{ approved: 1, plan: original }, { approved: 1, plan: revised }]
  for (const event of value.first.events.filter(event => event.commandId === 'setup')) event.revision = planFingerprint(original)
  value.first.events.splice(4, 0, ...['plan_approved', 'command_prepared', 'command_dispatched', 'command_failed'].map(type => ({ type, commandId: 'failed', attemptId: type === 'plan_approved' ? null : 'failed-attempt', revision: planFingerprint(original), metadata: type === 'command_failed' ? { exitCode: 1 } : {} })))
  return ordered(value)
}

test('CLI lifecycle evidence preserves confirmed history across approved forward revisions', () => {
  const result = assertCliLifecycleEvidence(revisedFixture())
  assert.equal(result.commands, 2)
})

for (const [name, change] of [
  ['unapproved historical revision', value => { value.first.revisions[0].approved = 0 }],
  ['rewritten completed definition', value => { value.first.revisions[0].plan.commands[0].command = 'different-setup' }],
  ['uncertain removed operation', value => { value.first.events.find(event => event.commandId === 'failed' && event.type === 'command_failed').type = 'command_outcome_unknown' }],
  ['discarded completed operation', value => { value.first.events.find(event => event.commandId === 'failed' && event.type === 'command_failed').type = 'command_completed' }],
  ['missing historical preparation', value => { value.first.events = value.first.events.filter(event => !(event.commandId === 'failed' && event.type === 'command_prepared')) }]
]) {
  test(`CLI lifecycle evidence rejects ${name}`, () => {
    const value = revisedFixture()
    change(value)
    assert.throws(() => assertCliLifecycleEvidence(value))
  })
}

function retriedFixture () {
  const value = fixture()
  const retry = { attempts: 3, intervalMs: 0, exitCodes: [75] }
  value.first.plan.commands[0].retry = retry
  value.repeat.plan.commands[1].retry = structuredClone(retry)
  value.first.results[0].attempts = 2
  value.first.events.splice(1, 0, ...['command_prepared', 'command_dispatched', 'command_failed'].map(type => ({ commandId: 'apply', attemptId: 'pending-poll', revision: '', type, metadata: type === 'command_failed' ? { exitCode: 75 } : {} })))
  for (const task of [value.first, value.repeat]) for (const event of task.events) event.revision = planFingerprint(task.plan)
  return ordered(value)
}

test('CLI lifecycle evidence accepts only confirmed attempts within a reviewed retry contract', () => {
  assert.equal(assertCliLifecycleEvidence(retriedFixture()).scope, 'reviewed state probe and declared-retry journal evidence')
})

for (const [name, change] of [
  ['uncertain retry', value => { value.first.events.find(event => event.type === 'command_failed').type = 'command_outcome_unknown' }],
  ['undeclared exit code', value => { value.first.events.find(event => event.type === 'command_failed').metadata.exitCode = 1 }],
  ['retry limit exceeded', value => { value.first.plan.commands[0].retry.attempts = 1 }],
  ['unrecorded attempt count', value => { delete value.first.results[0].attempts }],
  ['operator attestation is not an automatic retry result', value => { value.first.events.find(event => event.type === 'command_failed').metadata.reconciled = true }],
  ['native state evidence missing', value => { value.first.plan.commands[0].retry.states = ['failed'] }],
  ['overlapping attempts', value => { const events = value.first.events; const previous = events.find(event => event.type === 'command_failed'); events.splice(events.indexOf(previous), 1); events.splice(events.findIndex(event => event.type === 'command_completed'), 0, previous) }]
]) {
  test(`CLI lifecycle evidence rejects ${name}`, () => {
    const value = retriedFixture()
    change(value)
    assert.throws(() => assertCliLifecycleEvidence(value))
  })
}

for (const [name, change] of [
  ['duplicate dispatch', value => value.first.events.push(value.first.events.find(event => event.type === 'command_dispatched'))],
  ['missing approval', value => { value.first.events = value.first.events.filter(event => event.type !== 'plan_approved') }],
  ['missing durable intent', value => { value.first.events = value.first.events.filter(event => event.type !== 'command_prepared') }],
  ['wrong execution attempt', value => { value.first.events.find(event => event.type === 'command_completed').attemptId = 'different-attempt' }],
  ['stale approval revision', value => { for (const event of value.first.events.filter(event => !event.metadata.operation && ['plan_approved', 'command_dispatched'].includes(event.type))) event.revision = 'old-approved-plan' }],
  ['unapproved preparation revision', value => { value.first.events.find(event => event.type === 'command_prepared').revision = 'different-plan' }],
  ['orphan completion', value => { const done = value.first.events.find(event => event.type === 'command_completed'); value.first.events.splice(value.first.events.indexOf(done) + 1, 0, { ...done, attemptId: 'unrecorded-attempt' }); ordered(value) }],
  ['unresolved observation', value => value.first.events.push({ ...value.first.events.at(-5), type: 'command_outcome_unknown', metadata: {} })],
  ['changed apply', value => { value.repeat.plan.commands[1].command = 'different-action' }],
  ['changed rollback', value => { value.repeat.plan.revertCommands = [{ ...value.repeat.plan.revertCommands[0], command: 'different-rollback' }] }],
  ['changed applied state', value => { value.repeat.results.at(-1).result.stdout = 'different-applied-state' }],
  ['baseline not restored', value => { value.afterFirstRevert.results[0].result.stdout = 'different-baseline' }],
  ['second rollback changed state', value => { value.afterSecondRevert.results[0].result.stdout = 'different-baseline' }],
  ['redacted evidence', value => { value.baseline.results[0].result.stdout = '[redacted sensitive output]' }],
  ['truncated evidence', value => { value.baseline.results[0].result.stdoutTruncated = true }],
  ['signal without confirmed success', value => { value.first.results[0].result.signal = 9 }],
  ['incomplete rollback', value => { value.repeat.status = 'revert_failed' }],
  ['reused observation', value => { value.afterSecondRevert.id = value.afterFirstRevert.id }],
  ['observation recorded before rollback', value => { for (const event of value.afterFirstRevert.events) event.id -= 20 }],
  ['repeat probe recorded after reapply', value => { for (const event of value.repeat.events) { if (event.commandId === 'before-repeat') event.id += 4; else if (event.commandId === 'apply' && !event.metadata.operation) event.id -= 4 } }]
]) {
  test(`CLI lifecycle evidence rejects ${name}`, () => {
    const value = fixture()
    change(value)
    if (['changed apply', 'changed rollback'].includes(name)) for (const event of value.repeat.events) event.revision = planFingerprint(value.repeat.plan)
    assert.throws(() => assertCliLifecycleEvidence(value))
  })
}

test('CLI lifecycle checker reads history without a vault key, remote calls or writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-cli-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'history'))
  const settingsPath = path.join(root, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({ servers: { lab: { historyId: 'history' } } }))
  const databasePath = path.join(root, 'history/tasks.sqlite3')
  const database = new Database(databasePath)
  database.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY,status TEXT,kind TEXT,plan_json TEXT,results_json TEXT,revert_results_json TEXT); CREATE TABLE execution_events(id INTEGER PRIMARY KEY,task_id INTEGER,command_id TEXT,attempt_id TEXT,revision TEXT,type TEXT,metadata_json TEXT)')
  for (const value of Object.values(fixture())) {
    database.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(value.id, value.status, value.kind, JSON.stringify(value.plan), JSON.stringify(value.results), JSON.stringify(value.revertResults))
    for (const event of value.events) database.prepare('INSERT INTO execution_events(id,task_id,command_id,attempt_id,revision,type,metadata_json) VALUES(?,?,?,?,?,?,?)').run(event.id, value.id, event.commandId, event.attemptId, event.revision, event.type, JSON.stringify(event.metadata))
  }
  database.close()
  const bytes = await readFile(databasePath)
  const settings = await readFile(settingsPath)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/assert-cli-lifecycle.js', import.meta.url)), root, 'lab', '1', '2', '3', '4', '5'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).passed, true)
  assert.deepEqual(await readFile(databasePath), bytes)
  assert.deepEqual(await readFile(settingsPath), settings)
})
