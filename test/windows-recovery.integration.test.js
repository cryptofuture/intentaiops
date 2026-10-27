import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { RemoteRecoveryTransport } from '../src/remote-recovery-transport.js'
import { retrieveRecoveryExecution, commonTaskRecoverySupported } from '../src/remote-common-task-recovery.js'
import { verifyRecoveryRecord } from '../src/remote-recovery-record.js'
import { AdminService } from '../src/admin-service.js'

test('opt-in Windows fresh trust verifies CNG records and rejects unsupported destructive recovery without mutation', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 120000
}, async () => {
  const root = process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops'
  const store = new SettingsStore(root)
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const originalState = new RemoteRecoveryState(root)
  const saved = originalState.get(host.hostFingerprint, Number(process.env.INTENT_WINDOWS_RECOVERY_TASK ?? 30))
  assert.ok(saved, 'An existing completed common-task ledger is required')
  const originalKey = originalState.currentKey(host.hostFingerprint)
  assert.ok(originalKey)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'intent-windows-recovery-'))
  const freshState = new RemoteRecoveryState(temporary)
  const ssh = new SystemSsh()
  let lease
  try {
    lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    const transport = new RemoteRecoveryTransport({ client, platform: 'windows' })
    const operations = []
    const request = transport.request.bind(transport)
    transport.request = async (operation, parameters) => {
      assert.ok(['key', 'list', 'read', 'read-page', 'verification-key'].includes(operation), 'Discovery attempted a remote mutation')
      operations.push(operation)
      return request(operation, parameters)
    }
    assert.equal(freshState.currentKey(host.hostFingerprint), null)
    const verified = await retrieveRecoveryExecution({ transport, state: freshState, target: host.hostFingerprint, executionId: saved.manifest.executionId, timeoutMs: 60000 })
    assert.equal(verified.sequence, saved.sequence)
    assert.equal(verified.head, saved.head)
    assert.equal(verified.records[0].platform, 'windows')
    assert.equal(verified.records[0].catalogId, saved.manifest.catalogId)
    assert.equal(freshState.currentKey(host.hostFingerprint).fingerprint, originalKey.fingerprint)
    const envelope = await transport.read(saved.manifest.executionId, 1)
    const trust = { ...originalKey, target: host.hostFingerprint, pinnedFingerprint: originalKey.fingerprint }
    assert.throws(() => verifyRecoveryRecord({ ...envelope, payload: Buffer.from('{}').toString('base64url') }, trust), /signature/u)
    assert.throws(() => verifyRecoveryRecord(envelope, { ...trust, target: `SHA256:${'0'.repeat(64)}` }), /another target/u)
    assert.equal(commonTaskRecoverySupported(saved.manifest.catalogId, 'windows'), false)
    const fresh = new AdminService({ dataRoot: temporary })
    fresh.remoteRecovery = freshState
    fresh.remoteRecoveryConnection = async () => ({ transport, target: host.hostFingerprint, client: { runCommand: () => assert.fail('Unsupported recovery attempted baseline collection or mutation') } })
    await assert.rejects(fresh.prepareRemoteCommonTaskRecovery({
      serverId: 'windows-lab',
      executionId: saved.manifest.executionId,
      options: { platform: 'windows' }
    }), /baseline validation is not registered/u)
    assert.deepEqual(fresh.listTasks('windows-lab'), [])
    assert.equal((await transport.key()).fingerprint, originalKey.fingerprint)
    assert.ok(operations.includes('read'))
  } finally {
    await lease?.close()
    await ssh.closeSessions()
    await rm(temporary, { recursive: true, force: true })
  }
})
