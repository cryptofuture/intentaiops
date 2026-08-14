#!/usr/bin/env node
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask, listCommonTasks } from '../src/common-tasks.js'
import { runProcess } from '../src/process-runner.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { SettingsStore } from '../src/settings-store.js'
import { Stage2Service } from '../src/stage2-service.js'
import { SystemSsh } from '../src/system-ssh.js'
import { TaskStore } from '../src/task-store.js'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: validate-remote-tasks.js [--migrate-only|--tasks-only|--clean-check|--planner-smoke|--retry-smoke=ID|--task=ID|--install-plugin-only]\nRequires VAULT_TEST and SSH_HOST_1 for live validation.\n')
  process.exit(0)
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const serverId = process.env.WEBMINAI_TEST_SERVER ?? 'ismet'
const migrateOnly = process.argv.includes('--migrate-only')
const tasksOnly = process.argv.includes('--tasks-only')
const cleanCheck = process.argv.includes('--clean-check')
const plannerSmoke = process.argv.includes('--planner-smoke')
const retrySmokeValue = process.argv.find(argument => argument.startsWith('--retry-smoke='))?.slice('--retry-smoke='.length)
const retrySmokeTaskId = retrySmokeValue === undefined ? null : Number(retrySmokeValue)
const selectedTask = process.argv.find(argument => argument.startsWith('--task='))?.slice('--task='.length)
const installPluginOnly = process.argv.includes('--install-plugin-only')

if (retrySmokeTaskId !== null && (!Number.isInteger(retrySmokeTaskId) || retrySmokeTaskId < 1)) {
  throw new TypeError('--retry-smoke requires a positive task id')
}

if (!process.env.VAULT_TEST || !process.env.SSH_HOST_1) {
  throw new Error('VAULT_TEST and SSH_HOST_1 are required for remote validation')
}

const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
const server = await settingsStore.decryptServer({
  settings,
  passphrase: process.env.VAULT_TEST,
  serverId
})

const askpassEnvironment = {
  ...process.env,
  SSH_ASKPASS: path.join(scriptDirectory, 'webminai-askpass.sh'),
  SSH_ASKPASS_REQUIRE: 'force',
  DISPLAY: 'webminai-askpass'
}
const interactiveRunner = (command, args, options = {}) => runProcess(
  'setsid',
  ['-w', command, ...args],
  { ...options, env: askpassEnvironment }
)
const baseSsh = new SystemSsh({
  interactiveRunner,
  terminalCheck: () => true
})

process.stdout.write(`Connecting to test host ${serverId} with system SSH...\n`)
const session = await baseSsh.openInteractiveSession(server.connectionUrl, {
  authentication: server.authentication ?? 'password'
})

