#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask, commonTaskEligibility, listCommonTasks } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const HOSTS = [
  'webminai-almalinux-9',
  'webminai-alpine-323',
  'webminai-arch',
  'webminai-debian-13',
  'webminai-fedora-44',
  'webminai-opensuse-160',
  'webminai-oracle-9',
  'webminai-rocky-9',
  'webminai-ubuntu-2404'
]
const ENDPOINTS = new Map([
  ['nginx-static-site', { port: 18080, marker: 'WebminAI nginx task' }],
  ['wordpress-linux', { port: 18101, marker: 'WEBMINAI_WORDPRESS_OK' }],
  ['woocommerce-linux', { port: 18102, marker: 'WEBMINAI_WOOCOMMERCE_OK' }],
  ['joomla-linux', { port: 18103, marker: 'WEBMINAI_JOOMLA_OK' }],
  ['drupal-linux', { port: 18104, marker: 'WEBMINAI_DRUPAL_OK' }],
  ['prestashop-linux', { port: 18105, marker: 'WEBMINAI_PRESTASHOP_OK' }],
  ['moodle-linux', { port: 18106, marker: 'WEBMINAI_MOODLE_OK' }],
  ['magento-linux', { port: 18108, marker: 'WEBMINAI_MAGENTO_OK' }],
  ['n8n-linux', { port: 18109, marker: 'WEBMINAI_N8N_OK' }],
  ['ghost-linux', { port: 18110, marker: 'WEBMINAI_GHOST_OK' }],
  ['mattermost-linux', { port: 18111, marker: 'WEBMINAI_MATTERMOST_OK' }],
  ['odoo-linux', { port: 18112, marker: 'WEBMINAI_ODOO_OK' }],
  ['jellyfin-linux', { port: 18113, marker: 'WEBMINAI_JELLYFIN_OK' }]
])

const selectedHost = option('host')
const selectedTask = option('task')
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: validate-linux-common-tasks.js [--host=SERVER_ID] [--task=CATALOG_ID]\n')
  process.exit(0)
}
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
if (selectedHost && !HOSTS.includes(selectedHost)) throw new Error(`unknown Linux lab host: ${selectedHost}`)

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
const passphrase = process.env.VAULT_TEST
const applicationDefaults = await settingsStore.decryptApplicationDefaults({ settings, passphrase })

for (const serverId of selectedHost ? [selectedHost] : HOSTS) await validateHost(serverId)

async function validateHost (serverId) {
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
    authentication: server.authentication,
    credential: server.sshCredential
  })
  try {
    const admin = new AdminService({ dataRoot, settings: settingsStore, ssh: session.ssh })
    const inventory = await admin.refreshInventory({ settings, passphrase, serverId })
    const options = {
      platform: 'linux',
      inventory,
      linuxContext: inventory.webminaiLinuxContext,
      docker: inventory.webminaiDocker,
      applicationDefaults
    }
    assert.equal(options.linuxContext?.identity?.platform, 'linux')
    const all = listCommonTasks({ platform: 'linux' })
    const definitions = all.filter(definition => {
      if (selectedTask && definition.id !== selectedTask) return false
      return commonTaskEligibility(definition.id, options).eligible
    })
    if (selectedTask && !all.some(definition => definition.id === selectedTask)) throw new Error(`unknown Linux common task: ${selectedTask}`)
    if (selectedTask && definitions.length === 0) {
      const eligibility = commonTaskEligibility(selectedTask, options)
      throw new Error(`${selectedTask} is ineligible on ${serverId}: ${eligibility.reason}`)
    }
    const identity = options.linuxContext.identity
    process.stdout.write(`\n${serverId} ${identity.id} ${identity.versionId}: validating ${definitions.length} eligible common tasks\n`)
    for (const definition of definitions) {
      await recoverIncomplete(admin, server, serverId, definition.id, options)
      if (definition.category === 'diagnostic') await validateReadOnly(admin, serverId, definition, options)
      else if (definition.category === 'maintenance') await validateOneWay(admin, serverId, definition, options)
      else await validateLifecycle(admin, server, serverId, definition, options)
    }
  } finally {
    await session.close()
  }
}

