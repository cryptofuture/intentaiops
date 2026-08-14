#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask, commonTaskEligibility, listCommonTasks } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const APPLICATIONS = new Map([
  ['wordpress-linux', { port: 18101, marker: 'WEBMINAI_WORDPRESS_OK' }],
  ['woocommerce-linux', { port: 18102, marker: 'WEBMINAI_WOOCOMMERCE_OK' }],
  ['joomla-linux', { port: 18103, marker: 'WEBMINAI_JOOMLA_OK' }],
  ['drupal-linux', { port: 18104, marker: 'WEBMINAI_DRUPAL_OK' }],
  ['prestashop-linux', { port: 18105, marker: 'WEBMINAI_PRESTASHOP_OK' }],
  ['moodle-linux', { port: 18106, marker: 'WEBMINAI_MOODLE_OK', path: '/webminai-health.txt' }],
  ['magento-linux', { port: 18108, marker: 'WEBMINAI_MAGENTO_OK' }],
  ['n8n-linux', { port: 18109, marker: 'WEBMINAI_N8N_OK' }],
  ['ghost-linux', { port: 18110, marker: 'WEBMINAI_GHOST_OK' }],
  ['mattermost-linux', { port: 18111, marker: 'WEBMINAI_MATTERMOST_OK' }],
  ['odoo-linux', { port: 18112, marker: 'WEBMINAI_ODOO_OK' }],
  ['jellyfin-linux', { port: 18113, marker: 'WEBMINAI_JELLYFIN_OK' }],
  ['home-assistant-linux', { port: 18115, marker: 'WEBMINAI_HOME_ASSISTANT_OK' }]
])

const selected = process.argv.find(argument => argument.startsWith('--task='))?.slice('--task='.length) ?? null
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: validate-ismet-common-tasks.js [--task=CATALOG_ID]\n')
  process.exit(0)
}
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')

const serverId = process.env.WEBMINAI_TEST_SERVER ?? 'ismet'
const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId })
const credential = server.sshCredential ?? process.env.SSH_HOST_1
const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
  authentication: server.authentication,
  credential
})

try {
  const admin = new AdminService({ dataRoot, settings: settingsStore, ssh: session.ssh })
  const inventory = await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId })
  const applicationDefaults = await settingsStore.decryptApplicationDefaults({ settings, passphrase: process.env.VAULT_TEST })
  const options = {
    platform: 'linux',
    inventory,
    linuxContext: inventory.webminaiLinuxContext,
    docker: inventory.webminaiDocker,
    applicationDefaults
  }
  assert.equal(inventory.webminaiDocker.preferred, true, 'ismet must select the Docker Compose route')
  assert.equal(inventory.webminaiDocker.ready, true, 'ismet Docker Engine and Compose must be ready')

  const definitions = listCommonTasks({ category: 'application', platform: 'linux', ...options })
    .filter(definition => selected === null || definition.id === selected)
  if (definitions.length === 0) throw new Error(`unknown Linux application common task: ${selected}`)

  for (const definition of definitions) {
    const eligibility = commonTaskEligibility(definition.id, options)
    if (!eligibility.eligible) throw new Error(`${definition.id} unexpectedly became ineligible: ${eligibility.reason}`)
    await recoverIncompleteTasks(admin, definition.id, options)
    await validateLifecycle(admin, definition, options)
  }
} finally {
  await session.close()
}

