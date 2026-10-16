import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { completedValidationResults, execute, recoverIncomplete, requireCompleted, revert, stageInstallSource, validationBaseline } from '../scripts/validate-linux-common-tasks.js'

const plan = { summary: 'Common fixture', changeOverview: 'Test fixture', modifiedFiles: [], commands: [{ id: 'apply' }], revertCommands: [{ id: 'undo' }] }
const completed = id => ({ id, status: 'completed' })

test('invalid resume arguments stop before opening a vault or selecting real hosts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-validation-resume-'))
  try {
    for (const args of [['--resume-validation'], ['--resume-validation=1'], ['--resume-validation=1', '--host=webminai-debian-13', '--task=wordpress-linux'], ['--resume-validation=0', '--host=webminai-debian-13', '--task=n8n-linux']]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/validate-linux-common-tasks.js', import.meta.url)), ...args], { encoding: 'utf8', env: { ...process.env, VAULT_TEST: 'fixture', WEBMINAI_DATA_ROOT: root } })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /use --resume-validation=TASK_ID|resume-validation requires/u)
      assert.deepEqual(await readdir(root), [])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recovered n8n validation accepts only confirmed results and unchanged catalog scope', () => {
  const expected = { commands: [{ id: 'install', command: 'install-fixed-catalog' }], modifiedFiles: ['/fixture'] }
  const task = { catalogId: 'n8n-linux', status: 'completed', plan: structuredClone(expected), results: [completed('install')] }
  const state = [{ commandId: 'install', status: 'completed' }]
  assert.deepEqual(completedValidationResults(task, state, [], expected), task.results)
  assert.throws(() => completedValidationResults({ ...task, status: 'partial' }, state, [], expected), /operator-reviewed recovery/u)
  assert.throws(() => completedValidationResults(task, [{ ...state[0], status: 'uncertain' }], [], expected), /operator review/u)
  assert.throws(() => completedValidationResults(task, state, [{}], expected), /rollback already started/u)
  assert.throws(() => completedValidationResults({ ...task, results: [] }, state, [], expected), /results are missing/u)
  assert.throws(() => completedValidationResults(task, [{ commandId: 'old-attempt', status: 'completed' }], [], expected))
  assert.throws(() => completedValidationResults({ ...task, plan: { ...expected, modifiedFiles: ['/other'] } }, state, [], expected), /managed paths/u)
  assert.throws(() => completedValidationResults({ ...task, plan: { ...expected, commands: [{ id: 'install', command: 'changed' }] } }, state, [], expected), /catalog commands/u)
  const revised = { ...task, plan: { ...expected, commands: [{ ...expected.commands[0], id: 'reviewed-install' }] }, results: [completed('reviewed-install')] }
  assert.deepEqual(completedValidationResults(revised, [{ commandId: 'reviewed-install', status: 'completed' }], [], expected), revised.results)
})

