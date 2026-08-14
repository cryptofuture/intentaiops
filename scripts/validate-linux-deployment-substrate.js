#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildValidationStages } from '../src/canary-scheduler.js'
import { buildBaselineCommands, buildFoundationRevertCommands, buildHttpHealthPhase, buildPackagePhase, buildSecretPhase, composeDeploymentPlan } from '../src/deployment-phases.js'
import { DeploymentScorecard } from '../src/deployment-scorecard.js'
import { buildDockerComposeProfilePlan } from '../src/docker-compose-profile.js'
import { validateLinuxStackProfiles } from '../src/linux-stack-profiles.js'
import { evaluatePromotionEvidence } from '../src/promotion-policy.js'
import { runProcess } from '../src/process-runner.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const LINUX_HOSTS = [
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
const ISMET = process.env.WEBMINAI_DOCKER_HOST ?? 'ismet'
const APP = 'substrate-validation'
const APP_ROOT = '/opt/webminai-substrate-validation'
const PORT = 18120
const MARKER = 'WEBMINAI_SUBSTRATE_OK'
const passphrase = process.env.VAULT_TEST
if (!passphrase) throw new Error('VAULT_TEST is required')
if (!process.env.SSH_HOST_1) throw new Error('SSH_HOST_1 is required for the ismet Docker validation host')

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
for (const serverId of [...LINUX_HOSTS, ISMET]) if (!settings.servers[serverId]) throw new Error(`deployment substrate host is missing: ${serverId}`)
const ssh = new SystemSsh({ controlPath: process.env.WEBMINAI_SSH_CONTROL_PATH })
const scorecard = new DeploymentScorecard(dataRoot)
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const askpassEnvironment = { ...process.env, SSH_ASKPASS: path.join(scriptDirectory, 'webminai-askpass.sh'), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'webminai-askpass' }
const passwordSsh = new SystemSsh({
  interactiveRunner: (command, args, options = {}) => runProcess('setsid', ['-w', command, ...args], { ...options, env: askpassEnvironment }),
  terminalCheck: () => true
})
const ismetServer = await settingsStore.decryptServer({ settings, passphrase, serverId: ISMET })
const ismetSession = await passwordSsh.openInteractiveSession(ismetServer.connectionUrl, { authentication: ismetServer.authentication ?? 'password' })
const admins = new Map(LINUX_HOSTS.map(serverId => [serverId, new AdminService({ dataRoot, settings: settingsStore, ssh })]))
admins.set(ISMET, new AdminService({ dataRoot, settings: settingsStore, ssh: ismetSession.ssh }))

try {
  await recoverIncompleteSubstrateTasks(ISMET)
  process.stdout.write('Refreshing typed Linux profiles through Stage 2...\n')
  const hosts = await parallelMap(LINUX_HOSTS, 3, async serverId => {
    const admin = admins.get(serverId)
    const inventory = await admin.refreshInventory({ settings, passphrase, serverId })
    const context = inventory.webminaiLinuxContext
    validateLinuxStackProfiles(context.stackProfiles)
    await validateProfileRoutes(admin, serverId, context)
    process.stdout.write(`[${serverId}] ${context.identity.prettyName} profiles=valid\n`)
    return { serverId, family: context.management.family, context, inventory }
  })

  const ismetInventory = await admins.get(ISMET).refreshInventory({ settings, passphrase, serverId: ISMET })
  validateLinuxStackProfiles(ismetInventory.webminaiLinuxContext.stackProfiles)
  assert.equal(ismetInventory.webminaiDocker.hostIsContainer, false, 'ismet must be a non-container Docker-capable host')
  assert.equal(ismetInventory.webminaiDocker.capable, true, 'ismet must resolve a supported Docker route')
  assert.equal(ismetInventory.webminaiDocker.preferred, true, 'ismet automatic preference must select Docker')
  await validateDockerLifecycle(ismetInventory)

  const stages = buildValidationStages({ hosts, applicationId: APP, scorecard })
  const evidence = []
  for (const stage of stages) {
    process.stdout.write(`\nStage ${stage.id}: ${stage.hosts.map(host => host.serverId).join(', ')}\n`)
    const values = await parallelMap(stage.hosts, Number(process.env.WEBMINAI_TEST_CONCURRENCY ?? 2), validateLifecycle)
    evidence.push(...values)
    process.stdout.write(`Stage ${stage.id}: passed\n`)
  }

  assert.equal(evidence.length, LINUX_HOSTS.length)
  for (const item of evidence) assert.equal(item.promotion.promoted, true, `${item.serverId}: ${item.promotion.failures.join('; ')}`)
  process.stdout.write(`\nPROMOTION_READY linux-deployment-substrate: ${evidence.length} Linux hosts, staged canary/families/fleet, two applies, restart recovery, two reverts, exact baselines; ${ISMET} Compose ready.\n`)
} finally {
  await ismetSession.close()
}

