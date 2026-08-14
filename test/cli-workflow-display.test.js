import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  renderMultiHostEvent,
  renderMultiHostRun,
  renderPlan,
  renderResults,
  renderTaskRecord,
  reviewMultiHostPlans
} from '../src/cli.js'
import {
  catalogChoiceRows,
  cleanupHostIds,
  failedMultiHostIds,
  multiHostHistoryActions,
  multiHostHistoryRows,
  retryCleanupSucceeded,
  routingSummaryRows,
  taskHistoryActions,
  taskHistoryRows
} from '../src/cli-workflow-display.js'
import { TerminalUi } from '../src/terminal-ui.js'

test('verified application choices search label, description, and catalog id', () => {
  const [row] = catalogChoiceRows([{ id: 'wordpress', label: 'WordPress', description: 'Install a PHP publishing site' }])
  assert.match(row.searchText, /WordPress.*PHP publishing.*wordpress/)
  assert.equal(row.value.id, 'wordpress')
})

test('task history search and actions preserve task semantics without unrelated global metadata', () => {
  const task = {
    id: 44,
    status: 'failed',
    kind: 'ai',
    catalogId: null,
    retryOfTaskId: 41,
    groupRunId: 9,
    request: 'Install WordPress',
    plan: { revertCommands: [{ id: 'revert' }] }
  }
  const [row] = taskHistoryRows([task])
  assert.match(row.searchText, /44.*failed.*ai.*Install WordPress.*41.*9/)
  assert.doesNotMatch(row.searchText, /administrator@example/)
  assert.deepEqual(taskHistoryActions(task).map(action => action.value), ['retry', 'retry-extra', 'reuse', 'revert', 'back'])
  assert.deepEqual(taskHistoryActions({ ...task, kind: 'consultation', plan: null }).map(action => action.value), ['reuse', 'back'])
  assert.deepEqual(taskHistoryActions({ ...task, kind: 'catalog' }, { catalogTask: true }).map(action => action.value), ['reuse', 'revert', 'back'])
  assert.deepEqual(taskHistoryActions({ ...task, status: 'reverted' }).map(action => action.value), ['retry', 'retry-extra', 'reuse', 'back'])
})

test('multi-host history searches run metadata and host ids but not application defaults or output', () => {
  const [row] = multiHostHistoryRows([{
    id: 18,
    status: 'partial',
    request: 'Update nginx',
    catalogId: null,
    retryOfRunId: 12,
    hosts: [{ serverId: 'production' }, { serverId: 'staging', error: 'administrator@example.test stdout secret' }]
  }])
  assert.match(row.searchText, /18.*partial.*Update nginx.*12.*production.*staging/)
  assert.doesNotMatch(row.searchText, /administrator@example|stdout secret/)
})

test('multi-host history actions and clean-retry selection preserve failure semantics', () => {
  const run = {
    kind: 'ai',
    hosts: [
      { serverId: 'alpha', taskId: 1, status: 'completed' },
      { serverId: 'beta', taskId: 2, status: 'failed' },
      { serverId: 'gamma', taskId: 3, status: 'reverted' },
      { serverId: 'delta', taskId: 4, status: 'revert_failed' }
    ]
  }
  assert.deepEqual(multiHostHistoryActions(run).map(action => action.value), ['retry-failed', 'retry-selected', 'retry-extra', 'revert', 'back'])
  assert.deepEqual(failedMultiHostIds(run), ['beta', 'delta'])
  assert.deepEqual(cleanupHostIds(run, ['alpha', 'beta', 'gamma']), ['alpha', 'beta'])
  assert.equal(retryCleanupSucceeded({ hosts: [{ serverId: 'beta', status: 'reverted' }] }, ['beta']), true)
  assert.equal(retryCleanupSucceeded({ hosts: [{ serverId: 'beta', status: 'revert_failed' }] }, ['beta']), false)
})