try {
  const ssh = session.ssh
  const stage2 = new Stage2Service({
    ssh,
    debug: true,
    onDebug: event => process.stdout.write(`[stage2:${event.phase}] ${singleLine(event.message)}\n`)
  })
  const workspace = new ServerWorkspace(dataRoot)
  const tasks = new TaskStore(dataRoot)
  const admin = new AdminService({
    dataRoot,
    ssh,
    settings: settingsStore,
    workspace,
    tasks,
    stage2
  })
  const capabilities = await stage2.capabilities(server)
  const elevation = elevationFor(capabilities, process.env.SSH_HOST_1)
  if (!elevation) throw new Error('test host has no usable root or sudo elevation')

  if (!tasksOnly && !cleanCheck && !plannerSmoke && retrySmokeTaskId === null) {
    if (!installPluginOnly) {
      process.stdout.write('Removing the previous plugin while preserving Netdata...\n')
      await admin.deactivate({
        settings,
        passphrase: process.env.VAULT_TEST,
        serverId,
        removeManagedNetdata: false,
        ...elevation
      })
    }
    process.stdout.write('Installing the updated plugin in plugin-only mode...\n')
    await admin.activate({
      settings,
      passphrase: process.env.VAULT_TEST,
      serverId,
      installNetdata: false,
      ...elevation
    })
    const refreshed = await settingsStore.decryptServer({
      settings,
      passphrase: process.env.VAULT_TEST,
      serverId
    })
    const observed = await stage2.probe(refreshed)
    if (observed.status !== 'active' || observed.executionIdentity !== 'root') {
      throw new Error('updated root plugin did not pass Stage 2 verification')
    }
    process.stdout.write('Updated root plugin is active; existing Netdata was preserved.\n')
  }

  if (!migrateOnly) {
    const current = await settingsStore.decryptServer({
      settings,
      passphrase: process.env.VAULT_TEST,
      serverId
    })
    const netdata = admin.netdata(current)
    if (cleanCheck) {
      await successfulCommand(netdata, "set -eu; ! id webminai-test-user >/dev/null 2>&1; for path in /var/www/webminai-test-site /etc/nginx/conf.d/webminai-test-site.conf /swapfile-webminai-test /etc/systemd/system/webminai-test.service /etc/systemd/system/webminai-test-timer.service /etc/systemd/system/webminai-test.timer /etc/cron.d/webminai-test /etc/logrotate.d/webminai-test /var/log/webminai-test.log /etc/tmpfiles.d/webminai-test.conf /run/webminai-test-service /run/webminai-test-timer /run/webminai-test-tmpfiles /tmp/webminai-cron-ran; do test ! -e \"$path\"; done; ! grep -q '^/swapfile-webminai-test[[:space:]]' /etc/fstab; ! awk '$1 == \"/swapfile-webminai-test\" { found=1 } END { exit !found }' /proc/swaps; if command -v dpkg >/dev/null 2>&1; then test -z \"$(dpkg --audit)\"; fi; if [ -d /var/lib/webminai/task-state ]; then test -z \"$(find /var/lib/webminai/task-state -mindepth 1 -maxdepth 1 -print -quit)\"; fi; printf 'WEBMINAI_TEST_STATE_CLEAN\\n'", 'final catalog cleanup verification')
      process.stdout.write('Catalog test artifacts are absent and package state is clean.\n')
    }
    if (plannerSmoke || retrySmokeTaskId !== null) {
      const previousAttempts = retrySmokeTaskId === null
        ? []
        : admin.getTaskRetryHistory(serverId, retrySmokeTaskId)
      const request = retrySmokeTaskId === null
        ? 'Produce a read-only report of the distribution, kernel, CPU count, memory, disk usage, running containers, and Netdata service status. Do not change any host state. Optional container tools may be absent and services may be inactive; report those states and make every diagnostic command exit zero.'
        : previousAttempts.at(-1).request
      const retryInstructions = retrySmokeTaskId === null
        ? null
        : 'Use the saved failure evidence to correct the plan. Keep this retry read-only and prefer Netdata for every monitoring query.'
      const task = admin.createTask(serverId, request, {
        retryOfTaskId: retrySmokeTaskId,
        retryInstructions
      })
      const label = retrySmokeTaskId === null ? 'planner-smoke' : 'retry-smoke'
      process.stdout.write(`[${label}] planning task #${task.id} with Codex...\n`)
      try {
        const plan = await admin.plan({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          request,
          taskId: task.id,
          previousAttempts,
          retryInstructions,
          onProgress: event => {
            admin.appendTaskProgress(serverId, task.id, event)
            process.stdout.write(`[codex:${event.type}] ${singleLine(event.message)}\n`)
          }
        })
        admin.saveTaskPlan(serverId, task.id, plan)
        if (plan.commands.some(command => command.risk !== 'read') || plan.revertCommands.length !== 0) {
          throw new Error('planner smoke task returned a changing plan')
        }
        requireNetdataMonitoringPlan(plan)
        admin.markTaskRunning(serverId, task.id)
        const results = await admin.execute({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          plan,
          approve: async () => true,
          onResult: result => admin.appendTaskResult(serverId, task.id, result)
        })
        admin.saveTaskResults(serverId, task.id, results)
        requireCompleted(results, 'planner smoke execution')
        requireUsefulNetdataResults(results)
        process.stdout.write(`[${label}] PASS: ${results.length} read-only commands completed and task history was saved.\n`)
      } catch (error) {
        admin.saveTaskError(serverId, task.id, error)
        throw error
      }
    }
    const definitions = listCommonTasks({ category: 'system' }).filter(definition => !selectedTask || definition.id === selectedTask)
    if (selectedTask && definitions.length === 0) throw new Error(`unknown common task: ${selectedTask}`)
    for (const definition of cleanCheck || plannerSmoke || retrySmokeTaskId !== null ? [] : definitions) {
      const task = admin.createTask(serverId, definition.label, {
        kind: 'catalog',
        catalogId: definition.id
      })
      const built = buildCommonTask(definition.id, task.id)
      admin.saveTaskPlan(serverId, task.id, built.plan)
      process.stdout.write(`[${definition.id}] capturing initial state...\n`)
      const before = await successfulCommand(netdata, built.stateProbe, 'initial state probe')
      let applyError
      try {
        admin.markTaskRunning(serverId, task.id)
        const results = await admin.execute({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          plan: built.plan,
          approve: async () => true,
          onResult: result => admin.appendTaskResult(serverId, task.id, result)
        })
        admin.saveTaskResults(serverId, task.id, results)
        requireCompleted(results, `${definition.id} apply`)
        await successfulCommand(netdata, built.verifyApplied, 'applied-state verification')
        process.stdout.write(`[${definition.id}] applied; running saved revert plan...\n`)
      } catch (error) {
        applyError = error
        admin.saveTaskError(serverId, task.id, error)
        process.stdout.write(`[${definition.id}] apply failed; attempting rollback...\n`)
      }
      admin.markTaskReverting(serverId, task.id)
      try {
        const revertResults = await admin.revertTask({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          taskId: task.id,
          approve: async () => true,
          onResult: result => admin.appendTaskRevertResult(serverId, task.id, result)
        })
        admin.saveTaskRevertResults(serverId, task.id, revertResults)
        requireCompleted(revertResults, `${definition.id} revert`)
        await successfulCommand(netdata, built.verifyReverted, 'reverted-state verification')
      } catch (error) {
        admin.saveTaskRevertError(serverId, task.id, error)
        throw error
      }
      const after = await successfulCommand(netdata, built.stateProbe, 'final state probe')
      if (after.stdout !== before.stdout) {
        throw new Error(`${definition.id} state fingerprint differs after revert`)
      }
      if (applyError) throw applyError
      process.stdout.write(`[${definition.id}] PASS: applied, reverted, and state fingerprint restored.\n`)
    }
  }
} finally {
  await session.close()
}