async function validateLifecycle (host) {
  const { serverId, context } = host
  const admin = admins.get(serverId)
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const netdata = admin.netdata(server)
  const task = admin.createTask(serverId, 'Validate the reusable Linux deployment substrate without installing an application candidate.', { kind: 'catalog', catalogId: 'deployment-substrate' })
  const plan = buildFixturePlan(task.id, context)
  admin.saveTaskPlan(serverId, task.id, plan)
  const baselineFingerprint = await fingerprint(netdata, context.management.packageManager)
  const evidence = { baselineFingerprint }
  try {
    admin.markTaskRunning(serverId, task.id)
    const first = await execute(admin, serverId, plan, task.id, context.management.family, 'apply')
    evidence.apply1 = { status: complete(first) ? 'completed' : 'failed', changed: true }
    assert.equal(evidence.apply1.status, 'completed')
    const afterFirst = await fingerprint(netdata, context.management.packageManager)

    const second = await execute(admin, serverId, plan, task.id, context.management.family, 'apply')
    const afterSecond = await fingerprint(netdata, context.management.packageManager)
    evidence.apply2 = { status: complete(second) ? 'completed' : 'failed', changed: afterFirst !== afterSecond }
    assert.equal(evidence.apply2.changed, false, 'second apply changed the fixture fingerprint')

    const restart = await netdata.runCommand(restartCommand(context), { timeoutSeconds: 30 })
    assert.equal(restart.exitCode, 0, restart.stderr)
    evidence.restartRecovery = { status: 'completed' }

    const revertPlan = { ...plan, commands: plan.revertCommands, revertCommands: [], summary: `Revert ${plan.summary}` }
    const firstRevert = await execute(admin, serverId, revertPlan, task.id, context.management.family, 'revert', false)
    evidence.revert1 = { status: complete(firstRevert) ? 'completed' : 'failed', changed: true }
    assert.equal(evidence.revert1.status, 'completed')
    const afterFirstRevert = await fingerprint(netdata, context.management.packageManager)

    const secondRevert = await execute(admin, serverId, revertPlan, task.id, context.management.family, 'revert', false)
    const afterSecondRevert = await fingerprint(netdata, context.management.packageManager)
    evidence.revert2 = { status: complete(secondRevert) ? 'completed' : 'failed', changed: afterFirstRevert !== afterSecondRevert }
    evidence.finalFingerprint = afterSecondRevert
    assert.equal(evidence.revert2.changed, false, 'second revert changed the fixture fingerprint')
    const promotion = evaluatePromotionEvidence(evidence)
    assert.equal(promotion.promoted, true, promotion.failures.join('; '))
    admin.saveTaskResults(serverId, task.id, first)
    process.stdout.write(`[${serverId}] lifecycle=promoted\n`)
    return { serverId, ...evidence, promotion }
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    await netdata.runCommand(cleanupCommand(task.id, context), { timeoutSeconds: 300 }).catch(() => {})
    throw new Error(`${serverId}: ${error.message}`, { cause: error })
  }
}

