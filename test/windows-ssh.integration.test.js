import assert from 'node:assert/strict'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

test('opt-in Windows SSH leases reuse, concurrency and idle expiry', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 90000
}, async () => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh({ transport: { idleTimeoutSeconds: 1 } })
  const options = { authentication: host.authentication, credential: host.sshCredential }
  const leases = []
  const check = async lease => assert.equal((await lease.ssh.execute(host.connectionUrl, 'echo WIN_SSH_REUSE')).stdout.trim(), 'WIN_SSH_REUSE')
  try {
    leases.push(...await Promise.all([1, 2, 3].map(() => ssh.acquireSession(host.connectionUrl, options))))
    assert.equal(await leases[0].ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    assert.equal(ssh.sessions.diagnostics().mastersEstablished, 1)
    assert.equal(ssh.sessions.diagnostics().reuseHits, 2)
    await leases[0].close()
    for (let n = 0; n < 5; n++) await check(leases[1])
    await Promise.all(Array.from({ length: 10 }, () => check(leases[2])))
    await leases[1].close()
    await check(leases[2])
    await leases[2].close()
    for (let n = 0; n < 50 && ssh.sessions.diagnostics().idleMasters; n++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(ssh.sessions.diagnostics().idleMasters, 0)
    const replacement = await ssh.acquireSession(host.connectionUrl, options)
    leases.push(replacement)
    await check(replacement)
    assert.equal(ssh.sessions.diagnostics().mastersEstablished, 2)
    assert.equal(ssh.sessions.diagnostics().cleanupFailures, 0)
  } finally {
    await Promise.allSettled(leases.map(lease => lease.close()))
    await ssh.closeSessions()
  }
})
