import assert from 'node:assert/strict'
import test from 'node:test'
import { execute, recoverIncomplete, requireCompleted, revert, stageInstallSource } from '../scripts/validate-linux-common-tasks.js'

const plan = { summary: 'Common fixture', changeOverview: 'Test fixture', modifiedFiles: [], commands: [{ id: 'apply' }], revertCommands: [{ id: 'undo' }] }
const completed = id => ({ id, status: 'completed' })

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