async function recoverIncomplete (admin, server, serverId, catalogId, options) {
  const tasks = admin.listTasks(serverId, { limit: 100 }).filter(task =>
    task.catalogId === catalogId && task.request.startsWith('Validate Linux common task:') && task.status !== 'cancelled'
  )
  for (const summary of tasks) {
    const task = admin.getTask(serverId, summary.id)
    if (!task.plan?.revertCommands?.length) continue
    const built = buildCommonTask(catalogId, task.id, options)
    if (built.verifyReverted) {
      const clean = await admin.netdata(server).runCommand(built.verifyReverted, { timeoutSeconds: 300 })
      if (clean.exitCode === 0) {
        admin.saveTaskRevertResults(serverId, task.id, [{ id: 'verify-recovered-state', status: 'completed', result: clean }])
        continue
      }
    }
    process.stdout.write(`[${serverId}/${catalogId}] recovering task #${task.id}\n`)
    admin.markTaskReverting(serverId, task.id)
    const results = await executeRecoveryPlan(admin, serverId, task.id, built.plan.revertCommands)
    admin.saveTaskRevertResults(serverId, task.id, results)
  }
}

async function executeRecoveryPlan (admin, serverId, taskId, commands) {
  const plan = {
    summary: `Recover task #${taskId}`,
    changeOverview: 'Run the current reviewed rollback for an earlier interrupted validation task.',
    modifiedFiles: [],
    warnings: [],
    requiresConfirmation: true,
    commands,
    revertCommands: []
  }
  const results = await admin.execute({
    settings,
    passphrase,
    serverId,
    plan,
    requireRevert: false,
    approve: async () => true,
    onResult: result => {
      admin.appendTaskRevertResult(serverId, taskId, result)
      process.stdout.write(`  ${result.id}: ${result.status}\n`)
    }
  })
  requireCompleted(results, 'recovery')
  return results
}

async function validateReadOnly (admin, serverId, definition, options) {
  const task = create(admin, serverId, definition)
  const built = buildCommonTask(definition.id, task.id, options)
  admin.saveTaskPlan(serverId, task.id, built.plan)
  process.stdout.write(`[${serverId}/${definition.id}] task #${task.id}: read-only\n`)
  try {
    admin.markTaskRunning(serverId, task.id)
    const results = await execute(admin, serverId, task.id, built.plan, 'read-only', false)
    assert.equal(results.length, built.plan.commands.length)
    for (const result of results) assert.ok(String(result.result?.stdout ?? '').trim(), `${result.id} returned no evidence`)
    admin.saveTaskResults(serverId, task.id, results)
    process.stdout.write(`[${serverId}/${definition.id}] PASS\n`)
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    throw error
  }
}

async function validateOneWay (admin, serverId, definition, options) {
  const task = create(admin, serverId, definition)
  const built = buildCommonTask(definition.id, task.id, options)
  admin.saveTaskPlan(serverId, task.id, built.plan)
  process.stdout.write(`[${serverId}/${definition.id}] task #${task.id}: current-release update\n`)
  try {
    admin.markTaskRunning(serverId, task.id)
    const results = await execute(admin, serverId, task.id, built.plan, 'update', false)
    admin.saveTaskResults(serverId, task.id, results)
    process.stdout.write(`[${serverId}/${definition.id}] PASS\n`)
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    throw error
  }
}

