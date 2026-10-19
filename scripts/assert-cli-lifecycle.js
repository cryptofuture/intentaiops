import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { planFingerprint } from '../src/execution-journal.js'
import { resolveServerDirectory, validateServerId } from '../src/server-id.js'

const completed = result => result?.status === 'completed' && result.result?.exitCode === 0 && !result.result.timedOut && !result.result.signal

function commandsMatch (first, second) {
  const fields = item => ({ id: item.id, command: item.command, risk: item.risk, timeoutMs: item.timeoutMs, requiresSudo: item.requiresSudo, executionMode: item.executionMode ?? null, dependsOn: item.dependsOn ?? [], retry: item.retry ?? null })
  return first.length === second.length && first.every((item, index) => planFingerprint(fields(item)) === planFingerprint(fields(second[index])))
}

function approvedPlan (task, revision) {
  const plan = [task.plan, ...(task.revisions ?? []).filter(item => item.approved === 1 || item.approved === true).map(item => item.plan)].find(plan => planFingerprint(plan) === revision)
  assert.ok(plan, 'attempt does not match the approved plan revision')
  return plan
}

function confirmed (task, rollback = false) {
  const commands = rollback ? task.plan.revertCommands : task.plan.commands
  const results = rollback ? task.revertResults : task.results
  assert.ok(commands.length > 0 && results?.length === commands.length && results.every(completed), 'missing or incomplete command results')
  for (const item of commands) {
    assert.ok(results.some(result => result.id === item.id), 'result does not identify the reviewed command')
    const events = task.events.filter(event => event.commandId === item.id && (event.metadata?.operation === 'rollback') === rollback)
    const dispatched = events.filter(event => event.type === 'command_dispatched')
    const result = results.find(result => result.id === item.id)
    assert.ok(dispatched.length > 0 && dispatched.length === (result.attempts ?? 1), 'dispatch count differs from recorded attempts')
    assert.ok(dispatched.every(event => typeof event.attemptId === 'string' && event.attemptId) && new Set(dispatched.map(event => event.attemptId)).size === dispatched.length, 'each dispatch requires a distinct attempt')
    assert.ok(events.filter(event => ['command_prepared', 'command_acknowledged', 'command_completed', 'command_failed', 'command_outcome_unknown'].includes(event.type)).every(event => dispatched.some(dispatch => dispatch.attemptId === event.attemptId)), 'orphan command observation has no dispatch')
    if (dispatched.length > 1) {
      const retry = item.retry
      assert.ok(Number.isInteger(retry?.attempts) && retry.attempts >= dispatched.length && retry.attempts <= 120, 'repeated dispatch exceeds the declared retry limit')
      assert.ok(Number.isInteger(retry.intervalMs) && retry.intervalMs >= 0 && retry.intervalMs <= 10000 && (retry.attempts - 1) * retry.intervalMs <= 900000, 'invalid declared retry window')
      assert.ok(Array.isArray(retry.exitCodes) && retry.exitCodes.length > 0 && retry.exitCodes.length <= 8 && retry.exitCodes.every(code => Number.isInteger(code) && code > 0 && code <= 255), 'declared retry exit codes required')
      assert.ok(!retry.states, 'state-restricted retries require native state evidence not recorded in this journal')
    }
    const approval = events.findIndex(event => event.type === 'plan_approved' && event.revision === dispatched[0].revision)
    let previous = approval
    for (const [index, dispatch] of dispatched.entries()) {
      const attempts = events.filter(event => event.attemptId === dispatch.attemptId)
      const prepared = attempts.filter(event => event.type === 'command_prepared')
      const terminal = attempts.filter(event => ['command_completed', 'command_failed', 'command_outcome_unknown'].includes(event.type))
      const definition = approvedPlan(task, dispatch.revision)[rollback ? 'revertCommands' : 'commands'].find(command => command.id === item.id)
      assert.ok(definition && planFingerprint(definition) === planFingerprint(item) && dispatch.revision === dispatched[0].revision && prepared.every(event => event.revision === dispatch.revision), 'attempt does not match the approved plan revision')
      assert.ok(approval >= 0 && prepared.length === 1 && events.indexOf(prepared[0]) > previous && events.indexOf(dispatch) > events.indexOf(prepared[0]), 'approved ordered execution intent must precede dispatch')
      assert.ok(terminal.length === 1 && events.indexOf(terminal[0]) > events.indexOf(dispatch) && terminal[0].revision === dispatch.revision, 'missing authoritative attempt outcome')
      if (index === dispatched.length - 1) assert.ok(terminal[0].type === 'command_completed' && (terminal[0].metadata?.exitCode ?? 0) === 0, 'completion does not confirm the approved attempt')
      else assert.ok(terminal[0].type === 'command_failed' && item.retry.exitCodes.includes(terminal[0].metadata?.exitCode) && !terminal[0].metadata?.reconciled, 'retry requires a confirmed declared failure, not an uncertain outcome')
      previous = events.indexOf(terminal[0])
    }
    assert.ok(events.at(-1)?.type === 'command_completed', 'command still has an unresolved execution state')
  }
  if (!rollback) {
    const ids = new Set(commands.map(command => command.id))
    const removed = task.events.filter(event => event.commandId && !ids.has(event.commandId) && event.metadata?.operation !== 'rollback')
    const dispatched = removed.filter(event => event.type === 'command_dispatched')
    assert.ok(removed.filter(event => ['command_prepared', 'command_acknowledged', 'command_completed', 'command_failed', 'command_outcome_unknown'].includes(event.type)).every(event => dispatched.some(dispatch => dispatch.commandId === event.commandId && dispatch.attemptId === event.attemptId)), 'removed operation has an orphan observation')
    for (const dispatch of dispatched) {
      const definition = approvedPlan(task, dispatch.revision).commands.find(command => command.id === dispatch.commandId)
      const attempts = removed.filter(event => event.commandId === dispatch.commandId && event.attemptId === dispatch.attemptId)
      const prepared = attempts.filter(event => event.type === 'command_prepared')
      const terminal = attempts.filter(event => ['command_completed', 'command_failed', 'command_outcome_unknown'].includes(event.type))
      const approval = removed.findIndex(event => event.commandId === dispatch.commandId && event.type === 'plan_approved' && event.revision === dispatch.revision)
      assert.ok(definition && dispatch.attemptId && dispatched.filter(event => event.commandId === dispatch.commandId).length === 1 && approval >= 0 && prepared.length === 1 && prepared[0].revision === dispatch.revision && removed.indexOf(prepared[0]) > approval && removed.indexOf(dispatch) > removed.indexOf(prepared[0]), 'removed operation requires one approved ordered attempt')
      assert.ok(terminal.length === 1 && terminal[0].type === 'command_failed' && terminal[0].revision === dispatch.revision && removed.indexOf(terminal[0]) > removed.indexOf(dispatch) && Number.isInteger(terminal[0].metadata?.exitCode) && terminal[0].metadata.exitCode !== 0 && !terminal[0].metadata.reconciled, 'removed operation lacks a confirmed failure; completed or uncertain history cannot disappear')
    }
  }
}