test('validation baselines are private, immutable, bounded and reject changed or missing evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-validation-baseline-'))
  try {
    const plan = { commands: [{ id: 'install', command: 'printf PAYLOAD_NOT_IN_BASELINE' }], revertCommands: [], modifiedFiles: ['/fixture'] }
    const options = { serverId: 'webminai-debian-13', taskId: 1, plan }
    assert.equal(await validationBaseline(root, { ...options, baseline: 'n8n=absent\n' }), 'n8n=absent\n')
    assert.equal(await validationBaseline(root, options), 'n8n=absent\n')
    await assert.rejects(validationBaseline(root, { ...options, baseline: 'overwritten' }), { code: 'EEXIST' })
    await assert.rejects(validationBaseline(root, { ...options, taskId: 2 }), { code: 'ENOENT' })
    await assert.rejects(validationBaseline(root, { ...options, plan: { ...plan, commands: [] } }), /catalog commands changed/u)
    await assert.rejects(validationBaseline(root, { ...options, plan: { ...plan, modifiedFiles: ['/other'] } }), /managed paths changed/u)
    await assert.rejects(validationBaseline(root, { ...options, serverId: '../outside', baseline: '' }))
    await assert.rejects(validationBaseline(root, { ...options, taskId: 0, baseline: '' }))
    await assert.rejects(validationBaseline(root, { ...options, taskId: 2, baseline: 'x'.repeat(65537) }))
    const file = path.join(root, 'lab-validation-baselines/webminai-debian-13-1.json')
    assert.ok(!(await readFile(file, 'utf8')).includes('PAYLOAD_NOT_IN_BASELINE'))
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
    await writeFile(file, 'invalid KNOWN_SECRET')
    await assert.rejects(validationBaseline(root, options), error => error.message === 'saved validation baseline is invalid')
    await writeFile(file, 'x'.repeat(131073))
    await assert.rejects(validationBaseline(root, options), /size limit/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('installer validation stages the current checkout and rejects an unsafe remote temporary path', async () => {
  const copies = []
  const ssh = { execute: async () => ({ stdout: '/tmp/webminai.test123\n' }), copy: async (...args) => copies.push(args) }
  const source = await stageInstallSource(ssh, 'lab')
  assert.deepEqual(source, { installerPath: '/tmp/webminai.test123/install.sh', packageUrl: '/tmp/webminai.test123/intent-ai-ops.tgz' })
  assert.equal(copies.length, 2)
  assert.ok(copies[0][1].endsWith('/scripts/install.sh'))
  assert.ok(copies[1][1].endsWith('/dist/intent-ai-ops.tgz'))
  ssh.execute = async () => ({ stdout: '/tmp/../../etc\n' })
  await assert.rejects(stageInstallSource(ssh, 'lab'))
  assert.equal(copies.length, 2)
})

test('validator cannot silently clean up uncertain or incomplete changes', async () => {
  let state = 'uncertain'
  let verificationCalls = 0
  const admin = {
    listTasks: () => [{ id: 1, catalogId: 'nginx-static-site', request: 'Validate Linux common task: nginx', status: 'revert_failed' }],
    getTask: () => ({ id: 1, plan: { ...plan, modifiedFiles: ['/var/lib/webminai/task-state/1-nginx-static-site'] } }),
    tasks: { executionState: () => [{ status: state }] },
    netdata: () => ({ runCommand: async command => { verificationCalls++; assert.match(command, /test ! -e '\/var\/lib\/webminai\/task-state\/1-nginx-static-site'/); return { exitCode: 1 } } }),
    execute: () => assert.fail('recovery must not bypass journaled reviewed rollback'),
    saveTaskRevertResults: () => assert.fail('unclean fixture cannot be marked reverted')
  }
  await assert.rejects(recoverIncomplete(admin, {}, 'lab', 'nginx-static-site', {}), /uncertain outcome/)
  assert.equal(verificationCalls, 0)
  state = 'failed'
  await assert.rejects(recoverIncomplete(admin, {}, 'lab', 'nginx-static-site', {}), /separately reviewed rollback/)
  assert.equal(verificationCalls, 1)
})

test('Linux validator rejects paused or empty results instead of printing a false PASS', () => {
  assert.doesNotThrow(() => requireCompleted([completed('first'), completed('second')], 'apply', 2))
  assert.throws(() => requireCompleted([completed('first')], 'update', 2), /paused or stopped/u)
  assert.throws(() => requireCompleted([], 'update', 2), /paused or stopped/u)
  assert.throws(() => requireCompleted([{ id: 'first', status: 'failed', failure: { code: 'COMMAND_FAILED' } }], 'apply', 2), /first: COMMAND_FAILED/u)
})

test('second common-task apply uses a distinct journaled task without rewriting the first', async () => {
  const calls = []
  const admin = {
    getTask: () => ({ catalogId: 'system-user' }),
    createTask: () => ({ id: 2 }),
    saveTaskPlan: (...args) => calls.push(['plan', ...args]),
    markTaskRunning: (...args) => calls.push(['running', ...args]),
    saveTaskResults: (...args) => calls.push(['results', ...args]),
    execute: async options => { calls.push(['execute', options.taskId]); return [completed('apply')] }
  }
  await execute(admin, 'lab', 1, plan, 'apply 1')
  await execute(admin, 'lab', 1, plan, 'apply 2')
  assert.deepEqual(calls.filter(call => call[0] === 'execute'), [['execute', 1], ['execute', 2]])
  assert.deepEqual(calls.filter(call => call[0] === 'plan').map(call => call[2]), [2])
})

test('only the explicit second rollback receives a new reviewed rollback plan', async () => {
  const decisions = []
  const admin = { getTask: () => ({ plan }), revertTask: async options => { decisions.push(options); return [completed('undo')] } }
  await revert(admin, 'lab', 1, 'revert 1')
  await revert(admin, 'lab', 1, 'revert 2')
  assert.equal(decisions[0].reviewedPlan, undefined)
  assert.deepEqual(decisions[1].reviewedPlan.commands, plan.revertCommands)
  assert.equal(decisions[1].taskId, 1)
})
