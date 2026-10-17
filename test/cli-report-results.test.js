import assert from 'node:assert/strict'
import test from 'node:test'
import { completedReportResults, renderMultiHostReports } from '../src/cli.js'
import { TerminalUi } from '../src/terminal-ui.js'

test('reports use persisted results after operator resume in approved command order', () => {
  const first = { id: 'first', status: 'completed', result: { stdout: 'first evidence' } }
  const second = { id: 'second', status: 'completed', result: { stdout: 'resumed evidence' } }
  const task = { status: 'completed', plan: { commands: [{ id: 'first' }, { id: 'second' }] }, results: [second, first] }
  assert.deepEqual(completedReportResults(task), [first, second])
  assert.equal(completedReportResults({ ...task, status: 'partial' }), null)
  assert.equal(completedReportResults({ ...task, results: [first] }), null)
  assert.equal(completedReportResults({ ...task, results: [first, { ...second, status: 'uncertain' }] }), null)
  assert.equal(completedReportResults({ ...task, results: [] }), null)
  assert.equal(completedReportResults({ ...task, plan: { commands: [] } }), null)
  assert.equal(completedReportResults({ ...task, plan: undefined }), null)
})

test('multi-host assessments use completed evidence, persist reports and isolate report failures', async () => {
  for (const catalogId of ['host-health-linux', 'system-update-linux']) {
    let output = ''
    const ui = new TerminalUi({ output: { isTTY: false, write: text => { output += text } }, color: false })
    const progress = []
    const contexts = []
    const consulted = []
    const admin = {
      getTask: (_host, id) => ({ id, status: 'completed', plan: { commands: [{ id: 'collect-health-test' }] }, results: [{ id: 'collect-health-test', status: 'completed', result: { stdout: 'actual-evidence token=fixture-private' } }] }),
      refreshInventory: async () => ({ webminaiLinuxContext: { identity: { id: 'alpine' } } }),
      consult: async options => { consulted.push(options); return { answer: 'Assessment token=fixture-private', contextSummary: 'Summary password=fixture-password' } },
      appendTaskProgress: (...args) => progress.push(args),
      saveHealthContext: async (...args) => contexts.push(args),
      saveUpdateContext: async (...args) => contexts.push(args)
    }
    await renderMultiHostReports({
      ui,
      run: { catalogId, hosts: [{ serverId: 'failed-report', taskId: 1, status: 'completed' }, { serverId: 'healthy', taskId: 2, status: 'completed' }, { serverId: 'pending', taskId: 3, status: 'planned' }] },
      adminFor: async host => { if (host === 'failed-report') throw new Error('token=fixture-private'); assert.equal(host, 'healthy'); return admin },
      settings: {},
      passphrase: 'test'
    })
    assert.equal(consulted.length, 1)
    assert.match(JSON.stringify(consulted[0].inventory), /actual-evidence/)
    assert.equal(contexts.length, 1)
    assert.match(output, /Report unavailable; command outcomes remain recorded/)
    assert.doesNotMatch(JSON.stringify([output, progress, contexts, consulted[0].inventory]), /fixture-private|fixture-password/)
  }
})
