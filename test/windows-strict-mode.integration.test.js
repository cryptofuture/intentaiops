import assert from 'node:assert/strict'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in Windows runner accepts strict-mode cmdlets and preserves explicit native status', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    const pure = await client.runCommand("Set-StrictMode -Version Latest;Write-Output 'WINDOWS_STRICT_MODE_OK'", { timeoutSeconds: 30 })
    assert.equal(pure.exitCode, 0, pure.stderr)
    assert.equal(pure.stdout.trim(), 'WINDOWS_STRICT_MODE_OK')
    const nonzero = await client.runCommand('Set-StrictMode -Version Latest;$global:LASTEXITCODE=23', { timeoutSeconds: 30 })
    assert.equal(nonzero.exitCode, 23)
    const explicit = await client.runCommand('Set-StrictMode -Version Latest;exit 37', { timeoutSeconds: 30 })
    assert.equal(explicit.exitCode, 37)
    const native = await client.runCommand('exit -1073741819', { timeoutSeconds: 30 })
    assert.equal(native.exitCode, -1073741819)
    assert.equal(native.exitCode >>> 0, 3221225477)
    const job = await client.runJob("Set-StrictMode -Version Latest;Write-Output 'WINDOWS_STRICT_JOB_OK'", { timeoutSeconds: 30 })
    assert.equal(job.state, 'succeeded', job.stderr)
    assert.equal(job.stdout.trim(), 'WINDOWS_STRICT_JOB_OK')
    const failedJob = await client.runJob('exit -1073741801', { timeoutSeconds: 30, retainResult: true })
    try {
      assert.equal(failedJob.state, 'failed')
      assert.equal(failedJob.exitCode >>> 0, 3221225495)
      assert.equal((await client.jobStatus(failedJob.jobId)).exitCode, failedJob.exitCode)
    } finally { await client.cleanupJob(failedJob.jobId) }
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
