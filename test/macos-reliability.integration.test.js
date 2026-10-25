import assert from 'node:assert/strict'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient, createSignedCommand } from '../src/netdata-client.js'
import { commonTaskRecoverySupported, retrieveRecoveryExecution, regenerateCommonTaskRecovery } from '../src/remote-common-task-recovery.js'
import { runProcess } from '../src/process-runner.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { TaskStore } from '../src/task-store.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { RemoteRecoveryTransport } from '../src/remote-recovery-transport.js'

test('opt-in disposable macOS signed execution and durable observation', {
  skip: process.env.INTENT_MACOS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 120000
}, async t => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const settings = await store.load()
  const server = await store.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: 'macos-lab' })
  let ssh = new SystemSsh()
  const open = () => ssh.acquireSession(server.connectionUrl, { authentication: server.authentication, credential: server.sshCredential })
  let lease = await open()
  let client = new NetdataClient({ ssh: lease.ssh, connectionUrl: server.connectionUrl, actionKey: server.actionKey })
  try {
    assert.equal(await lease.ssh.hostFingerprint(server.connectionUrl), server.hostFingerprint)
    assert.equal((await client.health()).platform, 'macos')
    await t.test('native signed commands preserve nonzero exit status', async () => {
      const result = await client.runCommand('exit 7')
      assert.equal(result.exitCode, 7)
    })
    await t.test('a signed command envelope cannot be replayed', async () => {
      const body = createSignedCommand('printf MACOS_REPLAY_PROBE', server.actionKey)
      const endpoint = '/api/v3/function?function=webminai%3Acommand&timeout=10'
      assert.equal((await client.postJson(endpoint, body)).exitCode, 0)
      await assert.rejects(client.postJson(endpoint, body))
    })
    await t.test('host evidence has native boot identity and filesystem capacity', async () => {
      const evidence = await client.collectExecutionEvidence()
      assert.equal(evidence.platform, 'macos')
      assert.equal(evidence.availability, 'available')
      assert.equal(evidence.bootEvidence, 'available')
      assert.equal(evidence.filesystemEvidence, 'available')
      assert.equal(evidence.memoryEvidence, 'unsupported')
    })
    await t.test('idle pooled masters expire and a later lease establishes a new master', async () => {
      const pool = new SystemSsh({ transport: { idleTimeoutSeconds: 1 } })
      try {
        const options = { authentication: server.authentication, credential: server.sshCredential }
        const first = await pool.acquireSession(server.connectionUrl, options)
        assert.equal(await first.ssh.hostFingerprint(server.connectionUrl), server.hostFingerprint)
        await first.close()
        for (let attempt = 0; attempt < 40 && pool.sessions.diagnostics().idleMasters; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
        assert.equal(pool.sessions.diagnostics().idleMasters, 0)
        const second = await pool.acquireSession(server.connectionUrl, options)
        try {
          assert.equal(await second.ssh.hostFingerprint(server.connectionUrl), server.hostFingerprint)
          assert.equal(pool.sessions.diagnostics().mastersEstablished, 2)
          assert.equal(pool.sessions.diagnostics().cleanupFailures, 0)
        } finally { await second.close() }
      } finally { await pool.closeSessions() }
    })
    await t.test('authoritative deadline is distinct from explicit cancellation', async () => {
      const timedOut = await client.runJob('sleep 5', { timeoutSeconds: 1, pollIntervalMs: 100 })
      assert.equal(timedOut.state, 'timed_out')
      assert.equal(timedOut.timedOut, true)
      const controller = new AbortController()
      const cancelled = await client.runJob('sleep 10', { timeoutSeconds: 20, pollIntervalMs: 100, signal: controller.signal, onStarted: () => controller.abort() })
      assert.equal(cancelled.state, 'cancelled')
      assert.equal(cancelled.timedOut, false)
    })
    await t.test('an existing durable job can be retrieved over a new SSH connection', async () => {
      const started = await client.startJob('sleep 2; printf MACOS_DURABLE_PROBE', { timeoutSeconds: 15 })
      await lease.close()
      await ssh.closeSessions()
      ssh = new SystemSsh()
      lease = await open()
      client = new NetdataClient({ ssh: lease.ssh, connectionUrl: server.connectionUrl, actionKey: server.actionKey })
      let status
      for (let attempt = 0; attempt < 30; attempt++) {
        status = await client.jobStatus(started.jobId)
        if (status.state !== 'running') break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.equal(status.state, 'succeeded')
      assert.equal(status.exitCode, 0)
      assert.equal(status.stdout, 'MACOS_DURABLE_PROBE')
      await client.cleanupJob(started.jobId)
    })
    await t.test('lost SSH master reconnects without restarting the durable job', async () => {
      let starts = 0
      const start = client.startJob.bind(client)
      client.startJob = (...args) => { starts++; return start(...args) }
      try {
        const result = await client.runJob('sleep 3; printf MACOS_RECONNECT_PROBE', {
          timeoutSeconds: 20,
          pollIntervalMs: 100,
          retainResult: true,
          onStarted: async () => {
            assert.match(lease.ssh.controlPath, /^\/tmp\/wmai-ssh-[A-Za-z0-9]+\/control$/u)
            const closed = await runProcess('ssh', ['-S', lease.ssh.controlPath, '-O', 'exit', 'mac@172.30.0.2'], { timeoutMs: 5000 })
            assert.equal(closed.code, 0)
          }
        })
        assert.equal(starts, 1)
        assert.equal(result.state, 'succeeded')
        assert.equal(result.stdout, 'MACOS_RECONNECT_PROBE')
        await client.cleanupJob(result.jobId)
      } finally { client.startJob = start }
    })
    await t.test('unaudited macOS recovery profiles remain unavailable', () => {
      for (const id of ['wordpress-macos', 'colima-macos', 'intent-ai-ops-macos']) assert.equal(commonTaskRecoverySupported(id, 'macos'), false)
    })
    await t.test('fresh public trust state discovers and verifies signed common-task records without granting recovery', async () => {
      const tasks = new TaskStore(store.dataRoot, { directoryAliases: new Map([['macos-lab', server.historyId]]) })
      const source = tasks.list('macos-lab', { limit: 100 }).find(task => task.status === 'reverted' && task.catalogId?.endsWith('-macos'))
      assert.ok(source, 'A reviewed and reverted catalog cycle must precede this acceptance check')
      const saved = new RemoteRecoveryState(store.dataRoot).get(server.hostFingerprint, source.id)
      assert.ok(saved)
      const directory = await mkdtemp('/tmp/imac-trust-')
      try {
        assert.equal(await lease.ssh.hostFingerprint(server.connectionUrl), server.hostFingerprint)
        const verified = await retrieveRecoveryExecution({ transport: new RemoteRecoveryTransport({ client, platform: 'macos' }), state: new RemoteRecoveryState(directory), target: server.hostFingerprint, executionId: saved.manifest.executionId, timeoutMs: 60000 })
        assert.ok(verified.records.length)
        assert.ok(verified.records.every(record => record.platform === 'macos' && record.catalogId === source.catalogId))
        const serialized = JSON.stringify(verified.records)
        for (const secret of [process.env.VAULT_TEST, server.sshCredential, server.actionKey].filter(Boolean)) assert.equal(serialized.includes(secret), false)
        assert.throws(() => regenerateCommonTaskRecovery({ records: verified.records, head: verified.head, options: { platform: 'macos' } }), /baseline validation is not registered/u)
      } finally { await rm(directory, { recursive: true, force: true }) }
    })
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
