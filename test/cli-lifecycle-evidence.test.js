import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { assertCliLifecycleEvidence } from '../scripts/assert-cli-lifecycle.js'
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

for (const [name, change] of [
  ['duplicate dispatch', value => value.first.events.push(value.first.events.find(event => event.type === 'command_dispatched'))],
  ['missing approval', value => { value.first.events = value.first.events.filter(event => event.type !== 'plan_approved') }],
  ['missing durable intent', value => { value.first.events = value.first.events.filter(event => event.type !== 'command_prepared') }],
  ['wrong execution attempt', value => { value.first.events.find(event => event.type === 'command_completed').attemptId = 'different-attempt' }],
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
