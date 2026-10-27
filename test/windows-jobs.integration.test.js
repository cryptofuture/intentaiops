import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh, SshCommandError } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { parseSshConnection, sshTarget } from '../src/connection.js'
import { runProcess } from '../src/process-runner.js'

test('opt-in Windows durable jobs survive client disconnect and distinguish timeout from cancellation', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 120000
}, async () => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  let ssh, lease, client
  const jobs = new Set()
  const connect = async () => {
    ssh = new SystemSsh()
    lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
  }
  const terminal = async jobId => {
    for (let poll = 0; poll < 45; poll++) {
      const status = await client.jobStatus(jobId)
      assert.equal(status.jobId, jobId)
      if (!['running', 'cancelling'].includes(status.state)) return status
      await wait(1000)
    }
    throw new Error(`Disposable job did not finish: ${jobId}`)
  }
  try {
    await connect()
    const durable = await client.startJob("Start-Sleep -Seconds 12;Write-Output 'WINDOWS_DURABLE_JOB_COMPLETE'", { timeoutSeconds: 30 })
    jobs.add(durable.jobId)
    assert.equal((await client.jobStatus(durable.jobId)).state, 'running')
    await lease.close()
    await ssh.closeSessions()
    await connect()
    const completed = await terminal(durable.jobId)
    assert.equal(completed.state, 'succeeded')
    assert.equal(completed.exitCode, 0)
    assert.equal(completed.stdout.trim(), 'WINDOWS_DURABLE_JOB_COMPLETE')

    if (process.platform === 'linux') {
      const interrupted = await client.startJob("Start-Sleep -Seconds 12;Write-Output 'WINDOWS_ABRUPT_DISCONNECT_COMPLETE'", { timeoutSeconds: 30 })
      jobs.add(interrupted.jobId)
      const command = 'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
      const channels = ssh.sessions.diagnostics().channels
      const observation = lease.ssh.execute(host.connectionUrl, command, { timeoutMs: 45000 }).then(() => null, error => error)
      await wait(1000)
      const controlPath = lease.ssh.controlPath
      assert.ok(controlPath, 'A private owned master is required for abrupt-disconnect testing')
      const checked = await runProcess('ssh', ['-S', controlPath, '-O', 'check', sshTarget(parseSshConnection(host.connectionUrl))], { timeoutMs: 5000 })
      assert.equal(checked.code, 0)
      const pid = Number((checked.stderr + checked.stdout).match(/Master running \(pid=(\d+)\)/u)?.[1])
      assert.ok(Number.isInteger(pid) && pid > 1)
      assert.equal((await readFile(`/proc/${pid}/status`, 'utf8')).match(/^Uid:\s+(\d+)/mu)?.[1], String(process.getuid()))
      assert.ok((await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').includes(controlPath))
      process.kill(pid, 'SIGKILL')
      const lost = await observation
      assert.ok(lost instanceof SshCommandError)
      assert.equal(lost.result.code, 255)
      assert.equal(lost.reconnected, true)
      assert.equal(ssh.sessions.diagnostics().channels, channels + 1, 'Interrupted command was replayed')
      assert.equal(ssh.sessions.diagnostics().reconnects, 1)
      const result = await terminal(interrupted.jobId)
      assert.equal(result.state, 'succeeded')
      assert.equal(result.stdout.trim(), 'WINDOWS_ABRUPT_DISCONNECT_COMPLETE')
    }

    const cancelled = await client.startJob('Start-Sleep -Seconds 60', { timeoutSeconds: 90 })
    jobs.add(cancelled.jobId)
    assert.equal((await client.jobStatus(cancelled.jobId)).state, 'running')
    await client.cancelJob(cancelled.jobId)
    assert.equal((await terminal(cancelled.jobId)).state, 'cancelled')

    const timed = await client.startJob('Start-Sleep -Seconds 10', { timeoutSeconds: 2 })
    jobs.add(timed.jobId)
    assert.equal((await terminal(timed.jobId)).state, 'timed_out')
  } finally {
    for (const jobId of jobs) {
      const status = await client?.jobStatus(jobId).catch(() => null)
      if (status && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status.state)) await client.cleanupJob(jobId)
    }
    await lease?.close()
    await ssh?.closeSessions()
  }
})
