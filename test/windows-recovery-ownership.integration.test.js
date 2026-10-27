import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { RemoteRecoveryTransport } from '../src/remote-recovery-transport.js'

test('opt-in Windows recovery ownership rejects competing owners, stale heads and local-ID collisions', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 120000
}, async () => {
  const root = process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops'
  const store = new SettingsStore(root)
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const tasks = new TaskStore(root, { directoryAliases: new Map([['windows-lab', host.historyId ?? 'windows-lab']]) })
  assert.equal(tasks.get('windows-lab', 13).status, 'reverted', 'Never claim ownership of unfinished work')
  const saved = new RemoteRecoveryState(root).get(host.hostFingerprint, 13)
  assert.ok(saved, 'Completed reverted CLI task13 is required')
  const state = { executionId: saved.manifest.executionId, taskId: 13, sequence: saved.sequence, head: saved.head }
  const owner = randomBytes(16).toString('hex')
  const competitor = randomBytes(16).toString('hex')
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  let transport
  let claimed = false
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    transport = new RemoteRecoveryTransport({ client, platform: 'windows' })
    const second = new RemoteRecoveryTransport({ client, platform: 'windows' })
    assert.equal((await transport.ownership(state)).owned, false, 'Never take over an existing owner')
    const key = await transport.key()
    await transport.claim({ ...state, owner })
    claimed = true
    await assert.rejects(second.claim({ ...state, owner: competitor }), /Remote recovery claim failed/u)
    await assert.rejects(second.claim({ ...state, owner: competitor, head: '0'.repeat(64) }), /Remote recovery claim failed/u)
    await assert.rejects(second.release({ ...state, owner: competitor }), /Remote recovery release failed/u)
    const held = await transport.ownership(state)
    assert.equal(held.ownerFingerprint, createHash('sha256').update(owner).digest('hex'))
    await assert.rejects(second.claim({ executionId: randomBytes(16).toString('hex'), taskId: 13, sequence: 0, head: null, owner: competitor }), /Remote recovery claim failed/u)
    assert.equal((await transport.key()).fingerprint, key.fingerprint)
  } finally {
    try {
      if (claimed) {
        await transport.release({ ...state, owner })
        assert.equal((await transport.ownership(state)).owned, false)
      }
    } finally {
      await lease.close()
      await ssh.closeSessions()
    }
  }
})
