#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildValidationStages } from '../src/canary-scheduler.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { DeploymentScorecard } from '../src/deployment-scorecard.js'
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
const APP = 'woocommerce-linux'
const PORT = 18102
const MARKER = 'WEBMINAI_WOOCOMMERCE_OK'
const composeOnly = process.argv.includes('--compose-only')
const passphrase = process.env.VAULT_TEST
if (!passphrase) throw new Error('VAULT_TEST is required')
if (!process.env.SSH_HOST_1) throw new Error('SSH_HOST_1 is required for the ismet Docker validation host')

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
for (const serverId of [...LINUX_HOSTS, ISMET]) if (!settings.servers[serverId]) throw new Error(`WooCommerce validation host is missing: ${serverId}`)

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
  const evidence = []
  for (const serverId of composeOnly ? [ISMET] : [...LINUX_HOSTS, ISMET]) await recoverIncompleteTasks(serverId)
  if (!composeOnly) {
    process.stdout.write('Refreshing Stage 2 Linux context and WooCommerce route facts...\n')
    const hosts = await parallelMap(LINUX_HOSTS, 3, async serverId => {
      const inventory = await admins.get(serverId).refreshInventory({ settings, passphrase, serverId })
      assert.equal(inventory.webminaiDocker.preferred, false, `${serverId}: LXD host must select the native route`)
      const host = { serverId, family: inventory.webminaiLinuxContext.management.family, inventory }
      process.stdout.write(`[${serverId}] route=native family=${host.family}\n`)
      return host
    })

    const stages = buildValidationStages({ hosts, applicationId: APP, scorecard })
    for (const stage of stages) {
      process.stdout.write(`\nStage ${stage.id}: ${stage.hosts.map(host => host.serverId).join(', ')}\n`)
      const stageEvidence = await parallelMap(stage.hosts, Number(process.env.WEBMINAI_TEST_CONCURRENCY ?? 2), host => validateLifecycle(host, false))
      evidence.push(...stageEvidence)
      process.stdout.write(`Stage ${stage.id}: passed\n`)
    }
  }

  const ismetInventory = await admins.get(ISMET).refreshInventory({ settings, passphrase, serverId: ISMET })
  assert.equal(ismetInventory.webminaiDocker.hostIsContainer, false, 'ismet must be a non-container host')
  assert.equal(ismetInventory.webminaiDocker.capable, true, 'ismet must have a supported Docker installation route')
  assert.equal(ismetInventory.webminaiDocker.preferred, true, 'ismet automatic policy must prefer Compose')
  process.stdout.write(`\nStage compose: ${ISMET}\n`)
  evidence.push(await validateLifecycle({ serverId: ISMET, family: ismetInventory.webminaiLinuxContext.management.family, inventory: ismetInventory }, true))

  assert.equal(evidence.length, composeOnly ? 1 : LINUX_HOSTS.length + 1)
  for (const item of evidence) assert.equal(item.promotion.promoted, true, `${item.serverId}: ${item.promotion.failures.join('; ')}`)
  process.stdout.write(`\nPROMOTION_READY WooCommerce ${evidence.length} hosts: staged canary/families/fleet plus ${ISMET} Compose; two applies, restart recovery, two reverts, exact baselines.\n`)
} finally {
  await ismetSession.close()
}