async function validateDockerLifecycle (inventory) {
  const admin = admins.get(ISMET)
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId: ISMET })
  const netdata = admin.netdata(server)
  const task = admin.createTask(ISMET, 'Validate the reviewed Docker Compose substrate without deploying an application candidate.', { kind: 'catalog', catalogId: 'deployment-substrate' })
  const plan = buildDockerComposeProfilePlan({ taskId: task.id, linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker })
  admin.saveTaskPlan(ISMET, task.id, plan)
  const evidence = { baselineFingerprint: await dockerFingerprint(netdata) }
  try {
    admin.markTaskRunning(ISMET, task.id)
    const first = await execute(admin, ISMET, plan, task.id, inventory.webminaiLinuxContext.management.family, 'apply')
    evidence.apply1 = { status: complete(first) ? 'completed' : 'failed', changed: true }
    assert.equal(evidence.apply1.status, 'completed')
    const afterFirst = await dockerFingerprint(netdata)
    const second = await execute(admin, ISMET, plan, task.id, inventory.webminaiLinuxContext.management.family, 'apply')
    const afterSecond = await dockerFingerprint(netdata)
    evidence.apply2 = { status: complete(second) ? 'completed' : 'failed', changed: afterFirst !== afterSecond }
    assert.equal(evidence.apply2.changed, false, 'ismet Docker second apply changed its fingerprint')
    const restart = await netdata.runCommand('systemctl restart docker; docker info >/dev/null; docker compose version >/dev/null', { timeoutSeconds: 60 })
    assert.equal(restart.exitCode, 0, restart.stderr)
    evidence.restartRecovery = { status: 'completed' }
    const revertPlan = { ...plan, commands: plan.revertCommands, revertCommands: [], summary: `Revert ${plan.summary}` }
    const firstRevert = await execute(admin, ISMET, revertPlan, task.id, inventory.webminaiLinuxContext.management.family, 'revert', false)
    evidence.revert1 = { status: complete(firstRevert) ? 'completed' : 'failed', changed: true }
    assert.equal(evidence.revert1.status, 'completed')
    const afterFirstRevert = await dockerFingerprint(netdata)
    const secondRevert = await execute(admin, ISMET, revertPlan, task.id, inventory.webminaiLinuxContext.management.family, 'revert', false)
    const afterSecondRevert = await dockerFingerprint(netdata)
    evidence.revert2 = { status: complete(secondRevert) ? 'completed' : 'failed', changed: afterFirstRevert !== afterSecondRevert }
    evidence.finalFingerprint = afterSecondRevert
    const promotion = evaluatePromotionEvidence(evidence)
    assert.equal(promotion.promoted, true, promotion.failures.join('; '))
    process.stdout.write(`[${ISMET}] Docker/Compose lifecycle=promoted\n`)
  } catch (error) {
    admin.saveTaskError(ISMET, task.id, error)
    const cleanup = { ...plan, commands: plan.revertCommands, revertCommands: [], summary: `Cleanup ${plan.summary}` }
    await admin.execute({ settings, passphrase, serverId: ISMET, plan: cleanup, approve: async () => true, requireRevert: false }).catch(() => {})
    throw error
  }
}

async function recoverIncompleteSubstrateTasks (serverId) {
  const admin = admins.get(serverId)
  const stale = admin.listTasks(serverId, { limit: 100 }).filter(task => task.catalogId === 'deployment-substrate' && !['reverted', 'completed', 'cancelled'].includes(task.status))
  for (const summary of stale) {
    const task = admin.getTask(serverId, summary.id)
    if (!task.plan?.revertCommands?.length) continue
    process.stdout.write(`[${serverId}] recovering incomplete substrate task #${task.id}\n`)
    const results = await admin.revertTask({ settings, passphrase, serverId, taskId: task.id, approve: async () => true })
    admin.saveTaskRevertResults(serverId, task.id, results)
    if (!complete(results)) throw new Error(`${serverId}: failed to recover substrate task #${task.id}`)
  }
}

function buildFixturePlan (taskId, context) {
  const manager = context.management.packageManager
  const nginx = context.stackProfiles.profiles.nginx
  const binary = nginx.observedBinary ?? nginx.binaries[0]
  const foundation = [
    ...buildBaselineCommands({ taskId, applicationId: APP, packageManager: manager }),
    ...buildPackagePhase({ taskId, applicationId: APP, packageManager: manager, packages: nginx.packages }),
    ...buildSecretPhase({ taskId, applicationId: APP })
  ]
  const applicationCommands = [{
    id: 'configure-fixture',
    phase: 'configure',
    command: configureCommand(binary),
    purpose: 'Write one task-owned nginx configuration and static marker without changing distribution nginx configuration.',
    risk: 'change',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: ['generate-host-credentials']
  }]
  const verification = [{
    id: 'start-fixture', phase: 'services', command: startCommand(binary), purpose: 'Start the task-owned high-port nginx instance when it is not already running.', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: ['configure-fixture'], diagnostic: { kind: 'filesystem', target: APP_ROOT }
  }, ...buildHttpHealthPhase({ url: `http://127.0.0.1:${PORT}/`, dependsOn: ['start-fixture'] })]
  const applicationRevert = [{
    id: 'stop-fixture', phase: 'cleanup', command: stopCommand(), purpose: 'Stop only the task-owned nginx process.', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: []
  }, {
    id: 'remove-fixture', phase: 'cleanup', command: `rm -rf -- ${quote(APP_ROOT)}; rm -f -- /run/webminai-substrate-validation.pid`, purpose: 'Remove only task-owned fixture files.', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: ['stop-fixture']
  }]
  return composeDeploymentPlan({
    foundation,
    applicationCommands,
    verification,
    revertCommands: [...applicationRevert, ...buildFoundationRevertCommands({ taskId, applicationId: APP, packageManager: manager, dependsOn: ['remove-fixture'] })],
    summary: 'Validate reusable Linux deployment phases',
    changeOverview: 'Exercise typed nginx/package/secrets/service/health/rollback phases with an isolated high-port fixture.',
    modifiedFiles: [APP_ROOT, '/run/webminai-substrate-validation.pid', `/root/${APP}_credentials`, `/var/lib/webminai/tasks/${taskId}/${APP}`],
    assumptions: [`Typed profile ${nginx.provider} on ${context.identity.id} ${context.identity.versionId}`],
    warnings: []
  })
}