async function validateLifecycle (admin, server, serverId, definition, options) {
  const task = create(admin, serverId, definition)
  const built = buildCommonTask(definition.id, task.id, options)
  admin.saveTaskPlan(serverId, task.id, built.plan)
  const netdata = admin.netdata(server)
  const baseline = await probe(netdata, built.stateProbe, 'initial baseline')
  let cleanupRequired = false
  try {
    process.stdout.write(`[${serverId}/${definition.id}] task #${task.id}: apply 1/2\n`)
    admin.markTaskRunning(serverId, task.id)
    cleanupRequired = true
    const first = await execute(admin, serverId, task.id, built.plan, 'apply 1')
    await verify(netdata, built.verifyApplied, `${definition.id} apply 1`)
    await verifyExternal(server, definition.id, true)
    const applied = await probe(netdata, built.stateProbe, 'applied state')

    process.stdout.write(`[${serverId}/${definition.id}] apply 2/2\n`)
    const second = await execute(admin, serverId, task.id, built.plan, 'apply 2')
    admin.saveTaskResults(serverId, task.id, [...first, ...second])
    await verify(netdata, built.verifyApplied, `${definition.id} apply 2`)
    await verifyExternal(server, definition.id, true)
    assert.equal(await probe(netdata, built.stateProbe, 'second applied state'), applied, 'second apply changed managed state')

    process.stdout.write(`[${serverId}/${definition.id}] revert 1/2\n`)
    admin.markTaskReverting(serverId, task.id)
    const firstRevert = await revert(admin, serverId, task.id, 'revert 1')
    await verify(netdata, built.verifyReverted, `${definition.id} revert 1`)
    await verifyExternal(server, definition.id, false)
    const reverted = await probe(netdata, built.stateProbe, 'reverted state')

    process.stdout.write(`[${serverId}/${definition.id}] revert 2/2\n`)
    const secondRevert = await revert(admin, serverId, task.id, 'revert 2')
    await verify(netdata, built.verifyReverted, `${definition.id} revert 2`)
    await verifyExternal(server, definition.id, false)
    assert.equal(await probe(netdata, built.stateProbe, 'second reverted state'), reverted, 'second revert changed managed state')
    assert.equal(reverted, baseline, 'revert did not restore exact baseline')
    admin.saveTaskRevertResults(serverId, task.id, [...firstRevert, ...secondRevert])
    cleanupRequired = false
    process.stdout.write(`[${serverId}/${definition.id}] PASS: two applies, two reverts, exact baseline\n`)
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    if (cleanupRequired && process.env.WEBMINAI_KEEP_FAILED !== '1') {
      process.stderr.write(`[${serverId}/${definition.id}] failure; attempting task-owned cleanup\n`)
      try {
        admin.markTaskReverting(serverId, task.id)
        const results = await revert(admin, serverId, task.id, 'failure cleanup')
        admin.saveTaskRevertResults(serverId, task.id, results)
      } catch (cleanupError) {
        admin.saveTaskRevertError(serverId, task.id, cleanupError)
        process.stderr.write(`[${serverId}/${definition.id}] cleanup failed: ${cleanupError.message}\n`)
      }
    }
    throw error
  }
}

function create (admin, serverId, definition) {
  return admin.createTask(serverId, `Validate Linux common task: ${definition.label}`, { kind: 'catalog', catalogId: definition.id })
}

async function execute (admin, serverId, taskId, plan, label, requireRevert = true) {
  const results = await admin.execute({
    settings,
    passphrase,
    serverId,
    plan,
    requireRevert,
    approve: async () => true,
    onResult: result => {
      admin.appendTaskResult(serverId, taskId, result)
      process.stdout.write(`  ${result.id}: ${result.status}\n`)
    }
  })
  requireCompleted(results, label)
  return results
}

async function revert (admin, serverId, taskId, label) {
  const results = await admin.revertTask({
    settings,
    passphrase,
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

async function verify (netdata, command, label) {
  if (!command) return
  const result = await netdata.runCommand(command, { timeoutSeconds: 300 })
  assert.equal(result.exitCode, 0, `${label}: ${String(result.stderr || result.stdout).trim().slice(0, 1200)}`)
}

async function probe (netdata, command, label) {
  if (!command) return ''
  const result = await netdata.runCommand(command, { timeoutSeconds: 300 })
  assert.equal(result.exitCode, 0, `${label}: ${String(result.stderr || result.stdout).trim().slice(0, 1200)}`)
  return result.stdout
}

async function verifyExternal (server, catalogId, shouldExist) {
  const endpoint = ENDPOINTS.get(catalogId)
  if (!endpoint) return
  const host = new URL(server.connectionUrl).hostname
  const url = `http://${host}:${endpoint.port}${endpoint.path ?? '/'}`
  let evidence = 'no response'
  for (let attempt = 0; attempt < (shouldExist ? 90 : 6); attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const body = await response.text()
      const found = response.ok && body.includes(endpoint.marker)
      if (found === shouldExist) return
      evidence = `HTTP ${response.status}, marker=${found}`
    } catch (error) {
      if (!shouldExist) return
      evidence = error.message
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`${catalogId} external verification failed at ${url}: ${evidence}`)
}

function requireCompleted (results, label) {
  const failed = results.find(result => result.status !== 'completed')
  if (!failed) return
  throw new Error(`${label} failed at ${failed.id}: ${failed.failure?.code ?? failed.status}${failed.failure?.evidence ? ` (${failed.failure.evidence})` : ''}`)
}

function option (name) {
  return process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
}