async function validateLifecycle (host, compose) {
  const { serverId, inventory } = host
  const admin = admins.get(serverId)
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const netdata = admin.netdata(server)
  const task = admin.createTask(serverId, 'Deploy the learned reversible WooCommerce compatibility store.', { kind: 'catalog', catalogId: APP })
  const built = buildCommonTask(APP, task.id, {
    platform: 'linux',
    linuxContext: inventory.webminaiLinuxContext,
    docker: inventory.webminaiDocker
  })
  const plan = built.plan
  admin.saveTaskPlan(serverId, task.id, plan)
  const fingerprintCommand = buildFingerprintCommand(task.id, inventory, compose)
  const baselineFingerprint = await fingerprint(netdata, fingerprintCommand)
  const evidence = { baselineFingerprint }
  try {
    admin.markTaskRunning(serverId, task.id)
    const first = await execute(admin, serverId, task.id, plan, host.family, 'apply')
    evidence.apply1 = { status: complete(first) ? 'completed' : 'failed', changed: true }
    assert.equal(evidence.apply1.status, 'completed')
    await verify(admin, server, built, compose)
    const afterFirst = await fingerprint(netdata, fingerprintCommand)

    const second = await execute(admin, serverId, task.id, plan, host.family, 'apply')
    evidence.apply2 = { status: complete(second) ? 'completed' : 'failed', changed: afterFirst !== await fingerprint(netdata, fingerprintCommand) }
    assert.equal(evidence.apply2.status, 'completed')
    assert.equal(evidence.apply2.changed, false, 'second apply changed the task fingerprint')
    await verify(admin, server, built, compose)

    const restarted = await netdata.runCommand(restartCommand(inventory, compose), { timeoutSeconds: compose ? 180 : 90 })
    assert.equal(restarted.exitCode, 0, restarted.stdout.trim() || restarted.stderr.trim())
    await verify(admin, server, built, compose)
    evidence.restartRecovery = { status: 'completed' }

    const revertPlan = { ...plan, commands: plan.revertCommands, revertCommands: [], summary: `Revert ${plan.summary}` }
    const firstRevert = await execute(admin, serverId, task.id, revertPlan, host.family, 'revert', false)
    evidence.revert1 = { status: complete(firstRevert) ? 'completed' : 'failed', changed: true }
    assert.equal(evidence.revert1.status, 'completed')
    await verifyGone(server)
    const afterFirstRevert = await fingerprint(netdata, fingerprintCommand)

    const secondRevert = await execute(admin, serverId, task.id, revertPlan, host.family, 'revert', false)
    evidence.revert2 = { status: complete(secondRevert) ? 'completed' : 'failed', changed: afterFirstRevert !== await fingerprint(netdata, fingerprintCommand) }
    evidence.finalFingerprint = await fingerprint(netdata, fingerprintCommand)
    assert.equal(evidence.revert2.status, 'completed')
    assert.equal(evidence.revert2.changed, false, 'second revert changed the task fingerprint')
    const promotion = evaluatePromotionEvidence(evidence)
    assert.equal(promotion.promoted, true, promotion.failures.join('; '))
    admin.saveTaskResults(serverId, task.id, second)
    admin.saveTaskRevertResults(serverId, task.id, secondRevert)
    process.stdout.write(`[${serverId}] route=${compose ? 'compose' : 'native'} lifecycle=promoted\n`)
    return { serverId, ...evidence, promotion }
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    const cleanup = { ...plan, commands: plan.revertCommands, revertCommands: [], summary: `Cleanup ${plan.summary}` }
    await admin.execute({ settings, passphrase, serverId, plan: cleanup, approve: async () => true, requireRevert: false }).catch(() => {})
    throw new Error(`${serverId}: ${error.message}`, { cause: error })
  }
}

async function execute (admin, serverId, taskId, plan, family, operation, requireRevert = true) {
  return admin.execute({
    settings,
    passphrase,
    serverId,
    plan,
    approve: async () => true,
    requireRevert,
    onResult: result => {
      scorecard.record({
        runId: null,
        taskId,
        serverId,
        applicationId: APP,
        stackId: plan.compatibilityManifest?.selectedRoute?.id ?? 'woocommerce',
        distroFamily: safeId(family),
        phase: result.phase ?? (operation === 'revert' ? 'cleanup' : 'initialize'),
        outcome: result.status,
        durationMs: result.durationMs ?? 0,
        failureCode: result.failure?.code ?? null,
        firstPass: true,
        operation
      })
      if (result.status === 'failed') process.stderr.write(`[${serverId}] ${result.id} ${result.failure?.code ?? 'COMMAND_FAILED'} ${result.failure?.evidence ?? ''}\n`)
    }
  })
}

async function verify (admin, server, built, compose) {
  const result = await admin.netdata(server).runCommand(built.verifyApplied, { timeoutSeconds: compose ? 120 : 30 })
  assert.equal(result.exitCode, 0, result.stdout.trim() || result.stderr.trim())
  const address = new URL(server.connectionUrl).hostname
  let last = 'no response'
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://${address}:${PORT}/`, { signal: AbortSignal.timeout(3000) })
      const body = await response.text()
      if (response.ok && body.includes(MARKER)) return
      last = `HTTP ${response.status}`
    } catch (error) {
      last = error.message
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`external WooCommerce marker verification failed: ${last}`)
}

async function verifyGone (server) {
  const address = new URL(server.connectionUrl).hostname
  try {
    const response = await fetch(`http://${address}:${PORT}/`, { signal: AbortSignal.timeout(2000) })
    const body = await response.text()
    assert.equal(body.includes(MARKER), false, 'WooCommerce marker remains externally reachable after revert')
  } catch {}
}

function restartCommand (inventory, compose) {
  if (compose) {
    return `set -eu; cd /opt/webminai/services/woocommerce; docker compose -p webminai-woocommerce-18102 restart db wordpress nginx >/dev/null; ready=; for attempt in $(seq 1 60); do if docker compose -p webminai-woocommerce-18102 exec -T wordpress test -S /run/php-fpm/webminai.sock && curl --fail --location --silent --show-error --max-time 3 http://127.0.0.1:${PORT}/ 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]`
  }
  const profile = inventory.webminaiLinuxContext.applications.wordpress
  const restart = service => service.endsWith('.service') ? `systemctl restart ${quote(service)}` : `rc-service ${quote(service)} restart >/dev/null`
  return `set -eu; ${restart(profile.mariadbService)}; ${restart(profile.phpFpmService)}; ${restart(profile.nginxService)}; ready=; for attempt in $(seq 1 30); do if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${PORT}/ 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 1; done; [ "$ready" = yes ]`
}