test('routing summary preserves verified, informed, and ordinary decisions', () => {
  const rows = routingSummaryRows(['alpha', 'beta', 'gamma'], {
    alpha: { routing: { decision: 'verified_task', catalogId: 'wordpress', relevantCatalogIds: ['wordpress'], rationale: 'Exact match' } },
    beta: { routing: { decision: 'informed_planning', catalogId: null, relevantCatalogIds: ['wordpress', 'nginx-static-site'], rationale: 'Reuse knowledge' } }
  })
  assert.deepEqual(rows.map(row => row.decision), ['verified task', 'informed planning', 'ordinary planning'])
  assert.deepEqual(rows.map(row => row.context), ['wordpress', 'wordpress, nginx-static-site', '-'])
})

test('plan rendering shows every complete apply and revert command without ANSI color', () => {
  const { ui, output } = plainUi()
  renderPlan(ui, plan())
  for (const value of ['apply-one', 'apply-two', 'revert-one', 'printf \'alpha\' | tee /tmp/one', 'VALUE="$HOME" sh -c \'two\'', 'rm -f /tmp/one']) {
    assert.match(output.text, new RegExp(escapeRegex(value)))
  }
  assert.match(output.text, /Saved revert plan \(not executed now\)/)
  assert.match(output.text, /WARNING: Review this warning/)
  assert.equal(hasSgr(output.text), false)
})

test('result rendering keeps complete stdout and stderr in separate labelled sections', () => {
  const { ui, output } = plainUi()
  const stdout = `first line\n${'x'.repeat(5000)}\nlast line\n`
  const stderr = 'warning stream\n'
  renderResults(ui, [{ id: 'apply-one', status: 'completed', result: { stdout, stderr } }])
  assert.match(output.text, /stdout\n------\nfirst line/)
  assert.match(output.text, /last line/)
  assert.match(output.text, /stderr\n------\nwarning stream/)
  assert.equal(output.text.includes('x'.repeat(5000)), true)
})

test('task record rendering retains consultation, retry, progress, result, and revert fields', () => {
  const { ui, output } = plainUi()
  renderTaskRecord(ui, {
    id: 23,
    status: 'partial',
    kind: 'ai',
    catalogId: 'wordpress',
    groupRunId: 8,
    retryOfTaskId: 20,
    retryInstructions: 'Use the corrected package name',
    consultationIds: [19],
    request: 'Install WordPress',
    consultationAnswer: 'Use nginx.',
    consultationSummary: 'Prefer nginx.',
    consumedByTaskId: 24,
    changeOverview: 'Install the application',
    modifiedFiles: ['/srv/wordpress/compose.yaml'],
    progress: [{ type: 'reasoning', message: 'Inspecting inventory' }],
    results: [{ id: 'apply', status: 'completed', result: { stdout: 'applied', stderr: '' } }],
    revertResults: [{ id: 'revert', status: 'failed', result: { stdout: '', stderr: 'revert failed' } }],
    error: 'apply warning',
    revertError: 'rollback warning'
  })
  for (const value of [
    'Status', 'Kind', 'Common task', 'Multi-host run', 'Retry of task', 'Retry correction',
    'Consultation context', 'Request', 'Consultation answer', 'Saved compact context',
    'Used by task', 'Overview', 'Modified files and paths', 'Codex progress',
    'Execution results', 'Revert results', 'apply warning', 'rollback warning'
  ]) assert.match(output.text, new RegExp(escapeRegex(value)))
})

test('task record renders a saved host health report and reusable diagnostic context', () => {
  const { ui, output } = plainUi()
  renderTaskRecord(ui, {
    id: 88,
    status: 'completed',
    kind: 'catalog',
    catalogId: 'host-health-linux',
    groupRunId: null,
    retryOfTaskId: null,
    retryInstructions: null,
    consultationIds: [],
    request: 'Collect a concise host health report',
    consultationAnswer: null,
    consultationSummary: null,
    consumedByTaskId: null,
    changeOverview: 'Collected read-only evidence.',
    modifiedFiles: [],
    progress: [{ type: 'health_report', message: 'Overall health is good.', contextSummary: 'Use journald and apt on this host.' }],
    results: null,
    revertResults: null,
    error: null,
    revertError: null
  })
  assert.match(output.text, /Host health report/u)
  assert.match(output.text, /Overall health is good/u)
  assert.match(output.text, /Reusable diagnostic context/u)
})

