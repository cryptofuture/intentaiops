#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask, commonTaskEligibility, listCommonTasks } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const HOSTS = ['webminai-freebsd-14-4', 'webminai-freebsd-15-1']
const APPLICATIONS = new Map([
  ['wordpress-freebsd', { port: 18101, marker: 'WEBMINAI_WORDPRESS_FREEBSD_OK' }],
  ['woocommerce-freebsd', { port: 18102, marker: 'WEBMINAI_WOOCOMMERCE_OK', path: '/product/webminai-woocommerce-product/' }],
  ['joomla-freebsd', { port: 18103, marker: 'WEBMINAI_JOOMLA_OK' }],
  ['drupal-freebsd', { port: 18104, marker: 'WEBMINAI_DRUPAL_OK' }],
  ['prestashop-freebsd', { port: 18105, marker: 'WEBMINAI_PRESTASHOP_OK' }],
  ['moodle-freebsd', { port: 18106, marker: 'WEBMINAI_MOODLE_OK', path: '/webminai-health.txt' }],
  ['nextcloud-freebsd', { port: 18107, marker: 'WEBMINAI_NEXTCLOUD_OK', path: '/webminai-health.txt' }],
  ['magento-freebsd', { port: 18108, marker: 'WEBMINAI_MAGENTO_OK' }],
  ['n8n-freebsd', { port: 18109, marker: 'WEBMINAI_N8N_OK' }],
  ['ghost-freebsd', { port: 18110, marker: 'WEBMINAI_GHOST_OK' }],
  ['mattermost-freebsd', { port: 18111, marker: 'WEBMINAI_MATTERMOST_OK' }],
  ['odoo-freebsd', { port: 18112, marker: 'WEBMINAI_ODOO_OK' }],
  ['jellyfin-freebsd', { port: 18113, marker: 'WEBMINAI_JELLYFIN_OK' }],
  ['home-assistant-freebsd', { port: 18115, marker: 'WEBMINAI_HOME_ASSISTANT_OK' }]
])

const selectedHost = option('host')
const selectedTask = option('task')
const selectedResumeTask = option('resume-task')
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: validate-freebsd-common-tasks.js [--host=SERVER_ID] [--task=CATALOG_ID] [--resume-task=ID]\n')
  process.exit(0)
}
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
if (selectedHost && !HOSTS.includes(selectedHost)) throw new Error(`unknown FreeBSD host: ${selectedHost}`)
if (selectedResumeTask && (!selectedHost || !selectedTask || !/^\d+$/u.test(selectedResumeTask))) throw new Error('--resume-task requires one --host and --task')

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()

for (const serverId of selectedHost ? [selectedHost] : HOSTS) await validateHost(serverId)

async function validateHost (serverId) {
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId })
  const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
    authentication: server.authentication,
    credential: server.sshCredential
  })
  try {
    const admin = new AdminService({ dataRoot, settings: settingsStore, ssh: session.ssh })
    const inventory = await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId })
    const options = {
      platform: 'freebsd',
      inventory,
      freebsdExecution: inventory.webminaiExecution,
      docker: inventory.webminaiDocker,
      applicationDefaults: await settingsStore.decryptApplicationDefaults({ settings, passphrase: process.env.VAULT_TEST })
    }
    assert.equal(options.freebsdExecution?.platform, 'freebsd')
    const all = listCommonTasks({ platform: 'freebsd' })
    const definitions = all.filter(definition => {
      if (selectedTask && definition.id !== selectedTask) return false
      return commonTaskEligibility(definition.id, options).eligible
    })
    if (selectedTask && !all.some(definition => definition.id === selectedTask)) throw new Error(`unknown FreeBSD common task: ${selectedTask}`)
    if (selectedTask && definitions.length === 0) {
      const eligibility = commonTaskEligibility(selectedTask, options)
      throw new Error(`${selectedTask} is ineligible on ${serverId}: ${eligibility.reason}`)
    }
    process.stdout.write(`\n${serverId} ${options.freebsdExecution.freebsdVersion}: validating ${definitions.length} eligible common tasks\n`)
    for (const definition of definitions) {
      if (!selectedResumeTask) await recoverIncomplete(admin, server, serverId, definition.id, options)
      if (definition.category === 'diagnostic') await validateReadOnly(admin, serverId, definition, options)
      else if (definition.category === 'maintenance') await validateOneWay(admin, serverId, definition, options)
      else await validateLifecycle(admin, server, serverId, definition, options, selectedResumeTask ? Number(selectedResumeTask) : null)
    }
  } finally {
    await session.close()
  }
}

async function recoverIncomplete (admin, server, serverId, catalogId, options) {
  const tasks = admin.listTasks(serverId, { limit: 100 }).filter(task =>
    task.catalogId === catalogId && task.request.startsWith('Validate FreeBSD common task:') && !['cancelled', 'reverted'].includes(task.status)
  )
  for (const summary of tasks) {
    const task = admin.getTask(serverId, summary.id)
    if (!task.plan?.revertCommands?.length) continue
    const built = buildCommonTask(catalogId, task.id, options)
    if (built.verifyReverted) {
      const result = await admin.netdata(server).runCommand(built.verifyReverted, { timeoutSeconds: 300 })
      if (result.exitCode === 0) {
        admin.saveTaskRevertResults(serverId, task.id, [{ id: 'verify-recovered-state', status: 'completed', result }])
        continue
      }
    }
    process.stdout.write(`[${serverId}/${catalogId}] recovering task #${task.id}\n`)
    admin.markTaskReverting(serverId, task.id)
    const results = await revert(admin, serverId, task.id, 'recovery')
    admin.saveTaskRevertResults(serverId, task.id, results)
  }
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

async function validateLifecycle (admin, server, serverId, definition, options, resumeTaskId = null) {
  const task = resumeTaskId ? admin.getTask(serverId, resumeTaskId) : create(admin, serverId, definition)
  if (resumeTaskId && task.catalogId !== definition.id) throw new Error(`task #${resumeTaskId} is not ${definition.id}`)
  const built = buildCommonTask(definition.id, task.id, options)
  admin.saveTaskPlan(serverId, task.id, built.plan)
  const netdata = admin.netdata(server)
  const baseline = resumeTaskId ? 'absent' : await probe(netdata, built.stateProbe, 'initial baseline')
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
    process.stdout.write(`[${serverId}/${definition.id}] PASS: two applies, restart verification, two reverts, exact baseline\n`)
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
  return admin.createTask(serverId, `Validate FreeBSD common task: ${definition.label}`, { kind: 'catalog', catalogId: definition.id })
}

async function execute (admin, serverId, taskId, plan, label, requireRevert = true) {
  const results = await admin.execute({
    settings,
    passphrase: process.env.VAULT_TEST,
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
  const application = APPLICATIONS.get(catalogId)
  if (!application) return
  const host = new URL(server.connectionUrl).hostname
  const url = `http://${host}:${application.port}${application.path ?? '/'}`
  let evidence = 'no response'
  for (let attempt = 0; attempt < (shouldExist ? 90 : 6); attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const body = await response.text()
      const found = response.ok && body.includes(application.marker)
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