export { confirmed as assertCliTaskExecutionEvidence }

export function assertCliReviewedRollbackEvidence (task) {
  const revision = (task.revisions ?? []).filter(item => item.approved && item.plan.operatorRollback).at(-1)
  assert.ok(revision && task.status === 'reverted', 'approved recovery rollback and reverted task required')
  const plan = revision.plan
  const fingerprint = planFingerprint(plan)
  const parent = planFingerprint(task.plan)
  assert.deepEqual(task.revertResults?.map(item => item.id), plan.commands.map(item => item.id), 'recovery results differ from approved cleanup')
  const events = task.events.filter(event => event.metadata?.operation === 'rollback' && event.metadata.rollbackRevision === fingerprint)
  let previous = 0
  for (const command of plan.commands) {
    assert.ok(completed(task.revertResults.find(item => item.id === command.id)), 'recovery cleanup did not complete')
    const group = events.filter(event => event.commandId === command.id)
    assert.ok(group.every(event => event.revision === parent), 'recovery parent plan changed')
    const ordered = ['plan_approved', 'command_prepared', 'command_dispatched', 'command_completed'].map(type => {
      const matches = group.filter(event => event.type === type)
      assert.equal(matches.length, 1, 'reviewed recovery requires exactly one ordered attempt')
      return matches[0]
    })
    assert.ok(ordered.every((event, index) => event.id > (index ? ordered[index - 1].id : previous)), 'recovery approval, intent and outcome are out of order')
    assert.ok(ordered[1].attemptId && ordered[1].attemptId === ordered[2].attemptId && ordered[2].attemptId === ordered[3].attemptId, 'recovery attempt identity changed')
    assert.equal(ordered[3].metadata.exitCode, 0)
    assert.equal(group.at(-1).type, 'command_completed', 'recovery cleanup has unresolved observations')
    previous = ordered[3].id
  }
}

