#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask, commonTaskEligibility, listCommonTasks } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { SystemSsh } from '../src/system-ssh.js'
import { planFingerprint } from '../src/execution-journal.js'

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
const resumedValidation = option('resume-validation')
const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
let settingsStore
let settings
let workspace
let passphrase
let applicationDefaults

async function main () {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: validate-linux-common-tasks.js [--host=SERVER_ID] [--task=CATALOG_ID] [--resume-validation=TASK_ID]\nResume is limited to completed, operator-recovered n8n tasks with a saved validation baseline.\n')
    return
  }
  if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
  if (process.argv.includes('--resume-validation')) throw new Error('use --resume-validation=TASK_ID')
  if (selectedHost && !HOSTS.includes(selectedHost)) throw new Error(`unknown Linux lab host: ${selectedHost}`)
  if (resumedValidation !== null) assert.ok(selectedHost && selectedTask === 'n8n-linux' && Number.isSafeInteger(Number(resumedValidation)) && Number(resumedValidation) > 0, 'resume-validation requires one host, n8n-linux and a positive task ID')
  settingsStore = new SettingsStore(dataRoot)
  settings = await settingsStore.load()
  workspace = new ServerWorkspace(dataRoot, {
    directoryAliases: new Map(Object.entries(settings.servers).map(([id, server]) => [id, server.historyId ?? id]))
  })
  passphrase = process.env.VAULT_TEST
  applicationDefaults = await settingsStore.decryptApplicationDefaults({ settings, passphrase })
  for (const serverId of selectedHost ? [selectedHost] : HOSTS) await validateHost(serverId)
}

async function validateHost (serverId) {
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
    authentication: server.authentication,
    credential: server.sshCredential
  })
  let installSource
  let finished = false
  try {
    const admin = new AdminService({ dataRoot, settings: settingsStore, ssh: session.ssh, workspace })
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
      if (resumedValidation === null) await recoverIncomplete(admin, server, serverId, definition.id, options)
      if (definition.id === 'intent-ai-ops-linux') {
        installSource = await stageInstallSource(session.ssh, server.connectionUrl)
        options.intentAiOpsInstallSource = installSource
      }
      if (definition.category === 'diagnostic') await validateReadOnly(admin, serverId, definition, options)
      else if (definition.category === 'maintenance') await validateOneWay(admin, serverId, definition, options)
      else await validateLifecycle(admin, server, serverId, definition, options)
    }
    finished = true
  } finally {
    try {
      if (finished && installSource) await session.ssh.execute(server.connectionUrl, `rm -f -- '${installSource.installerPath}' '${installSource.packageUrl}'; rmdir '${path.posix.dirname(installSource.installerPath)}'`)
    } finally { await session.close() }
  }
}

export async function stageInstallSource (ssh, connectionUrl) {
  const result = await ssh.execute(connectionUrl, 'umask 077; mktemp -d /tmp/webminai.XXXXXXXX')
  const directory = result.stdout.trim()
  assert.match(directory, /^\/tmp\/webminai\.[A-Za-z0-9]+$/u)
  const source = { installerPath: `${directory}/install.sh`, packageUrl: `${directory}/intent-ai-ops.tgz` }
  await ssh.copy(connectionUrl, fileURLToPath(new URL('./install.sh', import.meta.url)), source.installerPath)
  await ssh.copy(connectionUrl, fileURLToPath(new URL('../dist/intent-ai-ops.tgz', import.meta.url)), source.packageUrl)
  return source
}

