import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import path from 'node:path'

test('installation checks isolate current history and require a scoped runtime or CLI task', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const guard = source.slice(source.indexOf('assert.ok(!installationChecks'), source.indexOf('\nconst flags ='))
  for (const selectedTask of ['podman-freebsd', 'intent-ai-ops-freebsd', 'odoo-freebsd']) {
    for (const podmanCandidates of [true, false]) {
      const run = () => runInNewContext(guard, { assert, installationChecks: true, absentRuntime: false, podmanCandidates, selectedHost: 'lab', selectedTask })
      if (!podmanCandidates && selectedTask !== 'odoo-freebsd') run()
      else assert.throws(run)
    }
  }
  assert.match(source, /installationChecks \? 'artifacts\/freebsd-installation'/u)
})

test('absent-runtime precondition applies before first preparation without blocking recorded recovery', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const guard = source.split('\n').find(line => line.includes('if (absentRuntime && !state.hosts'))
  assert.ok(guard)
  for (const recorded of [false, true]) {
    let calls = 0
    await runInNewContext('(async () => {' + guard + '})()', { assert, absentRuntime: true, host: 'lab', state: { hosts: recorded ? { lab: { tasks: { 'podman-freebsd': { id: 1 } } } } : {} }, inspect: async () => { calls++; return 'absent' } })
    assert.equal(calls, recorded ? 0 : 1)
  }
  await assert.rejects(runInNewContext('(async () => {' + guard + '})()', { assert, absentRuntime: true, host: 'lab', state: { hosts: {} }, inspect: async () => 'present' }))
})