function output (task, commandId) {
  const result = task.results.find(result => result.id === commandId)
  assert.ok(completed(result) && typeof result.result.stdout === 'string' && result.result.stdout.trim() && result.result.stdout.length <= 65536 && !result.result.stdoutTruncated, 'probe evidence is absent, incomplete or truncated')
  assert.ok(!/\[redacted|\[remote output withheld/iu.test(result.result.stdout), 'redacted output cannot prove baseline restoration')
  return result.result.stdout.trim()
}

export function assertCliLifecycleEvidence ({ baseline, first, repeat, afterFirstRevert, afterSecondRevert }) {
  const tasks = [baseline, first, repeat, afterFirstRevert, afterSecondRevert]
  assert.ok(new Set(tasks.map(task => task.id)).size === tasks.length, 'each observation must have its own task record')
  assert.ok(first.kind === 'catalog' && first.status === 'reverted' && repeat.status === 'reverted', 'both reviewed apply/rollback cycles must finish')
  for (const task of tasks) confirmed(task)
  confirmed(first, true)
  confirmed(repeat, true)
  assert.ok(commandsMatch(first.plan.revertCommands, repeat.plan.revertCommands), 'the repeated rollback changed its reviewed commands')
  assert.ok(baseline.status === 'completed' && baseline.plan.commands.length === 1 && baseline.plan.commands[0].risk === 'read', 'baseline must be a completed reviewed read-only probe')
  const probe = baseline.plan.commands[0]
  const repeated = repeat.plan.commands
  assert.ok(repeated.length === first.plan.commands.length + 2 && repeated[0].command === probe.command && repeated.at(-1).command === probe.command && repeated[0].risk === 'read' && repeated.at(-1).risk === 'read', 'repeat must bracket the unchanged apply with identical read-only probes')
  assert.ok(commandsMatch(first.plan.commands, repeated.slice(1, -1)), 'the repeated apply changed its reviewed commands')
  const forwardEvents = repeat.events.filter(event => event.metadata?.operation !== 'rollback')
  const observedBefore = forwardEvents.find(event => event.commandId === repeated[0].id && event.type === 'command_completed')
  const observedAfter = forwardEvents.find(event => event.commandId === repeated.at(-1).id && event.type === 'command_dispatched')
  const reapplied = new Set(repeated.slice(1, -1).map(item => item.id))
  const changing = forwardEvents.filter(event => reapplied.has(event.commandId))
  assert.ok(changing.filter(event => event.type === 'command_dispatched').every(event => observedBefore.id < event.id) && changing.filter(event => event.type === 'command_completed').every(event => event.id < observedAfter.id), 'the repeat probes did not bracket execution in the journal')
  assert.ok(output(repeat, repeated[0].id) === output(repeat, repeated.at(-1).id), 'second apply changed the observed managed state')
  const before = output(baseline, probe.id)
  for (const task of [afterFirstRevert, afterSecondRevert]) {
    assert.ok(task.status === 'completed' && task.plan.commands.length === 1 && task.plan.commands[0].risk === 'read' && task.plan.commands[0].command === probe.command, 'restoration must use a fresh identical read-only probe')
    assert.ok(output(task, task.plan.commands[0].id) === before, 'rollback did not restore the observed baseline')
  }
  const phase = (task, rollback = false) => {
    const events = task.events.filter(event => (event.metadata?.operation === 'rollback') === rollback)
    assert.ok(events.length > 0 && events.every(event => Number.isSafeInteger(event.id) && event.id > 0), 'ordered journal event IDs are required')
    return { start: Math.min(...events.filter(event => event.type === 'command_dispatched').map(event => event.id)), end: Math.max(...events.filter(event => event.type === 'command_completed').map(event => event.id)) }
  }
  const phases = [phase(baseline), phase(first), phase(repeat), phase(first, true), phase(afterFirstRevert), phase(repeat, true), phase(afterSecondRevert)]
  assert.ok(phases.every((value, index) => index === 0 || phases[index - 1].end < value.start), 'observations and execution phases are out of order')
  const retried = tasks.some(task => [...task.results, ...(task.revertResults ?? [])].some(result => result.attempts > 1))
  return { firstTask: first.id, repeatTask: repeat.id, commands: first.plan.commands.length, rollbackCommands: first.plan.revertCommands.length, scope: retried ? 'reviewed state probe and declared-retry journal evidence' : 'reviewed state probe and single-dispatch journal evidence' }
}

async function main () {
  const [dataRoot, host, ...numbers] = process.argv.slice(2)
  assert.ok(dataRoot && host && numbers.length === 5 && numbers.every(value => /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value))), 'Usage: node scripts/assert-cli-lifecycle.js DATA_ROOT HOST BASELINE APPLY REAPPLY AFTER_REVERT AFTER_SECOND_REVERT')
  validateServerId(host)
  const settings = JSON.parse(await readFile(path.join(dataRoot, 'settings.json'), 'utf8'))
  assert.ok(Object.hasOwn(settings.servers, host), 'host is not configured')
  const directory = resolveServerDirectory(dataRoot, settings.servers[host].historyId ?? host)
  const database = new Database(path.join(directory, 'tasks.sqlite3'), { readonly: true, fileMustExist: true })
  try {
    const tasks = numbers.map(value => {
      const row = database.prepare('SELECT id, status, kind, plan_json, results_json, revert_results_json FROM tasks WHERE id = ?').get(Number(value))
      assert.ok(row && [row.plan_json, row.results_json, row.revert_results_json].every(value => !value || value.length <= 2 * 1024 * 1024), 'task evidence is missing or exceeds the inspection limit')
      const events = database.prepare('SELECT id, command_id AS commandId, attempt_id AS attemptId, revision, type, metadata_json FROM execution_events WHERE task_id = ? ORDER BY id LIMIT 1001').all(row.id)
      assert.ok(events.length <= 1000, 'journal exceeds the inspection limit')
      const revisions = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plan_revisions'").get()
        ? database.prepare('SELECT approved, substr(plan_json, 1, 2097153) AS plan_json FROM plan_revisions WHERE task_id = ? AND approved = 1 ORDER BY id LIMIT 33').all(row.id)
        : []
      assert.ok(revisions.length <= 32 && revisions.reduce((size, revision) => size + revision.plan_json.length, 0) <= 2 * 1024 * 1024, 'revision evidence exceeds the inspection limit')
      return { id: row.id, status: row.status, kind: row.kind, plan: JSON.parse(row.plan_json), revisions: revisions.map(revision => ({ approved: revision.approved, plan: JSON.parse(revision.plan_json) })), results: JSON.parse(row.results_json ?? '[]'), revertResults: JSON.parse(row.revert_results_json ?? '[]'), events: events.map(event => ({ ...event, metadata: JSON.parse(event.metadata_json) })) }
    })
    const [baseline, first, repeat, afterFirstRevert, afterSecondRevert] = tasks
    console.log(JSON.stringify({ passed: true, host, ...assertCliLifecycleEvidence({ baseline, first, repeat, afterFirstRevert, afterSecondRevert }) }))
  } finally { database.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