async function execute (admin, serverId, plan, taskId, distroFamily, operation, requireRevert = true) {
  return admin.execute({
    settings,
    passphrase,
    serverId,
    plan,
    approve: async () => true,
    onResult: result => {
      scorecard.record({ runId: null, taskId, serverId, applicationId: APP, stackId: 'nginx-native', distroFamily: safeId(distroFamily), phase: result.phase ?? 'initialize', outcome: result.status, durationMs: result.durationMs ?? 0, failureCode: result.failure?.code ?? null, firstPass: true, operation })
      if (result.status === 'failed') process.stderr.write(`[${serverId}] ${result.id} ${result.failure?.code ?? 'COMMAND_FAILED'} ${result.failure?.evidence ?? ''}\n`)
    },
    requireRevert
  })
}

async function validateProfileRoutes (admin, serverId, context) {
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const manager = context.management.packageManager
  const packages = [...new Set(Object.values(context.stackProfiles.profiles).filter(profile => profile.id !== 'compose').flatMap(profile => profile.packages))]
  const command = repositoryProbe(manager, packages)
  const result = await admin.netdata(server).runCommand(command, { timeoutSeconds: 120 })
  if (result.exitCode !== 0) throw new Error(`${serverId}: typed profile package routes failed: ${result.stdout.trim() || result.stderr.trim()}`)
}

function repositoryProbe (manager, packages) {
  const names = packages.map(quote).join(' ')
  if (manager === 'apt') return `missing=; for package in ${names}; do dpkg-query -W "$package" >/dev/null 2>&1 || apt-cache show "$package" >/dev/null 2>&1 || missing="$missing $package"; done; [ -z "$missing" ] || { printf 'missing:%s\\n' "$missing"; exit 1; }`
  if (manager === 'dnf' || manager === 'yum') return `missing=; for package in ${names}; do rpm -q "$package" >/dev/null 2>&1 || ${manager} -q list --available "$package" >/dev/null 2>&1 || missing="$missing $package"; done; [ -z "$missing" ] || { printf 'missing:%s\\n' "$missing"; exit 1; }`
  if (manager === 'apk') return `missing=; for package in ${names}; do apk info -e "$package" >/dev/null 2>&1 || apk policy "$package" | grep -q '[0-9]' || missing="$missing $package"; done; [ -z "$missing" ] || { printf 'missing:%s\\n' "$missing"; exit 1; }`
  if (manager === 'pacman') return `missing=; for package in ${names}; do pacman -Q "$package" >/dev/null 2>&1 || pacman -Si "$package" >/dev/null 2>&1 || missing="$missing $package"; done; [ -z "$missing" ] || { printf 'missing:%s\\n' "$missing"; exit 1; }`
  if (manager === 'zypper') return `missing=; for package in ${names}; do rpm -q "$package" >/dev/null 2>&1 || zypper --non-interactive info "$package" >/dev/null 2>&1 || missing="$missing $package"; done; [ -z "$missing" ] || { printf 'missing:%s\\n' "$missing"; exit 1; }`
  throw new Error(`unsupported package manager: ${manager}`)
}

function configureCommand (binary) {
  const lines = ['worker_processes 1;', 'pid /run/webminai-substrate-validation.pid;', `error_log ${APP_ROOT}/error.log notice;`, 'events { worker_connections 64; }', 'http {', '  access_log off;', '  server {', `    listen 127.0.0.1:${PORT};`, `    root ${APP_ROOT}/www;`, '    location / { try_files /index.html =404; }', '  }', '}']
  return `set -eu; test -x ${quote(binary)}; install -d -m 0755 ${quote(`${APP_ROOT}/www`)}; printf '%s\\n' ${lines.map(quote).join(' ')} > ${quote(`${APP_ROOT}/nginx.conf`)}; printf '%s\\n' ${quote(MARKER)} > ${quote(`${APP_ROOT}/www/index.html`)}; chmod 0644 ${quote(`${APP_ROOT}/nginx.conf`)} ${quote(`${APP_ROOT}/www/index.html`)}`
}

