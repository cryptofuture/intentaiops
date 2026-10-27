import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, chmod, copyFile, mkdtemp, mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { launchLabCli } from '../browser-checks/lab-cli.js'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { ServerWorkspace } from '../src/server-workspace.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'

assert.ok(process.argv.includes('--approve-live-tests'), 'Explicit disposable-host approval required')
const sourceTask = Number(process.argv.find(value => value.startsWith('--task='))?.slice(7))
assert.ok(Number.isSafeInteger(sourceTask) && sourceTask > 0)
assert.ok(process.env.VAULT_TEST)
const originalRoot = process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops'
const hostId = 'windows-lab'
const store = new SettingsStore(originalRoot)
const settings = await store.load()
const vaultDigest = createHash('sha256').update(await readFile(store.settingsPath)).digest('hex')
const host = await store.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: hostId })
const tasks = new TaskStore(originalRoot, { directoryAliases: new Map([[hostId, host.historyId ?? hostId]]) })
const original = tasks.get(hostId, sourceTask)
assert.equal(original.status, 'completed')
assert.equal(original.catalogId, 'intent-ai-ops-windows')
const source = new RemoteRecoveryState(originalRoot).get(host.hostFingerprint, sourceTask)
assert.ok(source)
const root = await mkdtemp(path.join(os.tmpdir(), 'intent-windows-fresh-cli-'))
await copyFile(store.settingsPath, path.join(root, 'settings.json'))
await chmod(path.join(root, 'settings.json'), 0o600)
const workspace = new ServerWorkspace(root)
workspace.setDirectoryAlias(hostId, host.historyId ?? hostId)
await workspace.ensureInitialized(hostId, rootExecutionPolicy())
process.env.INTENT_WEB_DATA_ROOT = root
const checkpoint = new URL('../docs/windows-lab-validation-status.md', import.meta.url)
const record = async message => {
  console.log(message)
  await appendFile(checkpoint, `\n- ${new Date().toISOString()} Windows CLI fresh recovery: ${message}\n`)
}
await record(`source task ${sourceTask}; isolated profile ${root}; encrypted connection settings only, no local task history or recovery pins copied`)
let cli; let browser
try {
  cli = await launchLabCli({ actions: true })
  browser = await chromium.launch({ headless: true, executablePath: process.env.INTENT_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto(cli.url)
  const api = (endpoint, body) => page.evaluate(async ({ endpoint, body }) => {
    const session = await (await fetch('session')).json()
    const response = await fetch(endpoint, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }, body: JSON.stringify(body) } : {})
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? 'Workspace request failed')
    return value
  }, { endpoint, body })
  const operation = async body => {
    const started = await api('operation', { requestKey: randomUUID(), ...body })
    const deadline = Date.now() + 240000
    for (;;) {
      const current = await api('operation?id=' + started.id)
      if (current.status === 'failed') throw new Error(current.error)
      if (current.status === 'completed') return current.result
      assert.ok(Date.now() < deadline, 'Recovery operation exceeded observation deadline; inspect its durable state without replay')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  assert.deepEqual(new TaskStore(root).list(host.historyId ?? hostId), [])
  assert.equal(new RemoteRecoveryState(root).currentKey(host.hostFingerprint), null)
  const proposal = await operation({ action: 'prepare-remote-recovery', hostId, executionId: source.manifest.executionId })
  assert.equal(proposal.sourceExecutionId, source.manifest.executionId)
  assert.equal(proposal.plan.commands.length, 1)
  assert.match(proposal.plan.commands[0].command, /RECOVERY_BASELINE_CHANGED/u)
  await record(`prepared recovery task ${proposal.taskId} from signed task ${sourceTask}; no execution approval yet`)
  await page.reload()
  const review = await api(`task?host=${hostId}&task=${proposal.taskId}`)
  assert.equal(review.task.status, 'planned')
  await assert.rejects(operation({ action: 'execute-remote-recovery', hostId, taskId: proposal.taskId, expectedVersion: review.stateVersion, fingerprint: '0'.repeat(64), approved: true }), /fingerprint/u)
  assert.equal(new TaskStore(root).executionEvents(host.historyId ?? hostId, proposal.taskId).length, 0)
  const screenshots = path.resolve('artifacts/browser-screenshots/windows-fresh-cli-recovery')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: path.join(screenshots, 'fresh-profile-before-recovery.png'), fullPage: true })
  await operation({ action: 'execute-remote-recovery', hostId, taskId: proposal.taskId, expectedVersion: review.stateVersion, fingerprint: review.fingerprint, approved: true })
  const completed = await api(`task?host=${hostId}&task=${proposal.taskId}`)
  assert.equal(completed.task.status, 'completed')
  assert.equal(completed.commands.filter(item => item.status === 'completed').length, 1)
  await record(`recovery task ${proposal.taskId} completed after separate exact-fingerprint approval; source task was not imported as local execution`)
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    const built = buildCommonTask('intent-ai-ops-windows', sourceTask, { platform: 'windows' })
    const result = await client.runCommand(built.stateProbe, { timeoutSeconds: 30 })
    assert.equal(result.exitCode, 0)
    const digest = createHash('sha256').update(result.stdout).digest('hex')
    const log = await readFile(checkpoint, 'utf8')
    const before = log.match(new RegExp(`intent-ai-ops-windows: task ${sourceTask} baselineSHA256=([a-f0-9]{64})`, 'u'))?.[1]
    assert.ok(before)
    assert.equal(digest, before, 'Fresh recovery did not restore the original trusted probe baseline')
    assert.equal((await client.runCommand(built.verifyReverted, { timeoutSeconds: 30 })).exitCode, 0)
    assert.equal(createHash('sha256').update(await readFile(store.settingsPath)).digest('hex'), vaultDigest, 'Normal vault settings changed')
    assert.deepEqual(tasks.get(hostId, sourceTask).results, original.results, 'Original completed history changed')
    await record(`source task ${sourceTask} exact trusted-probe baseline restored; normal vault unchanged; isolated recovery history retained at ${root}`)
  } finally { await lease.close(); await ssh.closeSessions() }
} finally { await browser?.close(); await cli?.close() }
