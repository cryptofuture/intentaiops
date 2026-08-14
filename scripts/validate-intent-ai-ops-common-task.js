#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { accessSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const TARGETS = new Map([
  ['macos-15', { platform: 'macos', credentialEnv: 'SSH_HOST_MAC_PWD' }],
  ['windows-11', { platform: 'windows', credentialEnv: 'SSH_HOST_PWD' }]
])

async function main () {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: validate-intent-ai-ops-common-task.js --host=macos-15|windows-11 [--keep-installed]\n')
    return
  }
  if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
  const serverId = process.argv.find(argument => argument.startsWith('--host='))?.slice(7)
  const target = TARGETS.get(serverId)
  if (!target) throw new Error('select --host=macos-15 or --host=windows-11')

  const projectRoot = path.resolve(import.meta.dirname, '..')
  const tarball = path.join(projectRoot, 'dist', 'intent-ai-ops.tgz')
  const installer = path.join(projectRoot, 'scripts', target.platform === 'windows' ? 'install.ps1' : 'install.sh')
  accessSync(tarball)
  accessSync(installer)

  const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
  const settingsStore = new SettingsStore(dataRoot)
  const settings = await settingsStore.load()
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId })
  const credential = server.sshCredential ?? process.env[target.credentialEnv] ?? process.env.SSH_HOST_1
  const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
    authentication: server.authentication,
    credential
  })
  const token = randomBytes(8).toString('hex')
  const remoteDirectory = target.platform === 'windows'
    ? `C:/Windows/Temp/webminai.${token}`
    : `/tmp/webminai.${token}`
  const commandDirectory = target.platform === 'windows' ? remoteDirectory.replaceAll('/', '\\') : remoteDirectory
  const remoteInstaller = `${remoteDirectory}/${path.basename(installer)}`
  const remoteTarball = `${remoteDirectory}/intent-ai-ops.tgz`

  try {
    await session.ssh.execute(server.connectionUrl, createDirectory(target.platform, remoteDirectory), { timeoutMs: 30000 })
    await session.ssh.copy(server.connectionUrl, installer, remoteInstaller, { timeoutMs: 120000 })
    await session.ssh.copy(server.connectionUrl, tarball, remoteTarball, { timeoutMs: 120000 })

    const admin = new AdminService({ dataRoot, ssh: session.ssh, settings: settingsStore })
    const inventory = await inventoryWithStage2Recovery(admin, settings, serverId, target)
    assert.equal(inventory.webminaiExecution?.platform, target.platform)
    const catalogId = `intent-ai-ops-${target.platform}`
    await recoverPartialValidation(admin, server, serverId, catalogId, target.platform)
    const task = admin.createTask(serverId, `Live validation for ${catalogId}`, { kind: 'catalog', catalogId })
    const built = buildCommonTask(catalogId, task.id, {
      platform: target.platform,
      inventory,
      docker: inventory.webminaiDocker,
      windowsExecution: inventory.webminaiExecution,
      macosExecution: inventory.webminaiExecution,
      intentAiOpsInstallSource: {
        installerPath: `${commandDirectory}\\${path.basename(installer)}`.replace('/tmp/', '/tmp/').replaceAll('\\', target.platform === 'windows' ? '\\' : '/'),
        packageUrl: `${commandDirectory}\\intent-ai-ops.tgz`.replaceAll('\\', target.platform === 'windows' ? '\\' : '/')
      }
    })
    admin.saveTaskPlan(serverId, task.id, built.plan)
    const netdata = admin.netdata(server)
    const baseline = await probe(netdata, built.stateProbe)
    if (baseline !== 'intent-ai-ops=absent') throw new Error(`live test requires an absent task-owned install baseline; observed ${baseline}`)

    let applied = false
    try {
      admin.markTaskRunning(serverId, task.id)
      applied = true
      const apply = await execute(admin, settings, serverId, built.plan, 'apply')
      requireCompleted(apply, 'apply')
      admin.saveTaskResults(serverId, task.id, apply)
      await verify(netdata, built.verifyApplied)
      assert.equal(await probe(netdata, built.stateProbe), 'intent-ai-ops=task-owned')
      if (process.argv.includes('--keep-installed')) {
        applied = false
        process.stdout.write(`PASS: ${catalogId} installed directly on ${serverId}, executed its CLI, and remains installed as task #${task.id}\n`)
        return
      }

      admin.markTaskReverting(serverId, task.id)
      const revertPlan = { ...built.plan, commands: built.plan.revertCommands, revertCommands: [] }
      const revert = await execute(admin, settings, serverId, revertPlan, 'revert', false)
      requireCompleted(revert, 'revert')
      await verify(netdata, built.verifyReverted)
      assert.equal(await probe(netdata, built.stateProbe), baseline)
      admin.saveTaskRevertResults(serverId, task.id, revert)
      applied = false
      process.stdout.write(`PASS: ${catalogId} installed directly on ${serverId}, executed its CLI, and restored the exact baseline\n`)
    } catch (error) {
      admin.saveTaskError(serverId, task.id, error)
      if (applied && process.env.WEBMINAI_KEEP_FAILED !== '1') await bestEffortRevert(admin, settings, serverId, task.id, built.plan)
      throw error
    }
  } finally {
    try {
      await session.ssh.execute(server.connectionUrl, removeDirectory(target.platform, remoteDirectory), { timeoutMs: 120000 })
    } catch {}
    await session.close()
  }
}