test('a new candidate test requires reverted history and exact restored baselines', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const start = source.indexOf('if (retestReverted && podmanCandidates) {')
  const probe = source.slice(start, source.indexOf('if (retestReverted && !podmanCandidates)', start))
  for (const [status, restored] of [['reverted', true], ['failed-cleaned', true], ['reverted', false], ['partial', true], ['completed', true]]) {
    const hostState = { tasks: { fixture: { id: 25, status } } }
    const run = runInNewContext('(async () => { let prior = hostState.tasks.fixture; ' + probe + '; return prior })()', {
      retestReverted: true,
      podmanCandidates: true,
      hostState,
      definition: { id: 'fixture' },
      hostId: 'host',
      directory: '/fixture',
      path,
      assert,
      view: async () => ({ task: { status: 'reverted', plan: { modifiedFiles: [] } } }),
      inspect: async () => restored ? 'original' : 'changed',
      readFile: async () => 'original',
      catalogPathProbe: () => 'paths',
      packages: 'packages',
      accounts: 'accounts',
      record: async () => {}
    })
    if (['reverted', 'failed-cleaned'].includes(status) && restored) {
      assert.equal(await run, null)
      assert.equal(hostState.tasks.fixture, undefined)
      assert.equal(hostState.archivedTests[0].id, 25)
    } else {
      await assert.rejects(run)
      assert.equal(hostState.tasks.fixture.id, 25)
    }
  }
})

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
  for (const [existing, commandId, command = ''] of [[undefined, 'install-odoo-build-toolchain'], ['original profile', 'install-odoo-build-toolchain'], [undefined, 'install-odoo-build-toolchain-catalog-9927fb988e70'], [undefined, 'podman-install-home-assistant-build-toolch-catalog-9927fb988e70', 'export RUSTUP_HOME=/fixture/private']]) {
    const writes = []; let observations = 0
    const result = await runInNewContext('(async () => {' + probe + '; return profileBaseline })()', {
      directory: '/fixture',
      hostId: 'host',
      id: 1,
      path,
      current: { task: { plan: { commands: [{ id: commandId, command }] } } },
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

test('candidate pause is acknowledged only at a confirmed safe boundary, not on uncertain or failed work', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const start = source.indexOf("if (podmanCandidates && current.task.status === 'partial'")
  const probe = source.slice(start, source.indexOf("if (current.task.status !== 'completed')", start))
  assert.ok(probe.includes('safe-boundary pause confirmed'))
  for (const statuses of [['completed', 'pending'], ['uncertain', 'pending'], ['failed', 'pending'], ['completed', 'completed']]) {
    const events = []; const hostState = { tasks: { fixture: { status: 'partial' } } }
    const result = await runInNewContext('(async () => {' + probe + '; return "continue" })()', {
      podmanCandidates: true,
      current: { task: { status: 'partial' }, control: { action: 'pause' }, commands: statuses.map(status => ({ status })) },
      hostState,
      definition: { id: 'fixture' },
      hostId: 'fixture-host',
      record: async message => events.push(message)
    })
    const paused = statuses.join(',') === 'completed,pending'
    assert.equal(result === undefined, paused)
    assert.equal(hostState.tasks.fixture.status === 'paused', paused)
    assert.equal(events.length, paused ? 1 : 0)
  }
})

const run = args => spawnSync(process.execPath, ['scripts/validate-freebsd-cli-lab.js', ...args], { encoding: 'utf8', env: { ...process.env, VAULT_TEST: 'fixture-only' }, timeout: 10000 })
test('an outer timeout cannot authorize a competing acquisition while inner processes survive', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const start = source.indexOf('function assertIdlePodmanProcesses (')
  const check = runInNewContext('(' + source.slice(start, source.indexOf('function assertCheckpointTasks (', start)) + ')', { assert })
  const idle = '32905\n  PID  PPID COMMAND\n32905 32903 sh\n38232 32905 sleep\n38363 38361 ps\n'
  assert.doesNotThrow(() => check(idle))
  for (const name of ['pkg', 'sh', 'pip', 'rustc', 'composer']) assert.throws(() => check(idle + `33692 33621 ${name}\n`), /work remains active/u)
  assert.throws(() => check(idle.replace('32905 32903 sh', '32906 32903 sh')), /entrypoint changed/u)
  for (const output of ['', '32905\nmissing header', idle + 'malformed', idle + 'NaN 1 sh']) assert.throws(() => check(output), /evidence/u)
  const guard = source.indexOf('assertIdlePodmanProcesses(await inspect(')
  assert.ok(guard > source.indexOf('if (refreshRemaining) {'))
  assert.ok(guard < source.indexOf("const proposal = await operation(hostId, { action: 'refresh-catalog'", guard))
  const probeStart = source.indexOf('if (podmanCandidates && saved.commands.some(')
  const probe = source.slice(probeStart, source.indexOf('const proposal =', probeStart))
  for (const commandId of ['podman-install-magento-runtime', 'podman-install-home-assistant-applicatio-catalog-0123456789ab', 'prepare-podman-build-dependencies', 'verify-podman-build-linker', 'prepare-podman-source-libraries', 'verify-podman-system-libraries', 'verify-podman-openssl-development', 'clean-podman-build-cache', 'clean-podman-package-cache', 'podman-configure-magento-runtime', 'verify-podman-application-restart']) {
    let inspected = false
    const run = runInNewContext('(async () => {' + probe + '})()', { podmanCandidates: true, saved: { commands: [{ status: 'failed', commandId }] }, definition: { id: 'magento-freebsd' }, prior: { id: 25 }, hostId: 'fixture', assertIdlePodmanProcesses: check, inspect: async () => { inspected = true; return idle + '33692 33621 pkg\n' } })
    if (['podman-configure-magento-runtime', 'verify-podman-application-restart'].includes(commandId)) {
      await run
      assert.equal(inspected, false)
    } else await assert.rejects(run, /work remains active/u)
  }
})

test('vault recreation cannot turn old checkpoint task IDs into unrelated current history', async () => {
  const source = await readFile(new URL('../scripts/validate-freebsd-cli-lab.js', import.meta.url), 'utf8')
  const validate = runInNewContext('(' + source.slice(source.indexOf('function assertCheckpointTasks (')) + ')', { assert })
  const saved = { tasks: { 'odoo-freebsd': { id: 19 } } }
  const valid = { id: 19, kind: 'catalog', catalogId: 'odoo-freebsd', createdAt: 100 }
  assert.doesNotThrow(() => validate(saved, new Date(200000).toISOString(), () => valid))
  for (const task of [{ ...valid, kind: 'ai' }, { ...valid, catalogId: 'ghost-freebsd' }, { ...valid, createdAt: 300 }]) {
    assert.throws(() => validate(saved, new Date(200000).toISOString(), () => task), /different local task history/u)
  }
  assert.throws(() => validate(saved, undefined, () => valid), /observation time/u)
})

test('FreeBSD live harness rejects missing authorization and invalid targets before connecting', () => {
  for (const [args, message] of [
    [[], /Explicit live-lab approval required/u],
    [['--approve-live-tests', '--podman-candidates'], /one explicit supported host\/application/u],
    [['--approve-live-tests', '--podman-candidates', '--host=webminai-freebsd-15-1', '--task=wordpress-freebsd'], /one explicit supported host\/application/u],
    [['--approve-live-tests', '--retest-preflight'], /Preflight retest requires/u],
    [['--approve-live-tests', '--podman-candidates', '--host=webminai-freebsd-15-1', '--task=odoo-freebsd', '--retest-preflight', '--refresh-failed'], /Choose one candidate recovery/u],
    [['--approve-live-tests', '--podman-candidates', '--host=webminai-freebsd-15-1', '--task=odoo-freebsd', '--cleanup-confirmed-failure', '--retest-reverted'], /Choose one candidate recovery/u],
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
    [['--approve-live-tests', '--absent-runtime'], /isolated Podman installation workflow/u],
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
