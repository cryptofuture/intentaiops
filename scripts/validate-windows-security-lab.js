import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { launchLabCli } from '../browser-checks/lab-cli.js'
import { SettingsStore } from '../src/settings-store.js'
import { OperatorController } from '../src/operator-controller.js'
import { windowsDockerPowerShellAdapter } from '../src/windows-compose-foundation.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { planFingerprint } from '../src/execution-journal.js'

if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
process.env.INTENT_WEB_DATA_ROOT ??= '/home/vscode/.intentaiops'
const [phase = 'install', rawId] = process.argv.slice(2)
if (!['install', 'resume', 'refresh', 'restore', 'fixture-cleanup', 'cleanup-reboot'].includes(phase) || (phase !== 'install' && !/^[1-9][0-9]*$/u.test(rawId ?? ''))) throw new Error('Usage: validate-windows-security-lab.js install|resume TASK_ID|refresh TASK_ID|restore TASK_ID|fixture-cleanup TASK_ID|cleanup-reboot SOURCE_TASK_ID')
const hostId = 'windows-lab'
const checkpoint = 'docs/windows-security-remediation-status.md'
async function note (message) {
  const line = `${new Date().toISOString()} ${message}`
  console.log(line)
  await appendFile(checkpoint, line + '\n\n')
}
let fixtureCleanup
let cleanupRebootTaskId
if (phase === 'cleanup-reboot') {
  const settings = await new SettingsStore(process.env.INTENT_WEB_DATA_ROOT).load()
  const controller = new OperatorController({ dataRoot: process.env.INTENT_WEB_DATA_ROOT, settings, passphrase: process.env.VAULT_TEST })
  const source = controller.tasks.get(hostId, Number(rawId))
  assert.ok(source.catalogId === 'docker-desktop-windows' && source.status === 'reverted', 'Restore the Docker prerequisite before a cleanup reboot')
  const task = controller.tasks.create(hostId, `User-authorized Windows feature cleanup reboot after Docker/WSL rollback task ${source.id}; no Windows Update installation`, { kind: 'ai' })
  cleanupRebootTaskId = task.id
  const rebootName = `IntentAI-Security-Reboot-${task.id}`
  const recoveryName = `IntentAI-Security-Recovery-${task.id}`
  const encodedRecovery = Buffer.from(`Start-Sleep -Seconds 10; Start-Service sshd -ErrorAction SilentlyContinue; Start-Service Netdata -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${recoveryName}' -Confirm:$false -ErrorAction SilentlyContinue`, 'utf16le').toString('base64')
  const encodedReboot = Buffer.from('Restart-Computer -Force', 'utf16le').toString('base64')
  const command = [
    "$ErrorActionPreference='Stop'",
    "if((Test-Path 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe')-or(Test-Path 'C:\\Program Files\\WSL\\wsl.exe')){throw 'Prerequisite packages remain'}",
    "foreach($name in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')){if([string](Get-WindowsOptionalFeature -Online -FeatureName $name).State -ne 'Disabled'){throw 'Feature baseline is not restored'}}",
    "if(-not(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')){Write-Output 'NO_REBOOT_REQUIRED';exit 0}",
    `if((Get-ScheduledTask -TaskName '${rebootName}' -ErrorAction SilentlyContinue)-or(Get-ScheduledTask -TaskName '${recoveryName}' -ErrorAction SilentlyContinue)){throw 'Cleanup reboot task name already exists'}`,
    "$powerShell=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';$principal=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest",
    `$recovery=New-ScheduledTaskAction -Execute $powerShell -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedRecovery}';Register-ScheduledTask -TaskName '${recoveryName}' -Action $recovery -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal|Out-Null`,
    `$restart=New-ScheduledTaskAction -Execute $powerShell -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedReboot}';$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30);$trigger.EndBoundary=(Get-Date).AddMinutes(3).ToString('s');$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 1);Register-ScheduledTask -TaskName '${rebootName}' -Action $restart -Trigger $trigger -Principal $principal -Settings $settings|Out-Null`,
    `if(-not(Get-ScheduledTask -TaskName '${rebootName}')-or-not(Get-ScheduledTask -TaskName '${recoveryName}')){throw 'Cleanup reboot registration failed'}`,
    "Write-Output 'CLEANUP_REBOOT_SCHEDULED_30_SECONDS'"
  ].join(';')
  const plan = { summary: 'Authorized cleanup reboot after restoring Docker/WSL baseline', changeOverview: 'Only finalize feature cleanup; no Windows Update API or package installation', modifiedFiles: [], warnings: ['A reboot cannot be undone. Rollback only cancels an untriggered schedule or removes its owned scheduled tasks.'], commands: [{ id: 'schedule-feature-cleanup-reboot', command, purpose: 'Check the restored baseline, schedule one reboot and restore SSH/Netdata observation at startup', phase: 'services', risk: 'change', requiresSudo: true, timeoutMs: 60000, executionMode: 'job', dependsOn: [] }], revertCommands: [{ id: 'cancel-owned-cleanup-reboot', command: `foreach($name in @('${rebootName}','${recoveryName}')){Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue};Write-Output 'owned-cleanup-schedules-removed'`, purpose: 'Cancel only owned schedules; does not reverse an already performed reboot', phase: 'cleanup', risk: 'change', requiresSudo: true, timeoutMs: 30000, dependsOn: [] }] }
  validateCommandPlan(plan, { executionIdentity: 'root' })
  controller.tasks.savePlan(hostId, task.id, plan)
  await note(`Cleanup reboot task=${task.id}, source rollback=${source.id}; fixed reviewed scheduling and SSH/Netdata startup recovery only`)
}
if (phase === 'fixture-cleanup') {
  const settings = await new SettingsStore(process.env.INTENT_WEB_DATA_ROOT).load()
  const controller = new OperatorController({ dataRoot: process.env.INTENT_WEB_DATA_ROOT, settings, passphrase: process.env.VAULT_TEST })
  const taskId = Number(rawId)
  const view = controller.inspect(hostId, taskId)
  const tag = /^Isolated PHP Docker security fixture (intent-security-[a-f0-9]{12});/u.exec(view.task.request)?.[1]
  assert.ok(tag && ['reverted', 'revert_failed'].includes(view.task.status) && view.commands.every(command => command.status === 'completed') && !view.rollbackCommands.some(command => command.status === 'uncertain'), 'Only confirmed completed isolated fixtures without uncertain rollback work can use this cleanup')
  const volume = tag + '-data'
  const command = [
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(60000),
    `$present=& $docker volume ls --filter 'name=^${volume}$' --format '{{.Name}}';if(-not[string]::IsNullOrWhiteSpace([string]$present)){$owner=(& $docker volume inspect '${volume}' --format '{{json .Labels}}'|ConvertFrom-Json);if($owner.'io.intentaiops.security-fixture'-ne '${tag}'){throw 'Fixture ownership mismatch'};$users=@(& $docker ps -a --filter 'volume=${volume}' --format '{{.ID}}');if($users.Count){throw 'Fixture volume is still attached'};& $docker volume rm '${volume}';if($LASTEXITCODE-ne 0){throw 'Fixture volume removal failed'}}`,
    `$remaining=& $docker volume ls --filter 'name=^${volume}$' --format '{{.Name}}';if(-not[string]::IsNullOrWhiteSpace([string]$remaining)){throw 'Fixture volume remains'}`,
    "$global:LASTEXITCODE=0;Write-Output 'FIXTURE_BASELINE_RESTORED'"
  ].join(';')
  const plan = { summary: 'Remove only the confirmed leftover security-fixture volume', changeOverview: 'New reviewed cleanup, original rollback is not replayed', modifiedFiles: [], operatorRollback: true, commands: [{ id: 'remove-confirmed-fixture-volume', command, purpose: 'Verify exact fixture ownership and no attached containers before removing only its disposable sentinel volume', phase: 'cleanup', risk: 'destructive', requiresSudo: true, timeoutMs: 60000, executionMode: 'job', dependsOn: [] }], revertCommands: [] }
  validateCommandPlan(plan, { executionIdentity: 'root' }, { requireRevert: false })
  const revisionId = controller.tasks.proposeRevision(hostId, taskId, plan, view.stateVersion)
  fixtureCleanup = { revisionId, expectedVersion: view.stateVersion, fingerprint: planFingerprint(plan) }
  controller.record({ type: 'security_fixture_cleanup_proposed', hostId, taskId, revisionId })
  await note(`Fixture task=${taskId}, new scoped cleanup revision=${revisionId}; exact owner checked and completed rollback will not be replayed`)
}
const cli = await launchLabCli({ actions: true })
try {
  const launch = new URL(cli.url)
  const base = new URL('.', launch)
  const login = await fetch(new URL('session', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.origin }, body: JSON.stringify({ token: launch.hash.slice(1) }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const { csrf } = await login.json()
  async function api (route, body) {
    const response = await fetch(new URL(route, base), { headers: { Cookie: cookie, Origin: base.origin, ...(body ? { 'Content-Type': 'application/json', 'X-Intent-CSRF': csrf } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }
  async function operation (body) {
    const accepted = await api('operation', { ...body, requestKey: randomUUID() })
    await note(`accepted ${body.action}, operation=${accepted.id}`)
    for (let attempt = 0; attempt < 2400; attempt++) {
      const current = await api(`operation?id=${accepted.id}`)
      if (current.status !== 'running') {
        assert.equal(current.status, 'completed', current.error ?? 'Inspect durable history without replay')
        return current.result
      }
      if (attempt % 30 === 0) console.log(`Observing ${body.action}, ${attempt}s; no replay`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Observation deadline exceeded; inspect persisted operation without replay')
  }
  let taskId = cleanupRebootTaskId ?? Number(rawId)
  if (phase === 'install') {
    const prepared = await operation({ action: 'prepare', hostId, catalogId: 'docker-desktop-windows', request: 'Install Docker/WSL for the explicitly authorized isolated security remediation test. Restore the task-owned baseline afterward.' })
    taskId = prepared.results[0].taskId
    await note(`Docker prerequisite task=${taskId}, prepared through actual CLI binary`)
  }
  let view = await api(`task?host=${hostId}&task=${taskId}`)
  assert.equal(view.task.catalogId, phase === 'cleanup-reboot' ? null : phase === 'fixture-cleanup' ? 'wordpress-windows' : 'docker-desktop-windows')
  if (phase === 'cleanup-reboot') {
    await operation({ action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })
    view = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(view.task.status, 'completed')
    await note(`Cleanup reboot task=${taskId} scheduling confirmed; observe the existing restart without repeating it`)
  } else if (phase === 'fixture-cleanup') {
    await operation({ action: 'approve', hostId, taskId, ...fixtureCleanup, approved: true })
    view = await api(`task?host=${hostId}&task=${taskId}`)
    await operation({ action: 'rollback', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: fixtureCleanup.fingerprint, revisionId: fixtureCleanup.revisionId, approved: true })
    view = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(view.task.status, 'reverted')
    await note(`Fixture task=${taskId}, new reviewed volume cleanup completed with explicit ownership/absence checks`)
  } else if (phase === 'restore') {
    await operation({ action: 'rollback', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.rollbackFingerprint, approved: true })
    view = await api(`task?host=${hostId}&task=${taskId}`)
    assert.equal(view.task.status, 'reverted')
    await note(`Docker prerequisite task=${taskId} reviewed rollback completed; verify original features, PATH and reboot state separately`)
  } else {
    if (phase === 'resume' || phase === 'refresh') {
      await operation({ action: 'reconcile', hostId, taskId, expectedVersion: view.stateVersion })
      view = await api(`task?host=${hostId}&task=${taskId}`)
    }
    if (phase === 'refresh') {
      const proposal = await operation({ action: 'refresh-catalog', hostId, taskId, expectedVersion: view.stateVersion })
      await operation({ action: 'approve', hostId, taskId, revisionId: proposal.revisionId, expectedVersion: proposal.expectedVersion, fingerprint: proposal.fingerprint, approved: true })
      await note(`Docker prerequisite task=${taskId}, reviewed trusted revision=${proposal.revisionId}; confirmed completed commands and original rollback preserved`)
      view = await api(`task?host=${hostId}&task=${taskId}`)
    }
    if (view.task.status !== 'completed') await operation({ action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })
    view = await api(`task?host=${hostId}&task=${taskId}`)
    await note(`Docker prerequisite task=${taskId}, status=${view.task.status}; ${view.commands.map(item => `${item.commandId}=${item.status}`).join(', ')}`)
    assert.equal(view.task.status, 'completed', 'Inspect and reconcile failed/uncertain prerequisite commands before continuing')
    const inventory = await api(`inventory?host=${hostId}`)
    await note(`Docker prerequisite task=${taskId}, actual Docker readiness=${inventory.webminaiDocker?.ready === true}; completed reboot-gated phases may require a separately reviewed continuation task`)
  }
} finally { await cli.close() }