test('multi-host review displays all plans before conservative confirmation', async () => {
  const { ui, output } = plainUi()
  const confirmations = []
  ui.confirm = async (prompt, defaultValue) => {
    confirmations.push({ prompt, defaultValue })
    return false
  }
  const accepted = await reviewMultiHostPlans(ui, { id: 7 }, [
    { serverId: 'alpha', taskId: 1, plan: plan() },
    { serverId: 'beta', taskId: 2, plan: plan() }
  ], 'Execute')
  assert.equal(accepted, false)
  assert.equal((output.text.match(/printf 'alpha' \| tee \/tmp\/one/gu) ?? []).length, 2)
  assert.match(output.text, /alpha \/ task #1/)
  assert.match(output.text, /beta \/ task #2/)
  assert.deepEqual(confirmations, [{ prompt: 'Execute all 4 displayed commands across 2 hosts?', defaultValue: false }])
})

test('multi-host events label stdout and stderr and run summaries retain host errors', () => {
  const { ui, output } = plainUi()
  renderMultiHostEvent(ui, {
    serverId: 'production',
    message: 'apply-one: failed',
    result: { result: { stdout: 'normal output', stderr: 'failure output' } }
  })
  renderMultiHostRun(ui, {
    id: 18,
    status: 'partial',
    request: 'Update nginx',
    kind: 'ai',
    catalogId: null,
    retryOfRunId: null,
    hosts: [{ serverId: 'production', status: 'failed', taskId: 44, verification: null, error: 'HTTP validation failed' }]
  })
  assert.match(output.text, /\[production\]\[stdout\] normal output/)
  assert.match(output.text, /\[production\]\[stderr\] failure output/)
  assert.match(output.text, /ERROR: \[production\] HTTP validation failed/)
})

test('Phase 2 remains a plain TerminalUi ESM interface without palette or alternate screen', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
  assert.equal(dependencies.react, undefined)
  assert.equal(dependencies.ink, undefined)
  const source = await readFile(new URL('../src/terminal-ui.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /command palette|ctrl\+k|\?1049[hl]/i)
  const sourceFiles = await readdir(new URL('../src/', import.meta.url))
  assert.equal(sourceFiles.some(file => /\.jsx$/iu.test(file)), false)
})

function plan () {
  return {
    summary: 'Install service',
    changeOverview: 'Create a reviewed service installation',
    requiresConfirmation: true,
    modifiedFiles: ['/tmp/one'],
    warnings: ['Review this warning'],
    commands: [
      { id: 'apply-one', purpose: 'Apply first phase', risk: 'change', timeoutMs: 30000, requiresSudo: true, command: "printf 'alpha' | tee /tmp/one" },
      { id: 'apply-two', purpose: 'Apply second phase', risk: 'read', timeoutMs: 30000, requiresSudo: false, command: 'VALUE="$HOME" sh -c \'two\'' }
    ],
    revertCommands: [
      { id: 'revert-one', purpose: 'Remove first phase', risk: 'change', timeoutMs: 30000, requiresSudo: true, command: 'rm -f /tmp/one' }
    ]
  }
}

function plainUi () {
  const output = {
    isTTY: false,
    columns: 120,
    rows: 30,
    text: '',
    write (value) { this.text += value }
  }
  const input = { isTTY: false, isPaused: () => true, pause () {} }
  return { ui: new TerminalUi({ input, output }), output }
}

function escapeRegex (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function hasSgr (value) {
  return new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'u').test(value)
}