export async function recoverIncomplete (admin, server, serverId, catalogId, options) {
  const tasks = admin.listTasks(serverId, { limit: 100 }).filter(task =>
    task.catalogId === catalogId && task.request.startsWith('Validate Linux common task:') && task.status !== 'cancelled'
  )
  for (const summary of tasks) {
    const task = admin.getTask(serverId, summary.id)
    if (!task.plan?.revertCommands?.length) continue
    if (admin.tasks.executionState(serverId, task.id).some(command => command.status === 'uncertain')) {
      throw new Error(`task #${task.id} has an uncertain outcome; reconcile remote evidence before further validation`)
    }
    const built = buildCommonTask(catalogId, task.id, options)
    if (built.verifyReverted) {
      const statePaths = (task.plan.modifiedFiles ?? []).filter(file => file.startsWith('/var/lib/webminai/task-state/'))
      const absent = statePaths.map(file => `test ! -e '${file.replaceAll("'", "'\\''")}'`).join(' && ')
      const clean = await admin.netdata(server).runCommand(`${built.verifyReverted}${absent ? ` && ${absent}` : ''}`, { timeoutSeconds: 300 })
      if (clean.exitCode === 0) {
        admin.saveTaskRevertResults(serverId, task.id, [{ id: 'verify-recovered-state', status: 'completed', result: clean }])
        continue
      }
    }
    throw new Error(`task #${task.id} needs a separately reviewed rollback before further validation`)
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

async function validateLifecycle (admin, server, serverId, definition, options) {
  const resuming = resumedValidation !== null
  const task = resuming ? admin.getTask(serverId, Number(resumedValidation)) : create(admin, serverId, definition)
  assert.equal(task.catalogId, definition.id)
  const built = buildCommonTask(definition.id, task.id, options)
  if (!resuming) admin.saveTaskPlan(serverId, task.id, built.plan)
  const confirmed = resuming ? completedValidationResults(task, admin.tasks.executionState(serverId, task.id), admin.tasks.rollbackState(serverId, task.id), built.plan) : null
  if (resuming) assert.ok(!admin.listTasks(serverId).some(item => item.status === 'running'), 'another validation is running on this host')
  const netdata = admin.netdata(server)
  const baseline = definition.id === 'n8n-linux'
    ? await validationBaseline(dataRoot, { serverId, taskId: task.id, plan: built.plan, baseline: resuming ? undefined : await probe(netdata, built.stateProbe, 'initial baseline') })
    : await probe(netdata, built.stateProbe, 'initial baseline')
  let cleanupRequired = false
  try {
    process.stdout.write(`[${serverId}/${definition.id}] task #${task.id}: apply 1/2\n`)
    if (!resuming) admin.markTaskRunning(serverId, task.id)
    cleanupRequired = true
    if (resuming) process.stdout.write('  Using confirmed recovered apply 1; no completed command is replayed in the original task.\n')
    const first = confirmed ?? await execute(admin, serverId, task.id, built.plan, 'apply 1')
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

export async function execute (admin, serverId, taskId, plan, label, requireRevert = true) {
  const executionTask = label === 'apply 2'
    ? admin.createTask(serverId, `Reapply Linux validation task #${taskId}`, { kind: 'catalog', catalogId: admin.getTask(serverId, taskId).catalogId })
    : null
  const executionTaskId = executionTask?.id ?? taskId
  if (executionTask) {
    admin.saveTaskPlan(serverId, executionTaskId, plan)
    admin.markTaskRunning(serverId, executionTaskId)
  }
  const results = await admin.execute({
    settings,
    passphrase,
    serverId,
    taskId: executionTaskId,
    plan,
    requireRevert,
    approve: async () => true,
    onResult: result => {
      admin.appendTaskResult(serverId, executionTaskId, result)
      process.stdout.write(`  ${result.id}: ${result.status}\n`)
    }
  })
  if (executionTask) admin.saveTaskResults(serverId, executionTaskId, results)
  requireCompleted(results, label, plan.commands.length)
  return results
}

export async function revert (admin, serverId, taskId, label) {
  const task = admin.getTask(serverId, taskId)
  const reviewedPlan = label === 'revert 2'
    ? {
        ...task.plan,
        summary: `Verify repeat rollback for task #${taskId}`,
        changeOverview: 'Explicitly repeat the verified rollback to test idempotence after the first rollback restored the baseline.',
        commands: task.plan.revertCommands,
        revertCommands: []
      }
    : undefined
  const results = await admin.revertTask({
    settings,
    passphrase,
    serverId,
    taskId,
    reviewedPlan,
    approve: async () => true,
    onResult: result => {
      admin.appendTaskRevertResult(serverId, taskId, result)
      process.stdout.write(`  ${result.id}: ${result.status}\n`)
    }
  })
  requireCompleted(results, label, task.plan.revertCommands.length)
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

export function requireCompleted (results, label, expectedCount) {
  const failed = results.find(result => result.status !== 'completed')
  if (failed) throw new Error(`${label} failed at ${failed.id}: ${failed.failure?.code ?? failed.status}${failed.failure?.evidence ? ` (${failed.failure.evidence})` : ''}`)
  assert.equal(results.length, expectedCount, `${label}: execution paused or stopped before all reviewed commands completed`)
}

export function completedValidationResults (task, commands, rollback, expectedPlan) {
  assert.equal(task.catalogId, 'n8n-linux')
  assert.equal(task.status, 'completed', 'finish operator-reviewed recovery before resuming validation')
  assert.notEqual(task.plan.operatorRollback, true)
  assert.deepEqual(task.plan.modifiedFiles, expectedPlan.modifiedFiles, 'recovered plan changed managed paths')
  assert.deepEqual(task.plan.commands.map(command => command.command), expectedPlan.commands.map(command => command.command), 'recovered plan changed catalog commands')
  assert.equal(rollback.length, 0, 'rollback already started; create a fresh validation')
  assert.equal(commands.length, task.plan.commands.length)
  assert.ok(commands.every(command => command.status === 'completed'), 'uncertain or incomplete commands require operator review')
  assert.deepEqual(commands.map(command => command.commandId).sort(), task.plan.commands.map(command => command.id).sort())
  const resultsById = new Map((task.results ?? []).map(result => [result.id, result]))
  const results = task.plan.commands.map(command => resultsById.get(command.id))
  assert.ok(results.every(Boolean), 'confirmed command results are missing')
  requireCompleted(results, 'recovered apply 1', task.plan.commands.length)
  return results
}

export async function validationBaseline (root, { serverId, taskId, plan, baseline }) {
  assert.ok(HOSTS.includes(serverId) && Number.isSafeInteger(taskId) && taskId > 0)
  const fingerprint = planFingerprint({ commands: plan.commands, revertCommands: plan.revertCommands })
  const directory = path.join(root, 'lab-validation-baselines')
  const file = path.join(directory, `${serverId}-${taskId}.json`)
  if (baseline !== undefined) {
    assert.ok(typeof baseline === 'string' && baseline.length <= 65536)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify({ version: 1, serverId, taskId, fingerprint, modifiedFiles: plan.modifiedFiles, baseline }), { mode: 0o600, flag: 'wx' })
    return baseline
  }
  assert.ok((await stat(file)).size <= 131072, 'validation baseline exceeds its size limit')
  let saved
  try { saved = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('saved validation baseline is invalid') }
  assert.equal(saved.version, 1)
  assert.equal(saved.serverId, serverId)
  assert.equal(saved.taskId, taskId)
  assert.equal(saved.fingerprint, fingerprint, 'catalog commands changed; start a fresh validation')
  assert.deepEqual(saved.modifiedFiles, plan.modifiedFiles, 'managed paths changed; start a fresh validation')
  assert.ok(typeof saved.baseline === 'string' && saved.baseline.length <= 65536)
  return saved.baseline
}

function option (name) {
  return process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
