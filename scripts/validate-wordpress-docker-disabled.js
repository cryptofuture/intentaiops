#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { MultiHostService } from '../src/multi-host-service.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const SERVER_ID = process.env.WEBMINAI_DOCKER_DISABLED_HOST ?? 'ismet'
const MARKER = 'WEBMINAI_WORDPRESS_OK'
const PORT = 18101
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package}\\n'
const phase = process.argv.find(argument => argument.startsWith('--phase='))?.slice(8) ?? 'all'
if (!['all', 'compose', 'native'].includes(phase)) throw new Error('--phase must be all, compose, or native')
const passphrase = process.env.VAULT_TEST
if (!passphrase) throw new Error('VAULT_TEST is required')

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const workspace = new ServerWorkspace(dataRoot)
const settings = await settingsStore.load()
if (!settings.servers[SERVER_ID]) throw new Error(`WordPress Docker validation host is missing: ${SERVER_ID}`)

const ssh = new SystemSsh({ controlPath: process.env.WEBMINAI_SSH_CONTROL_PATH })
const admin = new AdminService({ dataRoot, settings: settingsStore, workspace, ssh })
const service = new MultiHostService({ dataRoot, concurrency: 1, adminFor: () => admin })
const server = await settingsStore.decryptServer({ settings, passphrase, serverId: SERVER_ID })
const address = new URL(server.connectionUrl).hostname
const originalPreference = (await workspace.loadRules(SERVER_ID)).preferences.docker
const composeRequest = 'Deploy the learned reversible WordPress compatibility site using the preferred Docker Compose route, installing Docker first when required.'
const nativeRequest = 'Deploy the learned reversible native WordPress compatibility site while Docker is explicitly disabled by the host preference.'
let run
let runReview

try {
  const initialInventory = await admin.refreshInventory({ settings, passphrase, serverId: SERVER_ID })
  const initialDocker = initialInventory.webminaiDocker
  assert.equal(initialDocker.preference, originalPreference)
  assertDockerCapable(initialDocker, 'before the Compose run')
  assert.equal(initialDocker.preferred, true, 'automatic policy must prefer Docker on a supported non-container host')
  process.stdout.write(`Docker policy: capable=${initialDocker.capable} ready=${initialDocker.ready} setupRequired=${initialDocker.setupRequired} method=${initialDocker.installMethod}\n`)

  if (phase !== 'native') {
    const beforeComposeFingerprint = await dockerFingerprint(admin.netdata(server))
    runReview = reviewComposePlan
    await runWordpress(composeRequest, reviewComposePlan)
    await revertWordpress(reviewComposePlan)
    run = null
    const afterComposeFingerprint = await dockerFingerprint(admin.netdata(server))
    assert.deepEqual(afterComposeFingerprint, beforeComposeFingerprint, 'Docker installation or object state was not restored after the Compose task')
    process.stdout.write('Compose WordPress passed and restored the pre-task Docker installation and object state.\n')
  }

  if (phase !== 'compose') {
    await workspace.setDockerPreference(SERVER_ID, 'disabled')
    const disabledInventory = await admin.refreshInventory({ settings, passphrase, serverId: SERVER_ID })
    const docker = disabledInventory.webminaiDocker
    assert.equal(docker.preference, 'disabled')
    assert.equal(docker.capable, true, 'Docker support capability must remain detected while disabled')
    assert.equal(docker.preferred, false)
    assert.equal(docker.reason, 'disabled by host preference')
    process.stdout.write(`Docker policy: capable=${docker.capable} ready=${docker.ready} preference=${docker.preference} preferred=${docker.preferred} reason=${docker.reason}\n`)

    const beforeNativeFingerprint = await dockerFingerprint(admin.netdata(server))
    runReview = reviewNativePlan
    await runWordpress(nativeRequest, reviewNativePlan)
    await revertWordpress(reviewNativePlan)
    run = null
    const afterNativeFingerprint = await dockerFingerprint(admin.netdata(server))
    assert.deepEqual(afterNativeFingerprint, beforeNativeFingerprint, 'Docker state changed during the native WordPress task')
    process.stdout.write(`Native WordPress left Docker state unchanged: ${Object.entries(afterNativeFingerprint).map(([key, value]) => `${key}=${value}`).join(' ')}\n`)
  }
} catch (error) {
  await waitForStage2().catch(() => {})
  await revertPartialRun().catch(revertError => {
    error.message += `; cleanup also failed: ${revertError.message}`
  })
  throw error
} finally {
  await workspace.setDockerPreference(SERVER_ID, originalPreference)
}

