#!/usr/bin/env node
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { runProcess } from '../src/process-runner.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

let settingsStore
let serverId

async function main () {
  const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
  serverId = process.env.WEBMINAI_TEST_SERVER ?? 'windows-11'
  const action = process.argv[2] ?? 'install'
  const requestedTaskId = process.argv[3] === undefined ? null : Number(process.argv[3])

  if (!['diagnose', 'install', 'probe', 'verify', 'revert'].includes(action)) {
    throw new Error('usage: validate-windows-brave.js [diagnose|install|probe|verify|revert] [task-id]')
  }
  if (requestedTaskId !== null && (!Number.isInteger(requestedTaskId) || requestedTaskId < 1)) {
    throw new TypeError('task-id must be a positive integer')
  }
  if (!process.env.VAULT_TEST || !(process.env.SSH_HOST_PWD || process.env.SSH_HOST_1)) {
    throw new Error('VAULT_TEST and SSH_HOST_PWD (or SSH_HOST_1) are required')
  }

  settingsStore = new SettingsStore(dataRoot)
  const settings = await settingsStore.load()
  const server = await settingsStore.decryptServer({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId
  })
  const askpassEnvironment = {
    ...process.env,
    SSH_HOST_1: process.env.SSH_HOST_PWD ?? process.env.SSH_HOST_1,
    SSH_ASKPASS: path.resolve('scripts/webminai-askpass.sh'),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: 'webminai-askpass'
  }
  const interactiveRunner = (command, args, options = {}) => runProcess(
    'setsid',
    ['-w', command, ...args],
    { ...options, env: askpassEnvironment }
  )
  const baseSsh = new SystemSsh({ interactiveRunner, terminalCheck: () => true })
  const session = await baseSsh.openInteractiveSession(server.connectionUrl, {
    authentication: server.authentication ?? 'password'
  })

  try {
    const admin = new AdminService({ dataRoot, ssh: session.ssh, settings: settingsStore })
    if (action === 'diagnose') {
      await diagnoseBraveInstallation(admin, settings)
    } else if (action === 'probe') {
      await probeBraveRelease(admin, settings, requestedTaskId)
    } else if (action === 'verify') {
      await verifyBrave(admin, settings)
    } else if (action === 'revert') {
      if (requestedTaskId === null) throw new Error('revert requires the successful install task id')
      admin.markTaskReverting(serverId, requestedTaskId)
      try {
        const results = await admin.revertTask({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          taskId: requestedTaskId,
          approve: async () => true,
          onResult: result => {
            admin.appendTaskRevertResult(serverId, requestedTaskId, result)
            printResult('revert', result)
          }
        })
        admin.saveTaskRevertResults(serverId, requestedTaskId, results)
        requireCompleted(results, 'Brave rollback')
      } catch (error) {
        admin.saveTaskRevertError(serverId, requestedTaskId, error)
        throw error
      }
    } else {
      const retryTask = requestedTaskId === null ? findLatestBraveTask(admin) : admin.getTask(serverId, requestedTaskId)
      const previousAttempts = retryTask ? admin.getTaskRetryHistory(serverId, retryTask.id) : []
      const request = retryTask?.request ?? 'install brave browser'
      const task = admin.createTask(serverId, request, {
        retryOfTaskId: retryTask?.id ?? null,
        retryInstructions: 'Correct every recorded Windows LocalSystem failure. Use PowerShell-native HTTP requests and Start-Process for native installers. Complete and verify the Brave installation. Treat an already installed verified Brave as idempotent success. If an earlier command in this retry chain installed it after the original absent baseline, preserve retry-chain ownership rather than treating it as unrelated pre-existing software.'
      })
      process.stdout.write(`Created Brave validation task #${task.id}${retryTask ? ` from task #${retryTask.id}` : ''}.\n`)
      try {
        const inventory = await admin.refreshInventory({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId
        })
        const plan = await admin.plan({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          request,
          inventory,
          taskId: task.id,
          previousAttempts,
          retryInstructions: task.retryInstructions,
          onProgress: event => {
            admin.appendTaskProgress(serverId, task.id, event)
            process.stdout.write(`[codex:${event.type}] ${singleLine(event.message)}\n`)
          }
        })
        admin.saveTaskPlan(serverId, task.id, plan)
        process.stdout.write(`Executing ${plan.commands.length} approved commands; ${plan.revertCommands.length} rollback commands were saved.\n`)
        admin.markTaskRunning(serverId, task.id)
        const results = await admin.execute({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          plan,
          approve: async () => true,
          onResult: result => {
            admin.appendTaskResult(serverId, task.id, result)
            printResult('execute', result)
          }
        })
        admin.saveTaskResults(serverId, task.id, results)
        requireCompleted(results, `Brave task #${task.id}`)
        await verifyBrave(admin, settings)
        process.stdout.write(`PASS: Brave installation task #${task.id} completed and independently verified.\n`)
      } catch (error) {
        admin.saveTaskError(serverId, task.id, error)
        throw error
      }
    }
  } finally {
    await session.close()
  }
}

export function findLatestBraveTask (admin, hostId = serverId) {
  return admin.listTasks(hostId, { limit: 100 })
    .find(task => /\bbrave(?:\s+browser)?\b/iu.test(task.request))
}

async function diagnoseBraveInstallation (admin, settings) {
  const current = await settingsStore.decryptServer({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId
  })
  const command = [
    "$ErrorActionPreference='Stop'",
    "$registryRoots=@('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','Registry::HKEY_USERS\\S-1-5-18\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$entries=@(Get-ItemProperty -Path $registryRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Brave*' -or $_.Publisher -like '*Brave*' } | Select-Object PSPath,DisplayName,DisplayVersion,Publisher,InstallLocation,DisplayIcon,UninstallString,QuietUninstallString)",
    "$roots=@('C:\\Program Files\\BraveSoftware','C:\\Program Files (x86)\\BraveSoftware','C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local\\BraveSoftware','C:\\Windows\\SysWOW64\\config\\systemprofile\\AppData\\Local\\BraveSoftware')",
    "$files=@(); foreach($root in $roots){if(Test-Path -LiteralPath $root){$files+=@(Get-ChildItem -LiteralPath $root -Filter 'brave.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime)}}",
    "$services=@(Get-Service -Name '*Brave*' -ErrorAction SilentlyContinue | Select-Object Name,DisplayName,Status,StartType)",
    '[pscustomobject]@{localSystemLocalAppData=$env:LOCALAPPDATA;registryEntries=$entries;executables=$files;services=$services} | ConvertTo-Json -Depth 8 -Compress'
  ].join(';')
  const result = await admin.netdata(current).runCommand(command, { timeoutSeconds: 60 })
  if (result.exitCode !== 0) throw new Error(`Brave diagnosis failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  process.stdout.write(`${result.stdout.trim()}\n`)
}

async function probeBraveRelease (admin, settings, taskId) {
  const current = await settingsStore.decryptServer({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId
  })
  const stateCommand = taskId === null
    ? '$stateProbe=@{checked=$false}'
    : [
        `$state='C:\\ProgramData\\WebminAI\\Tasks\\${taskId}'`,
        "$installer=Join-Path $state 'BraveBrowserStandaloneSetup.exe'",
        "$release=Join-Path $state 'release.json'",
        '$signature=$(if(Test-Path -LiteralPath $installer){[string](Get-AuthenticodeSignature -LiteralPath $installer).Status}else{$null})',
        '$stateProbe=@{checked=$true;state=$state;installerExists=Test-Path -LiteralPath $installer;installerLength=$(if(Test-Path -LiteralPath $installer){(Get-Item -LiteralPath $installer).Length}else{0});installerSignature=$signature;releaseExists=Test-Path -LiteralPath $release}'
      ].join(';')
  const command = [
    "$ErrorActionPreference='Stop'",
    "$headers=@{'User-Agent'='WebminAI-BraveInstaller';'Accept'='application/vnd.github+json'}",
    "$response=Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/brave/brave-browser/releases?per_page=10' -Headers $headers -Method Get -TimeoutSec 60",
    '$items=@($response)',
    '$first=$items | Select-Object -First 1',
    stateCommand,
    '[pscustomobject]@{responseType=$response.GetType().FullName;count=$items.Count;firstType=$(if($first){$first.GetType().FullName}else{$null});firstTag=$first.tag_name;firstDraft=$first.draft;firstPrerelease=$first.prerelease;hasAssets=[bool]$first.assets;taskState=$stateProbe} | ConvertTo-Json -Depth 4 -Compress'
  ].join(';')
  const result = await admin.netdata(current).runCommand(command, { timeoutSeconds: 90 })
  if (result.exitCode !== 0) throw new Error(`Brave release probe failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  process.stdout.write(`${result.stdout.trim()}\n`)
}

async function verifyBrave (admin, settings) {
  const current = await settingsStore.decryptServer({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId
  })
  const command = [
    "$ErrorActionPreference='Stop'",
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$entry=Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Brave*' } | Select-Object -First 1",
    "if(-not $entry){throw 'Brave uninstall entry was not found.'}",
    '$icon=[string]$entry.DisplayIcon',
    "$iconMatch=[regex]::Match($icon,'^\\s*\"?(?<path>.*?\\.exe)\"?(?:,\\d+)?\\s*$',[Text.RegularExpressions.RegexOptions]::IgnoreCase)",
    '$exe=$(if($iconMatch.Success){$iconMatch.Groups[\'path\'].Value}else{$null})',
    "if(-not $exe -and $entry.InstallLocation){$exe=Join-Path $entry.InstallLocation 'brave.exe'}",
    "if(-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)){throw 'Brave executable was not found.'}",
    '$signature=Get-AuthenticodeSignature -LiteralPath $exe',
    "if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Brave Software'){throw 'Brave executable signature is invalid.'}",
    "[pscustomobject]@{status='installed';displayName=$entry.DisplayName;version=$entry.DisplayVersion;executable=$exe;signature=[string]$signature.Status;publisher=$signature.SignerCertificate.Subject} | ConvertTo-Json -Compress"
  ].join(';')
  const result = await admin.netdata(current).runCommand(command, { timeoutSeconds: 30 })
  if (result.exitCode !== 0) throw new Error(`independent Brave verification failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  const verified = JSON.parse(result.stdout)
  process.stdout.write(`Verified ${verified.displayName} ${verified.version}; Authenticode ${verified.signature}.\n`)
  return verified
}

export function requireCompleted (results, label) {
  if (!Array.isArray(results) || results.length === 0 || results.some(result => result.status !== 'completed')) {
    const failed = results?.find(result => result.status !== 'completed')
    const evidence = failed?.result?.stderr?.trim() || failed?.result?.stdout?.trim() || failed?.status || 'no result'
    throw new Error(`${label} did not complete: ${evidence}`)
  }
}

function printResult (phase, result) {
  process.stdout.write(`[${phase}:${result.id}] ${result.status}\n`)
  if (result.status !== 'completed') {
    const evidence = result.result?.stderr?.trim() || result.result?.stdout?.trim()
    if (evidence) process.stdout.write(`${evidence.slice(0, 4000)}\n`)
  }
}

export function singleLine (value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 1000)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