function startCommand (binary) {
  return `if [ -s /run/webminai-substrate-validation.pid ] && kill -0 "$(sed -n '1p' /run/webminai-substrate-validation.pid)" 2>/dev/null; then exit 0; fi; rm -f -- /run/webminai-substrate-validation.pid; ${quote(binary)} -p ${quote(`${APP_ROOT}/`)} -c ${quote(`${APP_ROOT}/nginx.conf`)}`
}

function stopCommand () {
  return 'if [ -s /run/webminai-substrate-validation.pid ]; then pid="$(sed -n \'1p\' /run/webminai-substrate-validation.pid)"; kill "$pid" 2>/dev/null || true; attempt=0; while kill -0 "$pid" 2>/dev/null; do attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { kill -KILL "$pid" 2>/dev/null || true; break; }; sleep 1; done; fi'
}

function restartCommand (context) {
  const binary = context.stackProfiles.profiles.nginx.observedBinary ?? context.stackProfiles.profiles.nginx.binaries[0]
  return `${stopCommand()}; ${startCommand(binary)}; curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
}

function cleanupCommand (taskId, context) {
  const manager = context.management.packageManager
  const state = `/var/lib/webminai/tasks/${taskId}/${APP}`
  return `${stopCommand()}; rm -rf -- ${quote(APP_ROOT)}; if [ -s ${quote(`${state}/packages.added`)} ]; then ${removePackages(manager, `${state}/packages.added`)}; fi; rm -rf -- ${quote(state)} ${quote(`/root/${APP}_credentials`)}`
}

function removePackages (manager, file) {
  if (manager === 'apt') return `xargs -r apt-get purge -y -- < ${quote(file)}`
  if (manager === 'dnf') return `xargs -r dnf remove -y -- < ${quote(file)}`
  if (manager === 'yum') return `xargs -r yum remove -y -- < ${quote(file)}`
  if (manager === 'apk') return `xargs -r apk del -- < ${quote(file)}`
  if (manager === 'pacman') return `xargs -r pacman -Rns --noconfirm -- < ${quote(file)}`
  return `xargs -r zypper --non-interactive remove -- < ${quote(file)}`
}

async function fingerprint (netdata, manager) {
  const packages = manager === 'apt' ? 'dpkg-query -W -f=\'$' + '{binary:Package}=$' + '{Version}\\n\'' : manager === 'apk' ? 'apk info -vv' : manager === 'pacman' ? 'pacman -Q' : 'rpm -qa --qf=\'%{NAME}=%{VERSION}-%{RELEASE}.%{ARCH}\\n\''
  const command = `{ ${packages} | LC_ALL=C sort; for path in ${quote(APP_ROOT)} ${quote(`/root/${APP}_credentials`)} /run/webminai-substrate-validation.pid; do [ -e "$path" ] && printf 'present=%s\\n' "$path" || printf 'absent=%s\\n' "$path"; done; } | sha256sum | awk '{print $1}'`
  const result = await netdata.runCommand(command, { timeoutSeconds: 30 })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/u)
  return result.stdout.trim()
}

async function dockerFingerprint (netdata) {
  const dpkgFormat = '$' + '{binary:Package}=$' + '{Version}\\n'
  const command = [
    `dpkg-query -W -f=${quote(dpkgFormat)} | LC_ALL=C sort | sha256sum | awk '{print $1}'`,
    "for path in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do [ -e \"$path\" ] && printf 'present=%s\\n' \"$path\" || printf 'absent=%s\\n' \"$path\"; done | sha256sum | awk '{print $1}'",
    "if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then printf 'ready\\n'; else printf 'absent\\n'; fi"
  ].join('; ')
  const result = await netdata.runCommand(command, { timeoutSeconds: 30 })
  assert.equal(result.exitCode, 0, result.stderr)
  return createHash('sha256').update(result.stdout.trim()).digest('hex')
}

function complete (results) {
  return results.length > 0 && results.every(result => result.status === 'completed')
}

async function parallelMap (items, concurrency, mapper) {
  const result = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      result[index] = await mapper(items[index], index)
    }
  }))
  return result
}

function safeId (value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9_-]/gu, '-').slice(0, 63) || 'unknown'
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