const restoredInventory = await admin.refreshInventory({ settings, passphrase, serverId: SERVER_ID })
assert.equal(restoredInventory.webminaiDocker.preference, originalPreference)
process.stdout.write(`WordPress ${phase} validation passed; original Docker preference restored to ${originalPreference}.\n`)

function assertDockerCapable (docker, context) {
  assert.equal(docker?.hostIsContainer, false, `host is a protected container ${context}`)
  assert.equal(docker?.installSupported || docker?.ready, true, `no supported Docker route was detected ${context}`)
  assert.equal(docker?.capable, true, `Docker capability was not resolved ${context}`)
}

function reviewComposePlan ({ hosts }) {
  for (const host of hosts) {
    const commandText = [...host.plan.commands, ...host.plan.revertCommands].map(item => item.command).join('\n')
    assert.match(commandText, /\bdocker compose\b/u, `plan for ${host.serverId} did not select Compose`)
    assert.equal(/\bdocker\s+run\b/u.test(commandText), false, `plan for ${host.serverId} used docker run`)
    assert.equal(host.plan.modifiedFiles.includes('/opt/webminai/services/wordpress/compose.yaml'), true)
    const composeCommand = host.plan.commands.find(item => item.id === 'write-compose')?.command ?? ''
    if (composeCommand) {
      assert.match(composeCommand, /\/root\/wordpress_credentials\/db_password/u)
      assert.equal(/[0-9a-f]{64}/u.test(composeCommand), false, 'Compose plan contains a credential-like literal')
    }
  }
  return true
}

function reviewNativePlan ({ hosts }) {
  for (const host of hosts) {
    const commandText = [...host.plan.commands, ...host.plan.revertCommands].map(item => item.command).join('\n')
    if (/(?:^|[;&|\n])\s*(?:exec\s+|command\s+-v\s+)?docker(?:-compose)?(?:\s|$)/u.test(commandText)) {
      throw new Error(`plan for ${host.serverId} contains a Docker command while Docker is disabled`)
    }
    if (host.plan.modifiedFiles.some(file => /^\/opt\/webminai\/services(?:\/|$)/u.test(file))) {
      throw new Error(`plan for ${host.serverId} contains a Docker service artifact while Docker is disabled`)
    }
  }
  return true
}

