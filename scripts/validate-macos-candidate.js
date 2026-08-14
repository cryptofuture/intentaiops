#!/usr/bin/env node
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { parseSshConnection } from '../src/connection.js'

const CANDIDATES = {
  woocommerce: { port: 18102, marker: 'WEBMINAI_WOOCOMMERCE_OK' },
  joomla: { port: 18103, marker: 'WEBMINAI_JOOMLA_OK' },
  drupal: { port: 18104, marker: 'WEBMINAI_DRUPAL_OK' },
  prestashop: { port: 18105, marker: 'WEBMINAI_PRESTASHOP_OK' },
  moodle: { port: 18106, marker: 'WEBMINAI_MOODLE_OK', path: '/webminai-health.txt' },
  magento: { port: 18108, marker: 'WEBMINAI_MAGENTO_OK' },
  n8n: { port: 18109, marker: 'WEBMINAI_N8N_OK' },
  ghost: { port: 18110, marker: 'WEBMINAI_GHOST_OK' },
  mattermost: { port: 18111, marker: 'WEBMINAI_MATTERMOST_OK' },
  odoo: { port: 18112, marker: 'WEBMINAI_ODOO_OK' },
  jellyfin: { port: 18113, marker: 'WEBMINAI_JELLYFIN_OK' },
  'home-assistant': { port: 18115, marker: 'WEBMINAI_HOME_ASSISTANT_OK' }
}

const application = process.argv[2]
const definition = CANDIDATES[application]
if (!definition) throw new Error(`usage: validate-macos-candidate.js <${Object.keys(CANDIDATES).join('|')}> [task-id]`)
const taskId = Number(process.argv[3] ?? 991000 + Object.keys(CANDIDATES).indexOf(application))
if (!Number.isInteger(taskId) || taskId < 1) throw new Error('task id must be a positive integer')
if (!process.env.WEBMINAI_CONTROL_PATH) throw new Error('WEBMINAI_CONTROL_PATH is required')

const store = new SettingsStore(process.env.WEBMINAI_DATA_ROOT ?? '/home/vscode/.webminai')
const settings = await store.load()
const server = await store.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: process.env.WEBMINAI_MACOS_SERVER_ID ?? 'macos-15' })
const externalAddress = process.env.WEBMINAI_MACOS_ADDRESS ?? parseSshConnection(server.connectionUrl).host
const client = new NetdataClient({
  ssh: new SystemSsh({ controlPath: process.env.WEBMINAI_CONTROL_PATH }),
  connectionUrl: server.connectionUrl,
  actionKey: server.actionKey
})
const execution = await client.macosExecutionInventory()
const task = buildCommonTask(`${application}-macos`, taskId, {
  platform: 'macos',
  macosExecution: execution,
  docker: { ready: execution.docker.daemonReachable && execution.docker.composeAvailable },
  applicationDefaults: { adminEmail: 'webminai@example.invalid' }
})

for (const pass of [1, 2]) {
  for (const command of task.plan.commands) await execute(command, `apply-${pass}`)
  await verifyExternal(`apply-${pass}`)
}

const home = execution.runtimeHome
const project = `webminai-${application}-${definition.port}`
const restart = `export HOME=${quote(home)} PATH='/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin' DOCKER_HOST=${quote(`unix://${home}/.colima/default/docker.sock`)}; cd ${quote(`${home}/.webminai/services/${application}`)}; docker compose -p ${quote(project)} restart`
const restarted = await client.runJob(restart, { timeoutSeconds: 900, pollIntervalMs: 2000 })
assertSuccess(restarted, 'restart')
await verifyExternal('restart')

for (const pass of [1, 2]) {
  for (const command of task.plan.revertCommands) await execute(command, `revert-${pass}`)
}
const reverted = await client.runCommand(task.verifyReverted, { timeoutSeconds: 300 })
assertSuccess(reverted, 'verify-reverted')
const finalInventory = await client.macosExecutionInventory()
if (!finalInventory.docker.daemonReachable || !finalInventory.docker.composeAvailable) throw new Error('shared Colima substrate was not preserved')
console.log(`WEBMINAI_MACOS_${application.toUpperCase().replaceAll('-', '_')}_LIFECYCLE_OK`)

async function execute (command, phase) {
  console.log(`[${application}][${phase}][${command.id}] starting`)
  const result = command.executionMode === 'job'
    ? await client.runJob(command.command, { timeoutSeconds: Math.ceil(command.timeoutMs / 1000), pollIntervalMs: 2000 })
    : await client.runCommand(command.command, { timeoutSeconds: Math.ceil(command.timeoutMs / 1000) })
  console.log(`[${application}][${phase}][${command.id}] ${result.exitCode}/${result.state ?? 'completed'}`)
  assertSuccess(result, `${phase}/${command.id}`)
}

async function verifyExternal (phase) {
  let evidence = ''
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://${externalAddress}:${definition.port}${definition.path ?? '/'}`, { signal: AbortSignal.timeout(5000) })
      evidence = await response.text()
      if (response.ok && evidence.includes(definition.marker)) {
        console.log(`[${application}][${phase}][external] ok`)
        return
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`${application} external marker did not become ready after ${phase}`)
}

function assertSuccess (result, phase) {
  if (result.exitCode === 0 && !['failed', 'cancelled', 'timed_out', 'orphaned'].includes(result.state)) return
  const stdout = String(result.stdout ?? '').trim().slice(-3000)
  const stderr = String(result.stderr ?? '').trim().slice(-3000)
  throw new Error(`${application} ${phase} failed: exit=${result.exitCode} state=${result.state ?? 'completed'}\nstdout=${stdout}\nstderr=${stderr}`)
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
