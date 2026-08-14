#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { runProcess } from '../src/process-runner.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const SERVER_ID = process.env.WEBMINAI_TEST_SERVER ?? 'windows-11'
const CATALOG_IDS = new Set([
  'host-health-windows',
  'system-update-windows',
  'brave-windows',
  'docker-desktop-windows'
])

async function main () {
  const catalogId = process.argv[2]
  if (!CATALOG_IDS.has(catalogId)) {
    throw new Error(`usage: validate-windows-common-tasks.js [${[...CATALOG_IDS].join('|')}]`)
  }
  if (!process.env.VAULT_TEST || !(process.env.SSH_HOST_PWD || process.env.SSH_HOST_1)) {
    throw new Error('VAULT_TEST and SSH_HOST_PWD (or SSH_HOST_1) are required')
  }

  const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
  const settingsStore = new SettingsStore(dataRoot)
  const settings = await settingsStore.load()
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID })
  const environment = {
    ...process.env,
    SSH_HOST_1: process.env.SSH_HOST_PWD ?? process.env.SSH_HOST_1,
    SSH_ASKPASS: path.resolve('scripts/webminai-askpass.sh'),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: 'webminai-askpass'
  }
  const baseSsh = new SystemSsh({
    interactiveRunner: (command, args, options = {}) => runProcess('setsid', ['-w', command, ...args], { ...options, env: environment }),
    terminalCheck: () => true
  })
  const session = await baseSsh.openInteractiveSession(server.connectionUrl, { authentication: server.authentication ?? 'password' })

  try {
    const admin = new AdminService({ dataRoot, ssh: session.ssh, settings: settingsStore })
    const inventory = await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID })
    assert.equal(inventory.webminaiExecution?.platform, 'windows')
    const task = admin.createTask(SERVER_ID, `Live regression validation for ${catalogId}.`, { kind: 'catalog', catalogId })
    const built = buildCommonTask(catalogId, task.id, {
      platform: 'windows',
      inventory,
      windowsExecution: inventory.webminaiExecution,
      docker: inventory.webminaiDocker
    })
    admin.saveTaskPlan(SERVER_ID, task.id, built.plan)
    if (built.plan.revertCommands.length === 0) {
      await runOneWay(admin, settings, task, built)
    } else {
      await runReversible(admin, settings, server, task, built)
    }
  } finally {
    await session.close()
  }
}

async function runOneWay (admin, settings, task, built) {
  try {
    admin.markTaskRunning(SERVER_ID, task.id)
    const results = await execute(admin, settings, built.plan, 'execute', false)
    requireCompleted(results, built.definition.id)
    admin.saveTaskResults(SERVER_ID, task.id, results)
    const evidence = results.map(result => `${result.id}:${result.status}`).join(', ')
    process.stdout.write(`PASS ${built.definition.id} task #${task.id}: ${evidence}\n`)
  } catch (error) {
    admin.saveTaskError(SERVER_ID, task.id, error)
    throw error
  }
}

async function runReversible (admin, settings, server, task, built) {
  const netdata = admin.netdata(server)
  const baseline = await probe(netdata, built.stateProbe)
  let applied = false
  try {
    admin.markTaskRunning(SERVER_ID, task.id)
    const apply1 = await execute(admin, settings, built.plan, 'apply-1')
    requireCompleted(apply1, 'first apply')
    applied = true
    await verify(netdata, built.verifyApplied, 300)
    const firstState = await probe(netdata, built.stateProbe)

    const apply2 = await execute(admin, settings, built.plan, 'apply-2')
    requireCompleted(apply2, 'second apply')
    assert.equal(await probe(netdata, built.stateProbe), firstState, 'second apply changed the managed state')
    await verify(netdata, built.verifyApplied, 300)
    admin.saveTaskResults(SERVER_ID, task.id, apply2)

    admin.markTaskReverting(SERVER_ID, task.id)
    const revertPlan = { ...built.plan, summary: `Revert ${built.plan.summary}`, commands: built.plan.revertCommands, revertCommands: [] }
    const revert1 = await execute(admin, settings, revertPlan, 'revert-1', false)
    requireCompleted(revert1, 'first revert')
    await verify(netdata, built.verifyReverted, 120)
    const revertedState = await probe(netdata, built.stateProbe)

    const revert2 = await execute(admin, settings, revertPlan, 'revert-2', false)
    requireCompleted(revert2, 'second revert')
    assert.equal(await probe(netdata, built.stateProbe), revertedState, 'second revert changed the managed state')
    assert.equal(revertedState, baseline, 'revert did not restore the exact baseline')
    admin.saveTaskRevertResults(SERVER_ID, task.id, revert2)
    process.stdout.write(`PROMOTION_READY ${built.definition.id} task #${task.id}: two applies, verification, two reverts, exact baseline.\n`)
  } catch (error) {
    if (applied) await bestEffortCleanup(admin, settings, task, built)
    admin.saveTaskError(SERVER_ID, task.id, error)
    throw error
  }
}

async function bestEffortCleanup (admin, settings, task, built) {
  try {
    const revertPlan = { ...built.plan, commands: built.plan.revertCommands, revertCommands: [] }
    const results = await execute(admin, settings, revertPlan, 'failure-cleanup', false)
    requireCompleted(results, 'failure cleanup')
    admin.saveTaskRevertResults(SERVER_ID, task.id, results)
  } catch (error) {
    admin.saveTaskRevertError(SERVER_ID, task.id, error)
    process.stderr.write(`CLEANUP_FAILED task #${task.id}: ${error.message}\n`)
  }
}

async function execute (admin, settings, plan, label, requireRevert = true) {
  return admin.execute({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId: SERVER_ID,
    plan,
    requireRevert,
    approve: async () => true,
    onResult: result => process.stdout.write(`[${label}:${result.id}] ${result.status}\n`)
  })
}

async function probe (netdata, command) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 120 })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
  return result.stdout.trim()
}

async function verify (netdata, command, timeoutSeconds) {
  const result = await netdata.runCommand(command, { timeoutSeconds })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
}

function requireCompleted (results, label) {
  const failed = results?.find(result => result.status !== 'completed')
  if (!Array.isArray(results) || results.length === 0 || failed) {
    throw new Error(`${label} failed: ${failed?.result?.stderr?.trim() || failed?.result?.stdout?.trim() || failed?.status || 'no results'}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
