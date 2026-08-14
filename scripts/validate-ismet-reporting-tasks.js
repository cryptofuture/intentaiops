#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask, commonTaskEligibility, listCommonTasks } from '../src/common-tasks.js'
import { redactHealthText } from '../src/cli.js'
import { hostHealthProfile } from '../src/host-health-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { systemUpdateProfile } from '../src/system-update-task.js'

const SUPPORTED = new Set(['host-health-linux', 'system-update-linux'])
const catalogId = process.argv.find(argument => argument.startsWith('--task='))?.slice('--task='.length)
if (!SUPPORTED.has(catalogId)) throw new Error('use --task=host-health-linux or --task=system-update-linux')
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')

const serverId = process.env.WEBMINAI_TEST_SERVER ?? 'ismet'
const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId })
const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
  authentication: server.authentication,
  credential: server.sshCredential ?? process.env.SSH_HOST_1
})
let task = null

try {
  const admin = new AdminService({ dataRoot, settings: settingsStore, ssh: session.ssh })
  const inventory = await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId })
  const options = {
    platform: 'linux',
    inventory,
    linuxContext: inventory.webminaiLinuxContext,
    docker: inventory.webminaiDocker,
    applicationDefaults: await settingsStore.decryptApplicationDefaults({ settings, passphrase: process.env.VAULT_TEST })
  }
  const definition = listCommonTasks({ platform: 'linux', ...options }).find(item => item.id === catalogId)
  assert.ok(definition, `${catalogId} is not present in the Linux catalog`)
  const eligibility = commonTaskEligibility(catalogId, options)
  assert.equal(eligibility.eligible, true, eligibility.reason)

  task = admin.createTask(serverId, `Validate ismet common task: ${definition.label}`, { kind: 'catalog', catalogId })
  const built = buildCommonTask(catalogId, task.id, options)
  admin.saveTaskPlan(serverId, task.id, built.plan)
  admin.markTaskRunning(serverId, task.id)
  const results = await admin.execute({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId,
    plan: built.plan,
    approve: async () => true,
    requireRevert: false,
    onResult: result => {
      admin.appendTaskResult(serverId, task.id, result)
      process.stdout.write(`[${catalogId}] ${result.id}: ${result.status}\n`)
    }
  })
  const failed = results.find(result => result.status !== 'completed')
  if (failed) throw new Error(`${catalogId} failed at ${failed.id}: ${failed.failure?.code ?? failed.status}`)
  admin.saveTaskResults(serverId, task.id, results)

  const report = await admin.consult({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId,
    inventory: reportInventory(catalogId, inventory, results),
    consultationContext: [],
    question: reportQuestion(catalogId),
    onProgress: event => admin.appendTaskProgress(serverId, task.id, {
      ...event,
      message: redactHealthText(event.message)
    })
  })
  const safeAnswer = redactHealthText(report.answer)
  const safeSummary = redactHealthText(report.contextSummary)
  admin.appendTaskProgress(serverId, task.id, {
    at: new Date().toISOString(),
    type: catalogId === 'host-health-linux' ? 'health_report' : 'system_update_report',
    message: safeAnswer,
    contextSummary: safeSummary
  })
  if (catalogId === 'host-health-linux') {
    await admin.saveHealthContext(serverId, {
      ...hostHealthProfile('linux', inventory),
      observedAt: new Date().toISOString(),
      taskId: task.id,
      reportSummary: safeSummary
    })
  } else {
    await admin.saveUpdateContext(serverId, {
      ...systemUpdateProfile('linux'),
      observedAt: new Date().toISOString(),
      taskId: task.id,
      reportSummary: safeSummary
    })
  }
  process.stdout.write(`\n[${catalogId}] task #${task.id} PASS\n${safeAnswer}\n`)
} catch (error) {
  if (task) {
    const admin = new AdminService({ dataRoot, settings: settingsStore, ssh: session.ssh })
    admin.saveTaskError(serverId, task.id, error)
  }
  process.stderr.write(`${error.stack ?? error}\n`)
  throw error
} finally {
  await session.close()
}

function reportInventory (id, inventory, results) {
  const evidence = results.map(result => ({
    id: result.id,
    status: result.status,
    stdout: redactHealthText(result.result?.stdout).slice(0, 64 * 1024),
    stderr: redactHealthText(result.result?.stderr).slice(0, 16 * 1024)
  }))
  if (id === 'host-health-linux') {
    const sections = evidence.filter(item => item.id.startsWith('collect-health-'))
    return {
      ...inventory,
      webminaiHealthEvidence: {
        format: 'webminai-host-health-evidence',
        version: 1,
        platform: 'linux',
        collectedAt: new Date().toISOString(),
        source: 'approved read-only common task',
        profile: hostHealthProfile('linux', inventory),
        stdout: sections.map(item => `=== ${item.id} ===\n${item.stdout.slice(0, 48 * 1024)}`).join('\n').slice(0, 128 * 1024),
        stderr: sections.map(item => item.stderr ? `=== ${item.id} ===\n${item.stderr}` : '').filter(Boolean).join('\n').slice(0, 32 * 1024)
      }
    }
  }
  return {
    ...inventory,
    webminaiSystemUpdateEvidence: {
      format: 'webminai-system-update-evidence',
      version: 1,
      platform: 'linux',
      collectedAt: new Date().toISOString(),
      source: 'approved verified common task',
      profile: systemUpdateProfile('linux'),
      results: evidence
    }
  }
}

function reportQuestion (id) {
  if (id === 'host-health-linux') {
    return 'Prepare a concise decision-useful host health report from Netdata inventory and webminaiHealthEvidence. Cover overall health, immediate issues, load, CPU, memory, storage, swap, service and container reliability, recent errors, pending updates, reboot needs, monitoring gaps, and prioritized next actions. Distinguish confirmed observations from unavailable checks. Do not propose or execute commands or reproduce secrets.'
  }
  return 'Prepare a concise system-update completion report from webminaiSystemUpdateEvidence. State success, enumerate installed, updated, removed, skipped, or failed packages with versions where present, state that no reboot was performed, whether one is required, and whether a newer OS release is available. Do not confuse current-repository dist-upgrade with an OS release upgrade. Do not propose or execute commands or reproduce secrets.'
}