async function dockerFingerprint (netdata) {
  const command = [
    'set -eu',
    'hash_objects() { kind="$1"; ids="$2"; if [ -n "$ids" ]; then docker "$kind" inspect $ids | sha256sum | awk \'{print $1}\'; else printf empty; fi; }',
    'installed=no; containers=; images=; volumes=; networks=',
    'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then installed=yes; containers=$(docker ps -aq | LC_ALL=C sort); images=$(docker image ls -aq --no-trunc | LC_ALL=C sort -u); volumes=$(docker volume ls -q | LC_ALL=C sort); networks=$(docker network ls -q --no-trunc | LC_ALL=C sort); fi',
    `packages=$(dpkg-query -W -f=${shellQuote(DPKG_PACKAGE_FORMAT)} 2>/dev/null | grep -E '^(containerd\\.io|docker-|docker-ce|docker-buildx-plugin|docker-compose-plugin)$' | LC_ALL=C sort | sha256sum | awk '{print $1}')`,
    'paths=$(for path in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do if [ -e "$path" ]; then printf \'present:%s\\n\' "$path"; else printf \'absent:%s\\n\' "$path"; fi; done | sha256sum | awk \'{print $1}\')',
    'printf \'installed=%s\\n\' "$installed"',
    'printf \'packages=%s\\n\' "$packages"',
    'printf \'paths=%s\\n\' "$paths"',
    'printf \'containers=%s\\n\' "$(hash_objects inspect "$containers")"',
    'printf \'images=%s\\n\' "$(hash_objects image "$images")"',
    'printf \'volumes=%s\\n\' "$(hash_objects volume "$volumes")"',
    'printf \'networks=%s\\n\' "$(hash_objects network "$networks")"'
  ].join('; ')
  const result = await netdata.runCommand(command, { timeoutSeconds: 30 })
  if (result.exitCode !== 0) throw new Error(`Docker fingerprint failed with exit code ${result.exitCode}`)
  const values = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')))
  assert.deepEqual(Object.keys(values).sort(), ['containers', 'images', 'installed', 'networks', 'packages', 'paths', 'volumes'])
  assert.match(values.installed, /^(?:yes|no)$/u)
  for (const key of ['containers', 'images', 'networks', 'packages', 'paths', 'volumes']) assert.match(values[key], /^(?:empty|[0-9a-f]{64})$/u)
  return values
}

async function runWordpress (request, review) {
  const value = await service.run({
    settings,
    passphrase,
    serverIds: [SERVER_ID],
    request,
    kind: 'catalog',
    catalogId: 'wordpress-linux',
    review,
    externalVerify: () => verifyHttp(true),
    onEvent: renderEvent
  })
  run = value
  if (value.status !== 'completed') throw new Error(`WordPress apply did not complete: ${value.hosts[0]?.error ?? value.status}`)
  return value
}

async function revertWordpress (review) {
  const reverted = await service.revert({
    settings,
    passphrase,
    runId: run.id,
    review,
    externalVerify: () => verifyHttp(false),
    onEvent: renderEvent
  })
  if (reverted.status !== 'reverted') throw new Error(`WordPress revert did not complete: ${reverted.hosts[0]?.error ?? reverted.status}`)
}

async function verifyHttp (shouldExist) {
  const url = `http://${address}:${PORT}/`
  let lastError
  for (let attempt = 0; attempt < (shouldExist ? 60 : 5); attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const body = await response.text()
      const found = response.ok && body.includes(MARKER)
      if (shouldExist && found) return { message: `${url} returned ${MARKER}`, url, marker: MARKER }
      if (!shouldExist && !found) return { message: `${url} no longer returns the task marker`, url }
      lastError = new Error(`HTTP ${response.status} returned the wrong marker state`)
    } catch (error) {
      if (!shouldExist) return { message: `${url} is closed after revert`, url }
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`external verification failed: ${lastError?.message ?? url}`)
}

async function revertPartialRun () {
  if (!run || ['reverted', 'cancelled'].includes(run.status)) return
  const host = run.hosts.find(item => item.serverId === SERVER_ID)
  if (!host?.taskId) return
  const task = admin.getTask(SERVER_ID, host.taskId)
  if (!task.plan?.revertCommands?.length || !task.results?.length) return
  const reverted = await service.revert({
    settings,
    passphrase,
    runId: run.id,
    review: runReview,
    externalVerify: () => verifyHttp(false),
    onEvent: renderEvent
  })
  if (reverted.status !== 'reverted') throw new Error(reverted.hosts[0]?.error ?? 'partial revert failed')
}

async function waitForStage2 () {
  let lastError
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      return await admin.netdata(server).health()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
  throw lastError
}

function renderEvent (event) {
  if (['planning', 'planned', 'running', 'verified', 'completed', 'failed', 'reverting', 'reverted', 'revert-failed'].includes(event.type)) {
    process.stdout.write(`[${event.serverId}] ${event.type}: ${event.message ?? ''}\n`)
  }
}

function shellQuote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