async function recoverIncompleteTasks (admin, catalogId, options) {
  const incomplete = admin.listTasks(serverId, { limit: 100 })
    .filter(task => task.catalogId === catalogId && !['cancelled', 'completed', 'reverted'].includes(task.status))
  for (const summary of incomplete) {
    const task = admin.getTask(serverId, summary.id)
    if (!task.plan?.revertCommands?.length) continue
    process.stdout.write(`[${catalogId}] recovering task #${task.id} (${task.status})\n`)
    if (task.status === 'revert_failed') {
      const current = buildCommonTask(catalogId, task.id, options)
      if (current.verifyReverted) {
        const observed = await admin.netdata(server).runCommand(current.verifyReverted, { timeoutSeconds: 300 })
        if (observed.exitCode === 0) {
          admin.saveTaskRevertResults(serverId, task.id, [{ id: 'verify-recovered-state', status: 'completed', result: observed }])
          process.stdout.write(`[${catalogId}] task #${task.id} was already clean; history reconciled\n`)
          continue
        }
      }
    }
    admin.markTaskReverting(serverId, task.id)
    const results = await admin.revertTask({
      settings,
      passphrase: process.env.VAULT_TEST,
      serverId,
      taskId: task.id,
      approve: async () => true
    })
    admin.saveTaskRevertResults(serverId, task.id, results)
    requireCompleted(results, `${catalogId} recovery`)
  }
}

async function validateLifecycle (admin, definition, options) {
  const task = admin.createTask(serverId, `Validate ismet common task: ${definition.label}`, {
    kind: 'catalog',
    catalogId: definition.id
  })
  const built = buildCommonTask(definition.id, task.id, options)
  admin.saveTaskPlan(serverId, task.id, built.plan)
  const netdata = admin.netdata(server)
  const baseline = await probe(netdata, built.stateProbe, `${definition.id} initial baseline`)
  process.stdout.write(`\n[${definition.id}] task #${task.id}: apply 1/2\n`)
  let reverted = false
  try {
    admin.markTaskRunning(serverId, task.id)
    const first = await execute(admin, task.id, built.plan, 'apply 1')
    await verifyApplied(netdata, built, definition.id)
    await verifyExternal(definition.id, true)
    const applied = await probe(netdata, built.stateProbe, `${definition.id} applied state`)

    process.stdout.write(`[${definition.id}] apply 2/2\n`)
    const second = await execute(admin, task.id, built.plan, 'apply 2')
    admin.saveTaskResults(serverId, task.id, [...first, ...second])
    await verifyApplied(netdata, built, definition.id)
    await verifyExternal(definition.id, true)
    assert.equal(await probe(netdata, built.stateProbe, `${definition.id} second applied state`), applied, `${definition.id} second apply changed managed state`)

    process.stdout.write(`[${definition.id}] restart recovery\n`)
    await restartManagedRuntime(netdata, definition.id, built.plan)
    await verifyApplied(netdata, built, definition.id)
    await verifyExternal(definition.id, true)

    process.stdout.write(`[${definition.id}] revert 1/2\n`)
    admin.markTaskReverting(serverId, task.id)
    const firstRevert = await revert(admin, task.id, 'revert 1')
    await verifyReverted(netdata, built, definition.id)
    await verifyExternal(definition.id, false)
    const revertedState = await probe(netdata, built.stateProbe, `${definition.id} reverted state`)

    process.stdout.write(`[${definition.id}] revert 2/2\n`)
    const secondRevert = await revert(admin, task.id, 'revert 2')
    await verifyReverted(netdata, built, definition.id)
    await verifyExternal(definition.id, false)
    assert.equal(await probe(netdata, built.stateProbe, `${definition.id} second reverted state`), revertedState, `${definition.id} second revert changed managed state`)
    assert.equal(revertedState, baseline, `${definition.id} did not restore its exact baseline`)
    admin.saveTaskRevertResults(serverId, task.id, [...firstRevert, ...secondRevert])
    reverted = true
    process.stdout.write(`[${definition.id}] PASS: two applies, restart recovery, two reverts, exact baseline\n`)
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    if (!reverted && built.plan.revertCommands.length > 0 && process.env.WEBMINAI_KEEP_FAILED !== '1') {
      process.stderr.write(`[${definition.id}] failure; attempting task-owned cleanup\n`)
      try {
        admin.markTaskReverting(serverId, task.id)
        const cleanup = await admin.revertTask({
          settings,
          passphrase: process.env.VAULT_TEST,
          serverId,
          taskId: task.id,
          approve: async () => true
        })
        admin.saveTaskRevertResults(serverId, task.id, cleanup)
      } catch (cleanupError) {
        admin.saveTaskRevertError(serverId, task.id, cleanupError)
        process.stderr.write(`[${definition.id}] cleanup failed: ${cleanupError.message}\n`)
      }
    }
    throw error
  }
}

