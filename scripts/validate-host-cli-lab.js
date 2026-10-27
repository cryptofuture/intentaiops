import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
import { launchLabCli } from '../browser-checks/lab-cli.js'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { redactDiagnosticText } from '../src/error-details.js'
import { hostCliLabTarget } from './host-cli-lab-target.js'

assert.ok(process.argv.includes('--approve-live-tests'), 'Explicit disposable-host approval required')
const { platform, catalogId, hostId } = hostCliLabTarget(process.argv)
assert.ok(!process.argv.includes('--verify-repeat-apply') || (platform === 'windows' && catalogId === 'intent-ai-ops-windows'), 'Repeat CLI ownership check requires the Windows CLI catalog task')
const rollbackTask = process.argv.find(value => value.startsWith('--rollback-task='))?.slice(16)
assert.ok(!rollbackTask || /^[1-9][0-9]*$/u.test(rollbackTask), 'Invalid rollback task')
const proposalTask = process.argv.find(value => value.startsWith('--propose-task='))?.split('=')[1]
assert.ok(!proposalTask || (!rollbackTask && /^[1-9][0-9]*$/u.test(proposalTask)), 'Invalid proposal task')
const reviewedRollbackRevision = process.argv.find(value => value.startsWith('--reviewed-rollback-revision='))?.slice(29)
assert.ok(!reviewedRollbackRevision || (rollbackTask && /^[1-9][0-9]*$/u.test(reviewedRollbackRevision)), 'Invalid reviewed rollback revision')
const proposeOnly = process.argv.includes('--propose-only')
const refreshCatalog = process.argv.includes('--refresh-catalog')
const instructions = process.argv.find(value => value.startsWith('--instructions='))?.slice(15)
assert.ok(!refreshCatalog || (proposalTask && proposeOnly), 'Catalog refresh requires proposal-only mode and an existing task')
assert.ok(!proposeOnly || ((rollbackTask || proposalTask) && !reviewedRollbackRevision && (refreshCatalog || instructions?.trim())), 'Proposal requires a task and explicit instructions')
assert.ok(!proposalTask || proposeOnly, 'Proposal task requires proposal-only mode')
const preparedTask = process.argv.find(value => value.startsWith('--prepared-task='))?.slice(16)
assert.ok(!preparedTask || (!rollbackTask && /^[1-9][0-9]*$/u.test(preparedTask)), 'Invalid prepared task')
const continuedTask = process.argv.find(value => value.startsWith('--continue-task='))?.slice(16)
assert.ok(!continuedTask || (!rollbackTask && !preparedTask && /^[1-9][0-9]*$/u.test(continuedTask)), 'Invalid continuation task')
const reviewedRevision = process.argv.find(value => value.startsWith('--reviewed-revision='))?.split('=')[1]
assert.ok(!reviewedRevision || (continuedTask && !proposeOnly && /^[1-9][0-9]*$/u.test(reviewedRevision)), 'Reviewed revision requires an existing continuation task')
const pauseAfter = process.argv.find(value => value.startsWith('--pause-after='))?.split('=')[1]
assert.ok(!pauseAfter || (/^[A-Za-z0-9_.-]{1,96}$/u.test(pauseAfter) && process.argv.includes('--keep-applied')), 'Boundary pause requires a command ID and explicit retained state')
assert.ok(process.env.VAULT_TEST)
process.env.INTENT_WEB_DATA_ROOT ??= '/home/vscode/.intentaiops'
const checkpoint = new URL(`../docs/${platform}-lab-validation-status.md`, import.meta.url)
const record = async message => {
  const line = `${new Date().toISOString()} ${catalogId}: ${message}`
  await appendFile(checkpoint, `\n- ${line}\n`)
  console.log(line)
}
async function inspectBaseline (taskId, phase = 'baseline') {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT)
  const server = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: hostId })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(server.connectionUrl, { authentication: server.authentication, credential: server.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(server.connectionUrl), server.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: server.connectionUrl, actionKey: server.actionKey })
    const execution = await (platform === 'macos' ? client.macosExecutionInventory() : client.windowsExecutionInventory())
    const docker = platform === 'macos' ? { ready: true } : { ...execution.docker, ready: execution.docker.daemonReachable && execution.docker.composeAvailable && execution.docker.serverOs === 'linux' }
    const built = buildCommonTask(catalogId, taskId, { platform, inventory: { webminaiExecution: execution }, [`${platform}Execution`]: execution, docker })
    if (platform === 'windows' && catalogId === 'intent-ai-ops-windows') {
      const tasks = new TaskStore(process.env.INTENT_WEB_DATA_ROOT, { directoryAliases: new Map([[hostId, server.historyId ?? hostId]]) })
      const originalPlan = tasks.get(hostId, taskId).plan
      if (originalPlan.modifiedFiles.includes('C:\\ProgramData\\IntentAIOps')) {
        const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-intent-ai-ops-install`
        built.stateProbe = `if(Test-Path -LiteralPath '${state}\\installed'){Write-Output 'intent-ai-ops=task-owned'}elseif(Get-Command intentaiops.cmd -ErrorAction SilentlyContinue){Write-Output 'intent-ai-ops=preexisting'}else{Write-Output 'intent-ai-ops=absent'}`
      } else if (!originalPlan.commands[0].command.includes('DoNotExpandEnvironmentNames')) {
        const start = built.stateProbe.indexOf('function PathDigest')
        const end = built.stateProbe.indexOf(';$cliState=')
        assert.ok(start >= 0 && end > start)
        built.stateProbe = built.stateProbe.slice(0, start) + "function PathDigest($scope){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string][Environment]::GetEnvironmentVariable('Path',$scope))))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}" + built.stateProbe.slice(end)
      }
    }
    if (phase === 'applied' && built.verifyApplied) assert.equal((await client.runCommand(built.verifyApplied, { timeoutSeconds: 30 })).exitCode, 0, 'Independent applied-state verification failed')
    if (phase === 'applied') {
      const item = built.plan.commands.find(command => command.diagnostic?.kind === 'compose')
      if (item) {
        const evidence = await client.collectExecutionEvidence({ item, before: { platform, observedAt: new Date(Date.now() - 60000).toISOString() } })
        assert.ok(Array.isArray(evidence.workloadDiagnostics), 'Container diagnostics were not collected')
        assert.ok(!evidence.workloadDiagnostics.some(value => value.code === 'EVIDENCE_UNAVAILABLE'), 'Container diagnostic inspection failed')
        await record(`task ${taskId} live container diagnostic inspection passed, observations=${evidence.workloadDiagnostics.length}`)
      }
    }
    if (phase === 'reverted' && built.verifyReverted) assert.equal((await client.runCommand(built.verifyReverted, { timeoutSeconds: 30 })).exitCode, 0, 'Independent rollback verification failed')
    if (!built.stateProbe) return null
    const result = await client.runCommand(built.stateProbe, { timeoutSeconds: 30 })
    assert.equal(result.exitCode, 0, 'Trusted baseline collector failed')
    assert.equal(result.stdoutTruncated, false)
    return createHash('sha256').update(result.stdout).digest('hex')
  } finally { await lease.close(); await ssh.closeSessions() }
}
async function openTaskView (page, taskId) {
  await page.getByRole('textbox', { name: 'Search hosts' }).fill(hostId)
  const recent = page.locator('.tree-task').filter({ hasText: new RegExp(`^#${taskId} `, 'u') })
  if (await recent.count()) await recent.click()
  else {
    await page.locator('.host-name').filter({ hasText: new RegExp(`^${hostId}$`, 'u') }).click()
    await page.locator('main.page .tabs').getByRole('button', { name: 'tasks', exact: true }).click()
    await page.locator('main.page tbody tr').filter({ has: page.getByRole('cell', { name: `#${taskId}`, exact: true }) }).getByRole('button', { name: 'Inspect', exact: true }).click()
  }
}
let cli; let browser; let taskId; let reloadedJob; let intentionalPause = false
try {
  cli = await launchLabCli({ actions: true })
  browser = await chromium.launch({ headless: true, executablePath: process.env.INTENT_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto(cli.url)
  await page.getByRole('heading', { name: 'Your infrastructure' }).waitFor()
  const api = (route, body) => page.evaluate(async ({ route, body }) => {
    const session = await (await fetch('session')).json()
    const response = await fetch(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }, body: JSON.stringify(body) } : {})
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }, { route, body })
  const operation = async body => {
    const request = { ...body, requestKey: crypto.randomUUID() }
    const accepted = await api('operation', request)
    const duplicate = await api('operation', request)
    assert.equal(duplicate.id, accepted.id, 'Double submission created a second operation')
    if (body.action === 'execute' && !body.commandIds && !reloadedJob && process.argv.includes('--reload-inflight')) {
      for (let attempt = 0; attempt < 7200; attempt++) {
        const status = await api(`operation?id=${accepted.id}`)
        if (status.status !== 'running') throw new Error(status.error ?? 'Execution ended before an active job could be observed for browser reload')
        const current = await api(`task?host=${hostId}&task=${taskId}`)
        reloadedJob = current.commands.find(command => current.task.plan.commands.find(item => item.id === command.commandId)?.executionMode === 'job' && command.status === 'uncertain' && command.jobId)
        if (reloadedJob) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      assert.ok(reloadedJob, 'No active durable job observed before browser reload')
      await page.reload()
      await page.getByRole('heading', { name: 'Your infrastructure' }).waitFor()
      await openTaskView(page, taskId)
      await record(`task ${taskId} reloaded browser during job ${reloadedJob.jobId}; observing original operation ${accepted.id}`)
    }
    for (let attempt = 0; attempt < 7200; attempt++) {
      const current = await api(`operation?id=${accepted.id}`)
      if (current?.status === 'running' && body.action === 'execute' && pauseAfter && !intentionalPause) {
        const view = await api(`task?host=${hostId}&task=${taskId}`)
        if (view.commands.some(command => command.commandId === pauseAfter && command.status === 'completed')) {
          try {
            await operation({ action: 'pause', hostId, taskId, expectedVersion: view.stateVersion })
            intentionalPause = true
            await record(`task ${taskId} requested a safe boundary pause after ${pauseAfter}; no running command was terminated`)
          } catch (error) { if (!/stale/iu.test(error.message)) throw error }
        }
      }
      if (current && current.status !== 'running') {
        assert.equal(current.status, 'completed', current.error ?? 'Operation failed; inspect saved task history')
        return current.result
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Observation deadline reached; inspect history, do not replay')
  }
  if (proposeOnly) {
    taskId = Number(rollbackTask ?? proposalTask)
    const view = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(view.task.catalogId, catalogId)
    assert.ok(view.commands.every(command => command.status !== 'uncertain'), 'Reconcile uncertain work before proposing rollback')
    const proposal = await operation({ action: refreshCatalog ? 'refresh-catalog' : 'propose', hostId, taskId, expectedVersion: view.stateVersion, ...(!refreshCatalog ? { rollback: Boolean(rollbackTask), instructions } : {}) })
    await record(`task ${taskId} ${rollbackTask ? 'rollback' : 'remaining-work'} revision ${proposal.revisionId} proposed only; no approval or execution`)
    if (proposal.proposed) console.log(redactDiagnosticText(JSON.stringify(proposal.proposed, null, 2)))
  } else if (rollbackTask) {
    taskId = Number(rollbackTask)
    let view = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(view.task.catalogId, catalogId)
    assert.ok(view.rollbackAvailable)
    let revision
    if (reviewedRollbackRevision) {
      revision = view.revisions.find(item => item.id === Number(reviewedRollbackRevision))
      assert.ok(revision?.plan.operatorRollback, 'Reviewed rollback proposal missing')
      if (!revision.approved) {
        await operation({ action: 'approve', hostId, taskId, revisionId: revision.id, expectedVersion: view.stateVersion, fingerprint: revision.fingerprint, approved: true })
        view = await api(`task?host=${hostId}&task=${taskId}`)
      }
    }
    await operation({ action: 'rollback', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: revision?.fingerprint ?? view.rollbackFingerprint, ...(revision ? { revisionId: revision.id } : {}), approved: true })
    const result = await api(`task?host=${hostId}&task=${taskId}`)
    const currentRollback = revision ? result.rollbackCommands.filter(command => command.rollbackRevision === revision.fingerprint) : result.rollbackCommands
    assert.ok(currentRollback.length && currentRollback.every(command => command.status === 'completed'))
    await record(`task ${taskId} separately reviewed rollback completed`)
    const original = (await readFile(checkpoint, 'utf8')).match(new RegExp(`${catalogId}: task ${taskId} baselineSHA256=([a-f0-9]{64})`, 'u'))?.[1]
    const restored = await inspectBaseline(taskId, 'reverted')
    if (original) assert.equal(restored, original, 'Reviewed rollback did not restore its original trusted-probe baseline')
    await record(`task ${taskId} independent rollback verification passed${original ? ' and original trusted-probe baseline matched' : '; original digest unavailable'}`)
  } else {
    if (preparedTask || continuedTask) taskId = Number(preparedTask ?? continuedTask)
    else {
      const prepared = await operation({ action: 'prepare', hostId, catalogId, request: `Validate ${platform} common task: ${catalogId}` })
      taskId = prepared.results[0].taskId
    }
    await record(continuedTask ? `inspecting interrupted task ${taskId}, no replay authorized` : `prepared task ${taskId}, no execution approval yet`)
    let view = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(view.task.catalogId, catalogId)
    if (reviewedRevision) {
      const revision = view.revisions.find(item => item.id === Number(reviewedRevision))
      assert.ok(revision && !revision.plan.operatorRollback, 'Reviewed remaining-work proposal missing')
      if (!revision.approved) await operation({ action: 'approve', hostId, taskId, revisionId: revision.id, expectedVersion: view.stateVersion, fingerprint: revision.fingerprint, approved: true })
      view = await api(`task?host=${hostId}&task=${taskId}`)
      await record(`task ${taskId} separately approved remaining-work revision ${revision.id}`)
    }
    const confirmed = view.commands.filter(command => command.status === 'completed')
    const recordedJobs = view.commands.filter(command => command.jobId)
    if (continuedTask) {
      for (let attempt = 0; view.commands.some(command => command.status === 'uncertain') && attempt < 120; attempt++) {
        assert.ok(view.commands.filter(command => command.status === 'uncertain').every(command => command.jobId), 'Missing durable job evidence; operator investigation required')
        await operation({ action: 'reconcile', hostId, taskId, expectedVersion: view.stateVersion })
        view = await api(`task?host=${hostId}&task=${taskId}`)
        if (view.commands.some(command => command.status === 'uncertain')) await new Promise(resolve => setTimeout(resolve, 15000))
      }
      assert.ok(view.commands.every(command => ['completed', 'pending'].includes(command.status)), 'Outcome remains uncertain or failed; no automatic replay authorized')
      await record(`task ${taskId} reconciled durable results; separately approving only remaining pending commands`)
    } else assert.ok(view.commands.every(command => command.status === 'pending'))
    await page.reload()
    await page.getByRole('heading', { name: 'Your infrastructure' }).waitFor()
    const reloaded = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(reloaded.fingerprint, view.fingerprint)
    let baseline
    if (continuedTask) baseline = (await readFile(checkpoint, 'utf8')).match(new RegExp(`${catalogId}: task ${taskId} baselineSHA256=([a-f0-9]{64})`, 'u'))?.[1]
    else {
      baseline = await inspectBaseline(taskId)
      if (baseline) await record(`task ${taskId} baselineSHA256=${baseline}`)
    }
    let firstAttempt
    const screenshots = new URL(`../artifacts/browser-screenshots/${platform}-lab/`, import.meta.url)
    await mkdir(screenshots, { recursive: true })
    await openTaskView(page, taskId)
    const pane = page.locator('.task-pane').filter({ has: page.locator('header strong').filter({ hasText: new RegExp(`^#${taskId}$`, 'u') }) })
    await pane.locator('h2').waitFor()
    await page.screenshot({ path: new URL(`${taskId}-${catalogId}-review.png`, screenshots).pathname, fullPage: true, maskColor: '#808080', mask: [page.locator('pre'), page.locator('code')] })
    if (process.argv.includes('--verify-controls') && !continuedTask) {
      await assert.rejects(operation({ action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: '0'.repeat(64), approved: true }))
      assert.deepEqual((await api(`task?host=${hostId}&task=${taskId}`)).commands, reloaded.commands)
    }
    if (process.argv.includes('--verify-controls') && !continuedTask && view.commands.length > 1) {
      await operation({ action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true, commandIds: [view.commands[0].commandId] })
      view = await api(`task?host=${hostId}&task=${taskId}`)
      assert.equal(view.commands[0].status, 'completed')
      firstAttempt = view.commands[0].attemptId
      assert.ok(view.commands.slice(1).every(command => command.status === 'pending'))
      const paused = await operation({ action: 'pause', hostId, taskId, expectedVersion: view.stateVersion })
      assert.ok(paused)
      const oldVersion = view.stateVersion
      view = await api(`task?host=${hostId}&task=${taskId}`)
      await assert.rejects(operation({ action: 'resume', hostId, taskId, expectedVersion: oldVersion, fingerprint: view.fingerprint, approved: true }))
      await record(`task ${taskId} rejected wrong fingerprint and stale continuation; per-command review and boundary pause passed`)
    }
    let pausedCommand
    if (view.commands.some(command => command.status === 'pending')) {
      const decision = { action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true }
      if (process.argv.includes('--pause-inflight')) {
        let failure
        const executing = operation(decision).catch(error => { failure = error })
        for (let attempt = 0; attempt < 120; attempt++) {
          view = await api(`task?host=${hostId}&task=${taskId}`)
          pausedCommand = view.commands.find(command => ['pull-images', 'acquire-images'].includes(command.commandId) && command.status === 'uncertain' && command.jobId)
          if (pausedCommand || failure) break
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        if (failure) throw failure
        assert.ok(pausedCommand, 'Could not observe a durable acquisition job in flight')
        await operation({ action: 'pause', hostId, taskId, expectedVersion: view.stateVersion })
        await record(`task ${taskId} pause requested while ${pausedCommand.commandId} was running; existing job ${pausedCommand.jobId} must finish normally`)
        await executing
        if (failure) throw failure
        view = await api(`task?host=${hostId}&task=${taskId}`)
        assert.equal(view.commands.find(command => command.commandId === pausedCommand.commandId).status, 'completed')
        assert.ok(view.commands.some(command => command.status === 'pending'), 'Pause did not preserve remaining commands')
        await operation({ action: 'resume', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })
      } else await operation(decision)
    }
    view = await api(`task?host=${hostId}&task=${taskId}`)
    if (intentionalPause) {
      assert.ok(view.commands.every(command => command.status !== 'uncertain'), 'Paused work still requires reconciliation')
      assert.equal(view.control.action, 'pause')
      await record(`task ${taskId} deliberately paused with confirmed outcomes; remaining work requires separate continuation approval`)
    } else {
      assert.ok(view.commands.length && view.commands.every(command => command.status === 'completed'), 'Execution incomplete; inspect task before continuation')
      for (const command of confirmed) assert.equal(view.commands.find(current => current.commandId === command.commandId)?.attemptId, command.attemptId, 'Continuation replayed confirmed history')
      for (const command of recordedJobs) {
        const current = view.commands.find(current => current.commandId === command.commandId)
        assert.equal(current.jobId, command.jobId, 'Continuation replaced an existing durable job')
        assert.equal(current.attemptId, command.attemptId, 'Continuation replaced a recorded execution attempt')
      }
      if (reloadedJob) {
        const current = view.commands.find(command => command.commandId === reloadedJob.commandId)
        assert.equal(current.jobId, reloadedJob.jobId)
        assert.equal(current.attemptId, reloadedJob.attemptId)
        await record(`task ${taskId} browser reload preserved the active job and execution attempt`)
      }
      if (pausedCommand) {
        const command = view.commands.find(command => command.commandId === pausedCommand.commandId)
        assert.equal(command.attemptId, pausedCommand.attemptId)
        assert.equal(command.jobId, pausedCommand.jobId)
        await record(`task ${taskId} in-flight pause preserved its job and attempt; approved continuation skipped completed work`)
      }
      if (firstAttempt) {
        assert.equal(view.commands[0].attemptId, firstAttempt, 'Continuation replayed a completed command')
        await assert.rejects(operation({ action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true }))
        assert.deepEqual((await api(`task?host=${hostId}&task=${taskId}`)).commands, view.commands)
      }
      await record(`task ${taskId} confirmed all ${view.commands.length} commands completed; durable review/reload and duplicate-request checks passed`)
      await inspectBaseline(taskId, 'applied')
      await pane.locator('header .status-completed').waitFor({ timeout: 30000 })
      if (await page.getByRole('button', { name: 'Dismiss', exact: true }).isVisible()) await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await pane.getByRole('button', { name: 'execution', exact: true }).click()
      await page.screenshot({ path: new URL(`${taskId}-${catalogId}-completed.png`, screenshots).pathname, fullPage: true, maskColor: '#808080', mask: [page.locator('pre'), page.locator('code')] })
      if (process.argv.includes('--verify-repeat-apply')) {
        const repeated = await operation({ action: 'prepare', hostId, catalogId, request: 'Verify already-installed Windows Intent AI Ops without replacing its owner' })
        const repeatId = repeated.results[0].taskId
        let repeatView = await api(`task?host=${hostId}&task=${repeatId}`)
        const originalState = await inspectBaseline(repeatId)
        await operation({ action: 'execute', hostId, taskId: repeatId, expectedVersion: repeatView.stateVersion, fingerprint: repeatView.fingerprint, approved: true })
        repeatView = await api(`task?host=${hostId}&task=${repeatId}`)
        assert.ok(repeatView.commands.every(command => command.status === 'completed'))
        await inspectBaseline(repeatId, 'applied')
        const settingsStore = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT)
        const host = (await settingsStore.load()).servers[hostId]
        const tasks = new TaskStore(process.env.INTENT_WEB_DATA_ROOT, { directoryAliases: new Map([[hostId, host.historyId ?? hostId]]) })
        assert.equal(tasks.get(hostId, repeatId).results.find(result => result.id === 'install-intent-ai-ops').result.stdout.trim(), 'Intent AI Ops is already installed; leaving it unchanged')
        await operation({ action: 'rollback', hostId, taskId: repeatId, expectedVersion: repeatView.stateVersion, fingerprint: repeatView.rollbackFingerprint, approved: true })
        assert.equal(await inspectBaseline(repeatId, 'reverted'), originalState, 'Repeated apply removed or changed the original installation')
        assert.deepEqual((await api(`task?host=${hostId}&task=${taskId}`)).commands, view.commands)
        await record(`task ${taskId} repeat task ${repeatId} verified the existing CLI without reinstalling; reviewed repeat rollback preserved the original owner and exact registry baseline`)
      }
      if (view.rollbackAvailable && !process.argv.includes('--keep-applied')) {
        await operation({ action: 'rollback', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.rollbackFingerprint, approved: true })
        view = await api(`task?host=${hostId}&task=${taskId}`)
        assert.ok(view.rollbackCommands.every(command => command.status === 'completed'))
        await record(`task ${taskId} reviewed rollback completed; exact baseline still requires independent assertions`)
        const restored = await inspectBaseline(taskId, 'reverted')
        if (baseline) {
          assert.equal(restored, baseline, 'Trusted state probe did not restore its original baseline')
          await record(`task ${taskId} independent rollback verification and exact trusted-probe baseline matched`)
        } else await record(`task ${taskId} independent rollback verification passed; no original probe digest was captured`)
      } else if (process.argv.includes('--keep-applied')) {
        await record(`task ${taskId} intentionally retained for prerequisite testing; review rollback after dependent tasks`)
      }
      if (process.argv.includes('--verify-controls')) {
        const samples = await Promise.all([api(`metrics?host=${hostId}`), api(`metrics?host=${hostId}`)])
        assert.equal(samples[0].state, 'available')
        assert.equal(samples[0].sampledAt, samples[1].sampledAt)
        assert.ok(Number.isFinite(Date.parse(samples[0].sampledAt)))
        for (const value of samples[0].values) {
          assert.ok(['available', 'unavailable'].includes(value.state))
          if (value.state === 'available') assert.ok(Number.isFinite(Date.parse(value.observedAt)))
          else assert.ok(value.reason)
        }
        await record(`shared metrics sample: ${samples[0].values.map(value => `${value.context}=${value.state}`).join(', ')}`)
      }
    }
  }
} catch (error) {
  await record(`task ${taskId ?? 'not yet created'} stopped: inspect persisted history before any replay or rollback`)
  let message = String(error.message)
  for (const secret of [process.env.VAULT_TEST, process.env.SSH_HOST_MAC_PWD, process.env.SSH_HOST_WIN_PWD, cli?.url].filter(Boolean)) message = message.replaceAll(secret, '[redacted]')
  throw new Error(redactDiagnosticText(message))
} finally {
  await browser?.close()
  await cli?.close()
}