process.stdout.write('Remote validation completed successfully.\n')

async function successfulCommand (netdata, command, label) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 300 })
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit ${result.exitCode}`)
  return result
}

function requireCompleted (results, label) {
  if (!results.length || results.some(result => result.status !== 'completed')) {
    throw new Error(`${label} did not complete every command`)
  }
}

function requireNetdataMonitoringPlan (plan) {
  if (!plan.commands.length) throw new Error('planner smoke task returned no report commands')
  if (plan.commands.some(item => !item.command.includes('127.0.0.1:19999/api/v3/'))) {
    throw new Error('planner smoke task bypassed Netdata for monitoring data')
  }
  if (plan.commands.some(item => /^\s*(?:sh|bash)\s+-c\b/u.test(item.command))) {
    throw new Error('planner smoke task added an unnecessary nested shell')
  }
}

function requireUsefulNetdataResults (results) {
  if (results.some(item => item.result?.stdout?.includes('"status":"unavailable"'))) {
    throw new Error('planner smoke task hid a failed Netdata query behind an unavailable fallback')
  }
}

function singleLine (value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
}

function elevationFor (capabilities, sudoPassword) {
  if (capabilities.isRoot) return { elevation: 'root' }
  if (capabilities.hasPasswordlessSudo) return { elevation: 'sudo-n' }
  if (capabilities.hasSudo) return { elevation: 'sudo-password', sudoPassword }
  return null
}