async function execute (admin, taskId, plan, label) {
  const results = await admin.execute({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId,
    plan,
    approve: async () => true,
    onResult: result => {
      admin.appendTaskResult(serverId, taskId, result)
      process.stdout.write(`  ${result.id}: ${result.status}\n`)
    }
  })
  requireCompleted(results, label)
  return results
}

async function revert (admin, taskId, label) {
  const results = await admin.revertTask({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId,
    taskId,
    approve: async () => true,
    onResult: result => {
      admin.appendTaskRevertResult(serverId, taskId, result)
      process.stdout.write(`  ${result.id}: ${result.status}\n`)
    }
  })
  requireCompleted(results, label)
  return results
}

async function verifyApplied (netdata, built, catalogId) {
  if (!built.verifyApplied) return
  let result
  for (let attempt = 0; attempt < 90; attempt++) {
    result = await netdata.runCommand(built.verifyApplied, { timeoutSeconds: 300 })
    if (result.exitCode === 0) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  assert.equal(result.exitCode, 0, `${catalogId} applied verification failed: ${String(result.stderr || result.stdout).trim().slice(0, 1000)}`)
}

async function verifyReverted (netdata, built, catalogId) {
  if (!built.verifyReverted) return
  const result = await netdata.runCommand(built.verifyReverted, { timeoutSeconds: 300 })
  assert.equal(result.exitCode, 0, `${catalogId} reverted verification failed`)
}

async function probe (netdata, command, label) {
  if (!command) return ''
  const result = await netdata.runCommand(command, { timeoutSeconds: 300 })
  assert.equal(result.exitCode, 0, `${label} failed`)
  return result.stdout
}

async function restartManagedRuntime (netdata, catalogId, plan) {
  if (catalogId === 'docker-linux') {
    const result = await netdata.runJob('set -eu; systemctl restart docker.service; docker info >/dev/null; docker compose version >/dev/null', { timeoutSeconds: 600 })
    assert.equal(result.exitCode, 0, 'Docker restart recovery failed')
    return
  }
  const project = composeProject(plan)
  const service = catalogId.slice(0, -'-linux'.length)
  const command = `set -eu; cd '/opt/webminai/services/${service}'; docker compose -p '${project}' restart >/dev/null`
  const result = await netdata.runJob(command, { timeoutSeconds: 900 })
  assert.equal(result.exitCode, 0, `${catalogId} Compose restart failed`)
}

function composeProject (plan) {
  const commands = [...plan.commands, ...plan.revertCommands].map(item => item.command).join('\n')
  const match = commands.match(/docker compose -p '([^']+)'/u)
  if (!match) throw new Error('could not determine the reviewed Compose project name')
  return match[1]
}

async function verifyExternal (catalogId, shouldExist) {
  const application = APPLICATIONS.get(catalogId)
  if (!application) return
  const hostname = new URL(server.connectionUrl).hostname
  const url = `http://${hostname}:${application.port}${application.path ?? '/'}`
  let lastError = null
  for (let attempt = 0; attempt < (shouldExist ? 90 : 8); attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const body = await response.text()
      const found = response.ok && body.includes(application.marker)
      if (found === shouldExist) return
      lastError = new Error(`HTTP ${response.status} marker=${found}`)
    } catch (error) {
      if (!shouldExist) return
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`${catalogId} external verification failed at ${url}: ${lastError?.message ?? 'unknown error'}`)
}

function requireCompleted (results, label) {
  const failed = results.find(result => result.status !== 'completed')
  if (!failed) return
  throw new Error(`${label} failed at ${failed.id}: ${failed.failure?.code ?? failed.status}${failed.failure?.evidence ? ` (${failed.failure.evidence})` : ''}`)
}
