#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { runProcess } from '../src/process-runner.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const SERVER_ID = process.env.WEBMINAI_TEST_SERVER ?? 'windows-11'

async function main () {
  if (!process.env.VAULT_TEST || !(process.env.SSH_HOST_PWD || process.env.SSH_HOST_1)) {
    throw new Error('VAULT_TEST and SSH_HOST_PWD (or SSH_HOST_1) are required')
  }
  const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
  const settingsStore = new SettingsStore(dataRoot)
  const settings = await settingsStore.load()
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID })
  const environment = {
    ...process.env,
    SSH_HOST_1: process.env.SSH_HOST_PWD ?? process.env.SSH_HOST_1,
    SSH_ASKPASS: path.resolve('scripts/webminai-askpass.sh'),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: 'webminai-askpass'
  }
  const baseSsh = new SystemSsh({
    interactiveRunner: (command, args, options = {}) => runProcess('setsid', ['-w', command, ...args], { ...options, env: environment }),
    terminalCheck: () => true
  })
  const session = await baseSsh.openInteractiveSession(server.connectionUrl, { authentication: server.authentication ?? 'password' })
  try {
    const admin = new AdminService({ dataRoot, ssh: session.ssh, settings: settingsStore })
    const activation = await admin.activate({
      settings,
      passphrase: process.env.VAULT_TEST,
      serverId: SERVER_ID,
      elevation: 'windows-admin',
      installNetdata: false
    })
    assert.equal(activation.observed?.health?.version, '0.7.2')
    const netdata = admin.netdata(server)
    const health = await netdata.health()
    assert.equal(health.version, '0.7.2')
    assert.equal(health.isLocalSystem, true)
    assert.equal(health.durableJobs, true)
    assert.equal(health.maxConcurrentJobs, 4)

    const completed = await netdata.runJob("Start-Sleep -Seconds 1; Write-Output 'WEBMINAI_JOB_OK'", {
      timeoutSeconds: 30,
      pollIntervalMs: 250
    })
    assert.equal(completed.exitCode, 0)
    assert.equal(completed.stdout.trim(), 'WEBMINAI_JOB_OK')

    const restarted = await netdata.runJob("Restart-Service -Name Netdata -Force; Start-Sleep -Seconds 3; Write-Output 'WEBMINAI_RESTART_JOB_OK'", {
      timeoutSeconds: 60,
      pollIntervalMs: 500,
      statusErrorAttempts: 60
    })
    assert.equal(restarted.exitCode, 0)
    assert.equal(restarted.stdout.trim(), 'WEBMINAI_RESTART_JOB_OK')

    const cancellation = await netdata.startJob("Write-Output 'started'; Start-Sleep -Seconds 120; Write-Output 'must-not-run'", { timeoutSeconds: 180 })
    const cancelResult = await netdata.cancelJob(cancellation.jobId)
    assert.equal(cancelResult.state, 'cancelled')
    const cancelled = await netdata.jobStatus(cancellation.jobId)
    assert.equal(cancelled.state, 'cancelled')
    await netdata.cleanupJob(cancellation.jobId)

    const acl = await netdata.runCommand("$acl=Get-Acl -LiteralPath 'C:\\ProgramData\\WebminAI\\jobs'; Write-Output $acl.Sddl", { timeoutSeconds: 15 })
    assert.equal(acl.exitCode, 0)
    assert.match(acl.stdout, /^O:.*D:P/u)
    assert.match(acl.stdout, /\(A;;FA;;;SY\)/u)
    assert.match(acl.stdout, /\(A;;FA;;;BA\)/u)
    process.stdout.write('WINDOWS_DURABLE_JOBS_OK plugin=0.7.2 restart=recovered cancel=cleaned acl=protected\n')
  } finally {
    await session.close()
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