function buildFingerprintCommand (taskId, inventory, compose) {
  const context = inventory.webminaiLinuxContext
  const manager = context.management.packageManager
  const packages = manager === 'apt'
    ? 'dpkg-query -W -f=\'$' + '{binary:Package}=$' + '{Version}\\n\''
    : manager === 'apk'
      ? 'apk info -vv'
      : manager === 'pacman'
        ? 'pacman -Q'
        : 'rpm -qa --qf=\'%{NAME}=%{VERSION}-%{RELEASE}.%{ARCH}\\n\''
  const state = `/var/lib/webminai/task-state/${taskId}-woocommerce-${compose ? 'compose' : 'linux'}`
  const taskPaths = compose
    ? ['/opt/webminai/services/woocommerce', '/root/woocommerce_credentials', state]
    : nativeTaskPaths(context.applications.wordpress, state)
  const services = compose ? ['docker.service'] : [context.applications.wordpress.mariadbService, context.applications.wordpress.phpFpmService, context.applications.wordpress.nginxService]
  const serviceProbe = services.map(service => service.endsWith('.service') ? `systemctl is-active ${quote(service)} 2>/dev/null || true` : `rc-service ${quote(service)} status >/dev/null 2>&1 && printf active || printf inactive`).join('; ')
  const pathProbe = taskPaths.map(item => `if [ -f ${quote(item)} ]; then sha256sum ${quote(item)}; elif [ -d ${quote(item)} ]; then find ${quote(item)} -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; else printf 'absent=%s\n' ${quote(item)}; fi`).join('; ')
  const platformProbe = compose
    ? `printf 'port=%s\n' ${PORT}; for path in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do [ -e "$path" ] && printf 'present=%s\n' "$path" || printf 'absent=%s\n' "$path"; done; if command -v docker >/dev/null 2>&1; then ids=$(docker ps -aq --filter label=com.docker.compose.project=webminai-woocommerce-18102); [ -z "$ids" ] || docker inspect $ids --format '{{.Id}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' | LC_ALL=C sort; docker image inspect wordpress:7.0.2-php8.3-fpm wordpress:cli-2.12.0-php8.3 nginx:1.30.4-alpine mariadb:11.8.8 --format '{{.Id}}' 2>/dev/null | LC_ALL=C sort || true; fi`
    : `if command -v mariadb >/dev/null 2>&1; then mariadb --protocol=socket -uroot -Nse "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='webminai_woocommerce_18102'" 2>/dev/null || true; fi; [ -d /var/lib/mysql/mysql ] && printf mysql-data-present || printf mysql-data-absent; ss -lnt 2>/dev/null | grep -E '[:.]${PORT}[[:space:]]' || true`
  return `{ ${packages} | LC_ALL=C sort; ${serviceProbe}; ${pathProbe}; ${platformProbe}; } | sha256sum | awk '{print $1}'`
}

function nativeTaskPaths (profile, state) {
  return [...new Set([
    '/srv/webminai-woocommerce-18102',
    '/var/lib/webminai/webminai-woocommerce-18102',
    '/root/woocommerce_credentials',
    profile.phpFpmRuntimeDirectory.replaceAll('webminai-wordpress-18101', 'webminai-woocommerce-18102'),
    profile.phpFpmPool.replaceAll('webminai-wordpress-18101', 'webminai-woocommerce-18102'),
    profile.nginxVhost.replaceAll('webminai-wordpress-18101', 'webminai-woocommerce-18102'),
    ...(profile.phpExtensionConfig ? [profile.phpExtensionConfig.replaceAll('webminai-wordpress-18101', 'webminai-woocommerce-18102')] : []),
    ...(profile.nginxEnableLink ? [profile.nginxEnableLink.replaceAll('webminai-wordpress-18101', 'webminai-woocommerce-18102')] : []),
    ...(profile.nginxIncludeRequired ? [profile.nginxMainConfig] : []),
    state
  ])]
}

async function fingerprint (netdata, command) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 60 })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/u)
  return result.stdout.trim()
}

async function recoverIncompleteTasks (serverId) {
  const admin = admins.get(serverId)
  const stale = admin.listTasks(serverId, { limit: 100 }).filter(task => task.catalogId === APP && !['reverted', 'completed', 'cancelled'].includes(task.status))
  for (const summary of stale) {
    const task = admin.getTask(serverId, summary.id)
    if (!task.plan?.revertCommands?.length) continue
    process.stdout.write(`[${serverId}] recovering incomplete WooCommerce task #${task.id}\n`)
    const results = await admin.revertTask({ settings, passphrase, serverId, taskId: task.id, approve: async () => true })
    admin.saveTaskRevertResults(serverId, task.id, results)
    if (!complete(results)) throw new Error(`${serverId}: failed to recover task #${task.id}`)
  }
}

function complete (results) {
  return results.length > 0 && results.every(result => result.status === 'completed')
}

async function parallelMap (items, concurrency, mapper) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }))
  return results
}

function safeId (value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9_-]/gu, '-').slice(0, 63) || 'unknown'
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