async function inventoryWithStage2Recovery (admin, settings, serverId, target) {
  try {
    return await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId })
  } catch (error) {
    const diagnostic = [error.message, error.cause?.message, error.cause?.result?.stdout, error.cause?.result?.stderr].filter(Boolean).join('\n')
    if (target.platform !== 'macos' || !diagnostic.includes('404')) throw error
    const capabilities = await admin.capabilities({ settings, passphrase: process.env.VAULT_TEST, serverId })
    const elevation = capabilities.isRoot
      ? { elevation: 'root' }
      : capabilities.hasPasswordlessSudo
        ? { elevation: 'sudo-n' }
        : capabilities.hasSudo
          ? { elevation: 'sudo-password', sudoPassword: process.env[target.credentialEnv] }
          : null
    if (!elevation) throw new Error('macOS Stage 2 recovery requires root or sudo elevation')
    process.stdout.write(`[${serverId}] Stage 2 is inactive; installing the host-native plugin while preserving Netdata\n`)
    await admin.activate({ settings, passphrase: process.env.VAULT_TEST, serverId, installNetdata: false, ...elevation })
    return admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId })
  }
}

async function recoverPartialValidation (admin, server, serverId, catalogId, platform) {
  const tasks = admin.listTasks(serverId, { limit: 100 })
    .filter(task => task.catalogId === catalogId && task.status === 'failed' && task.request === `Live validation for ${catalogId}`)
  const netdata = admin.netdata(server)
  for (const task of tasks) {
    const state = platform === 'windows'
      ? `C:\\ProgramData\\WebminAI\\Tasks\\${task.id}-intent-ai-ops-install`
      : `/var/db/webminai/task-state/${task.id}-intent-ai-ops-install`
    const root = platform === 'windows' ? 'C:\\ProgramData\\IntentAIOps' : '/usr/local/share/intent-ai-ops'
    const command = platform === 'windows'
      ? `$state='${state}';$root='${root}';if((Test-Path -LiteralPath (Join-Path $state 'baseline'))-and-not(Test-Path -LiteralPath (Join-Path $state 'root.existed'))-and-not(Test-Path -LiteralPath (Join-Path $state 'installed'))){Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath $state -Recurse -Force}`
      : `state='${state}'; root='${root}'; if [ -e "$state/baseline" ] && [ ! -e "$state/root.existed" ] && [ ! -e "$state/installed" ]; then rm -rf -- "$root" "$state"; fi`
    const result = await netdata.runCommand(command, { timeoutSeconds: 120 })
    assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
  }
}

async function execute (admin, settings, serverId, plan, label, requireRevert = true) {
  return admin.execute({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId,
    plan,
    requireRevert,
    approve: async () => true,
    onResult: result => {
      process.stdout.write(`[${serverId}][${label}:${result.id}] ${result.status}\n`)
      if (result.status !== 'completed') {
        if (result.result?.stdout) process.stderr.write(`[${serverId}][stdout] ${result.result.stdout}\n`)
        if (result.result?.stderr) process.stderr.write(`[${serverId}][stderr] ${result.result.stderr}\n`)
      }
    }
  })
}

async function bestEffortRevert (admin, settings, serverId, taskId, plan) {
  try {
    admin.markTaskReverting(serverId, taskId)
    const revertPlan = { ...plan, commands: plan.revertCommands, revertCommands: [] }
    const results = await execute(admin, settings, serverId, revertPlan, 'cleanup', false)
    admin.saveTaskRevertResults(serverId, taskId, results)
  } catch (error) {
    admin.saveTaskRevertError(serverId, taskId, error)
  }
}

async function probe (netdata, command) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 120 })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
  return result.stdout.trim()
}

async function verify (netdata, command) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 120 })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
}

function requireCompleted (results, label) {
  const failed = results?.find(result => result.status !== 'completed')
  if (!Array.isArray(results) || results.length === 0 || failed) {
    throw new Error(`${label} failed: ${failed?.result?.stderr?.trim() || failed?.result?.stdout?.trim() || failed?.status || 'no results'}`)
  }
}

function createDirectory (platform, directory) {
  if (platform === 'windows') return powershell(`New-Item -ItemType Directory -Path '${directory}' -Force|Out-Null`)
  return `install -d -m 0700 '${directory}'`
}

function removeDirectory (platform, directory) {
  if (platform === 'windows') return powershell(`Remove-Item -LiteralPath '${directory}' -Recurse -Force -ErrorAction SilentlyContinue`)
  return `rm -rf -- '${directory}'`
}

function powershell (script) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
