import assert from 'node:assert/strict'
import test from 'node:test'
import { collectComposeEvidence } from '../src/container-execution-evidence.js'
import { validateDiagnostic, buildSafeDiagnosticCommand } from '../src/deployment-phases.js'
import { buildCommonTask } from '../src/common-tasks.js'

const diagnostic = { kind: 'compose', target: 'C:/ProgramData/WebminAI/Services/wordpress' }
const id = 'a'.repeat(64)
const startedAt = '2026-10-26T19:00:00.000Z'
const record = { Id: id, State: { OOMKilled: true, ExitCode: 137, FinishedAt: '2026-10-26T19:01:00.000Z' }, Env: ['PASSWORD=private-fixture'] }

test('Windows Compose diagnostics accept only canonical managed paths', () => {
  assert.doesNotThrow(() => validateDiagnostic(diagnostic))
  for (const target of ['C:/Windows', 'D:/ProgramData/WebminAI/Services/app', 'C:/ProgramData/WebminAI/Services/../app', "C:/ProgramData/WebminAI/Services/app';id"]) assert.throws(() => validateDiagnostic({ ...diagnostic, target }))
  assert.throws(() => validateDiagnostic({ kind: 'filesystem', target: diagnostic.target }))
  const command = buildSafeDiagnosticCommand(diagnostic)
  assert.match(command, /Start-Process/u)
  assert.match(command, /WaitForExit\(3000\)/u)
  assert.match(command, /label=com\.docker\.compose\.project\.working_dir=C:\\ProgramData/u)
  assert.doesNotMatch(command, /set -eu|Config\.Env|compose config/u)
})

test('Windows Docker evidence uses scoped native reads and discloses only observations', async () => {
  const calls = []
  const client = { async runCommand (command, options) { calls.push(command); assert.equal(options.timeoutSeconds, 5); return { exitCode: 0, stdout: calls.length === 1 ? id : JSON.stringify(record) } } }
  const result = await collectComposeEvidence(client, diagnostic, startedAt, { platform: 'windows' })
  assert.equal(calls.length, 2)
  assert.match(calls[0], /--filter 'label=com\.docker\.compose\.project\.working_dir=C:\\ProgramData\\WebminAI\\Services\\wordpress'/u)
  assert.match(calls[1], new RegExp(id, 'u'))
  assert.doesNotMatch(calls.join('\n'), /Config\.Env|set -eu/u)
  assert.ok(result.some(value => value.code === 'WORKLOAD_OOM_KILLED'))
  assert.doesNotMatch(JSON.stringify(result), /private-fixture|PASSWORD/u)
})

test('Windows Docker evidence rejects unavailable, oversized and substituted identities', async () => {
  for (const [listing, inspected] of [
    ['', record], ['not-an-id', record], [`${id}\n${id}`, record], [id.repeat(20), record],
    [id, { ...record, Id: 'b'.repeat(64) }], [id, [record, record]], [id, 'x'.repeat(17000)]
  ]) {
    let calls = 0
    const result = await collectComposeEvidence({ async runCommand () { return { exitCode: 0, stdout: ++calls === 1 ? listing : Array.isArray(inspected) ? inspected.map(row => JSON.stringify(row)).join('\n') : typeof inspected === 'string' ? inspected : JSON.stringify(inspected) } } }, diagnostic, startedAt, { platform: 'windows' })
    assert.equal(result[0].code, 'EVIDENCE_UNAVAILABLE')
  }
  let calls = 0
  const mismatched = await collectComposeEvidence({ async runCommand () { calls++; throw new Error('No dispatch allowed') } }, { kind: 'compose', target: '/opt/app' }, startedAt, { platform: 'windows' })
  assert.equal(calls, 0)
  assert.equal(mismatched[0].code, 'EVIDENCE_UNAVAILABLE')
})

test('every Windows Docker application annotates its relevant execution phases', () => {
  const execution = { platform: 'windows', docker: { serverOs: 'linux', serverVersion: '28' } }
  for (const app of ['wordpress', 'woocommerce', 'joomla', 'drupal', 'prestashop', 'moodle', 'magento', 'n8n', 'ghost', 'mattermost', 'odoo', 'jellyfin', 'home-assistant']) {
    const built = buildCommonTask(`${app}-windows`, 901, { platform: 'windows', windowsExecution: execution, docker: { ready: true, preferred: true } })
    const phases = built.plan.commands.filter(command => ['services', 'initialize', 'verify'].includes(command.phase))
    assert.ok(phases.length)
    for (const command of phases.filter(item => item.id !== 'audit-software-security')) assert.deepEqual(command.diagnostic, { kind: 'compose', target: `C:/ProgramData/WebminAI/Services/${app}` })
  }
})
