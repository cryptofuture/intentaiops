#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { parseSshConnection } from '../src/connection.js'
import { MultiHostService } from '../src/multi-host-service.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { TaskStore } from '../src/task-store.js'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: validate-multi-host-nginx.js\nRequires VAULT_TEST and at least two configured lab hosts; optional WEBMINAI_TEST_HOSTS and WEBMINAI_TEST_CONCURRENCY select the fleet.\n')
  process.exit(0)
}

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const passphrase = process.env.VAULT_TEST
if (!passphrase) throw new Error('VAULT_TEST is required for multi-host remote validation')

const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
const requested = process.env.WEBMINAI_TEST_HOSTS?.split(',').map(value => value.trim()).filter(Boolean)
const serverIds = requested ?? Object.keys(settings.servers).filter(serverId => serverId.startsWith('webminai-')).sort()
if (serverIds.length < 2) throw new Error('multi-host validation requires at least two webminai lab hosts')

const ssh = new SystemSsh()
const workspace = new ServerWorkspace(dataRoot)
const tasks = new TaskStore(dataRoot)
const admins = new Map(serverIds.map(serverId => [serverId, new AdminService({
  dataRoot,
  ssh,
  settings: settingsStore,
  workspace,
  tasks
})]))
const service = new MultiHostService({
  dataRoot,
  concurrency: Number(process.env.WEBMINAI_TEST_CONCURRENCY ?? 4),
  adminFor: serverId => admins.get(serverId)
})
const initialStates = new Map()

process.stdout.write(`Running nginx task on ${serverIds.length} hosts with bounded parallel execution...\n`)
let run
let applyError
let revertError
try {
  run = await service.run({
    settings,
    passphrase,
    serverIds,
    request: 'Deploy an nginx static website',
    kind: 'catalog',
    catalogId: 'nginx-static-site',
    review: async ({ hosts }) => {
      await Promise.all(hosts.map(async host => {
        const built = buildCommonTask('nginx-static-site', host.taskId)
        initialStates.set(host.serverId, (await remoteCommand(host.serverId, built.stateProbe)).stdout)
      }))
      return true
    },
    externalVerify: async ({ serverId }) => verifyPage(serverId, true),
    onEvent: renderEvent
  })
  printRun(run)
  if (run.status !== 'completed') throw new Error(`nginx multi-host run finished ${run.status}`)
} catch (error) {
  applyError = error
} finally {
  if (run) {
    const revertHosts = run.hosts.filter(host => host.taskId).map(host => host.serverId)
    if (revertHosts.length > 0) {
      process.stdout.write(`Reverting run #${run.id} on ${revertHosts.length} hosts...\n`)
      try {
        const reverted = await service.revert({
          settings,
          passphrase,
          runId: run.id,
          serverIds: revertHosts,
          review: async () => true,
          externalVerify: async ({ serverId }) => verifyPage(serverId, false),
          onEvent: renderEvent
        })
        printRun(reverted)
        if (!revertHosts.every(serverId => reverted.hosts.find(host => host.serverId === serverId)?.status === 'reverted')) {
          revertError = new Error(`multi-host revert finished ${reverted.status}`)
        } else {
          await Promise.all(revertHosts.map(async serverId => {
            const host = run.hosts.find(item => item.serverId === serverId)
            const built = buildCommonTask('nginx-static-site', host.taskId)
            await remoteCommand(serverId, built.verifyReverted)
            const finalState = (await remoteCommand(serverId, built.stateProbe)).stdout
            if (finalState !== initialStates.get(serverId)) throw new Error(`${serverId} state fingerprint differs after revert`)
          }))
        }
      } catch (error) {
        revertError = error
      }
    }
  }
}
if (revertError) throw revertError
if (applyError) throw applyError
process.stdout.write('PASS: every host served the custom page over its connection IP, and every host was reverted.\n')

async function verifyPage (serverId, shouldExist) {
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const host = parseSshConnection(server.connectionUrl).host
  const url = `http://${host.includes(':') ? `[${host}]` : host}:18080/`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const body = await response.text()
    const exists = response.ok && body.includes('WebminAI nginx task')
    if (exists !== shouldExist) throw new Error(`${url} expected page ${shouldExist ? 'present' : 'absent'}, received HTTP ${response.status}`)
    return { ok: true, url, status: response.status, message: `${url} page is ${shouldExist ? 'present' : 'absent'}` }
  } catch (error) {
    if (shouldExist || error.message.includes('expected page')) throw error
    return { ok: true, url, status: null, message: `${url} is closed after revert` }
  }
}

function renderEvent (event) {
  process.stdout.write(`[${event.serverId}] ${event.message}\n`)
}

function printRun (current) {
  process.stdout.write(`Run #${current.id}: ${current.status}\n`)
  for (const host of current.hosts) {
    process.stdout.write(`  ${host.serverId}: ${host.status}${host.error ? ` — ${host.error}` : ''}\n`)
  }
}

async function remoteCommand (serverId, command) {
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const result = await admins.get(serverId).netdata(server).runCommand(command, { timeoutSeconds: 300 })
  if (result.exitCode !== 0) throw new Error(`${serverId} remote verification failed with exit ${result.exitCode}: ${result.stderr}`)
  return result
}
