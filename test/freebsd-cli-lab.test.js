import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import path from 'node:path'

test('parallel lab failure skips repeat probes without blocking the completed host rollback path', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const probe = source.slice(source.indexOf('if (!stopScheduling) {'), source.indexOf('if (keepRuntime) {', source.indexOf('if (!stopScheduling) {')))
  assert.ok(probe.includes('finish this completed cycle'))
  for (const stopScheduling of [null, new Error('other host failed')]) {
    let calls = 0
    const events = []
    await runInNewContext('(async () => {' + probe + '})()', { stopScheduling, tasks: { allExecutionEvents: () => events }, hostId: 'fixture-host', id: 1, current: { stateVersion: 'v', fingerprint: 'f' }, definition: { id: 'fixture-task' }, operation: async () => { calls++; throw new Error('This plan already completed; its execution approval is consumed') }, record: async () => {}, assert })
    assert.equal(calls, stopScheduling ? 0 : 1)
  }
})

test('private build toolchain checks preserve the first observed shell profile baseline', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const probe = source.slice(source.indexOf('const profileFile ='), source.indexOf('const pathProbe =', source.indexOf('const profileFile =')))
  for (const [existing, commandId] of [[undefined, 'install-odoo-build-toolchain'], ['original profile', 'install-odoo-build-toolchain'], [undefined, 'install-odoo-build-toolchain-catalog-9927fb988e70']]) {
    const writes = []; let observations = 0
    const result = await runInNewContext('(async () => {' + probe + '; return profileBaseline })()', {
      directory: '/fixture',
      hostId: 'host',
      id: 1,
      path,
      current: { task: { plan: { commands: [{ id: commandId }] } } },
      catalogPathProbe: paths => paths.join(','),
      readFile: async () => { if (existing !== undefined) return existing; throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      writeFile: async (...args) => writes.push(args),
      inspect: async () => { observations++; return 'observed profile' }
    })
    assert.equal(result, existing ?? 'observed profile')
    assert.equal(observations, existing === undefined ? 1 : 0)
    assert.equal(writes.length, existing === undefined ? 1 : 0)
    if (writes.length) assert.equal(writes[0][2].flag, 'wx')
  }
})

const run = args => spawnSync(process.execPath, ['scripts/validate-freebsd-cli-lab.js', ...args], { encoding: 'utf8', env: { ...process.env, VAULT_TEST: 'fixture-only' }, timeout: 10000 })
test('FreeBSD live harness rejects missing authorization and invalid targets before connecting', () => {
  for (const [args, message] of [
    [[], /Explicit live-lab approval required/u],
    [['--approve-live-tests', '--verify-replay-guards', '--refresh-failed'], /cannot be mixed/u],
    [['--approve-live-tests', '--parallel-hosts', '--host=webminai-freebsd-14-4'], /independent host matrices/u],
    [['--approve-live-tests', '--parallel-hosts', '--refresh-failed'], /not scoped recovery/u],
    [['--approve-live-tests', '--host=production'], /assert/u],
    [['--approve-live-tests', '--task=arbitrary-command'], /assert/u],
    [['--approve-live-tests', '--update-stage2'], /Plugin updates must be separate/u],
    [['--approve-live-tests', '--refresh-failed'], /one explicit failed task/u],
    [['--approve-live-tests', '--resume-paused'], /one explicit task/u],
    [['--approve-live-tests', '--refresh-paused'], /one explicit task/u],
    [['--approve-live-tests', '--refresh-paused', '--host=webminai-freebsd-14-4', '--task=n8n-freebsd', '--refresh-failed'], /no other operation/u],
    [['--approve-live-tests', '--resume-paused', '--host=webminai-freebsd-14-4', '--task=wordpress-freebsd', '--refresh-failed'], /no other operation/u],
    [['--approve-live-tests', '--keep-runtime'], /explicit Podman task/u],
    [['--approve-live-tests', '--retest-reverted'], /limited to the inspected 14[.]4 Jellyfin/u],
    [['--approve-live-tests', '--retest-reverted', '--host=webminai-freebsd-15-1', '--task=n8n-freebsd'], /limited to the inspected 14[.]4/u],
    [['--approve-live-tests', '--repair-ghost-nginx'], /explicit paused 15[.]1 Ghost/u],
    [['--approve-live-tests', '--restore-ghost-security'], /explicit reverted 15[.]1 Ghost/u],
    [['--approve-live-tests', '--repair-ghost-nginx', '--host=webminai-freebsd-15-1', '--task=ghost-freebsd', '--resume-paused'], /no other operation/u],
    [['--approve-live-tests', '--restore-runtime'], /one explicit retained Podman task/u],
    [['--approve-live-tests', '--reconcile-only'], /one explicit saved task/u],
    [['--approve-live-tests', '--repair-network'], /explicit 14[.]4 Podman prerequisite/u],
    [['--approve-live-tests', '--restore-network'], /explicit 14[.]4 Podman prerequisite/u],
    [['--approve-live-tests', '--include-maintenance-typo'], /Unknown lab option/u]
  ]) {
    const result = run(args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    assert.doesNotMatch(result.stdout, /accepted|completed/u)
  }
})
