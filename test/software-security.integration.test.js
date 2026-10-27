import assert from 'node:assert/strict'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { softwareSecurityCommand } from '../src/software-security-collector.js'
import { parseSecurityEvidence } from '../src/software-security.js'

test('opt-in named lab hosts run the signed read-only security collector without installing or patching software', {
  skip: process.env.INTENT_SECURITY_LIVE !== '1' || !process.env.VAULT_TEST || !process.env.INTENT_SECURITY_HOSTS,
  timeout: 180000
}, async t => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const settings = await store.load()
  const ids = process.env.INTENT_SECURITY_HOSTS.split(',')
  assert.ok(ids.length > 0 && ids.length <= 4 && ids.every(id => /^(?:windows-lab|macos-lab|webminai-(?:debian-13|freebsd-14-4|freebsd-15-1))$/u.test(id) && Object.hasOwn(settings.servers, id)), 'Select existing explicitly scoped disposable lab hosts')
  for (const id of ids) {
    await t.test(id, async () => {
      const host = await store.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: id })
      const ssh = new SystemSsh()
      const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
      try {
        assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
        const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
        const health = await client.health()
        const command = softwareSecurityCommand(health.platform, 'intent-ai-ops')
        const result = await client.runCommand(command, { timeoutSeconds: 60 })
        assert.equal(result.exitCode, 0, 'Read-only security collector did not complete')
        const evidence = parseSecurityEvidence([{ id: 'audit-software-security', status: 'completed', result }])
        assert.equal(evidence.complete, true)
        if (health.platform === 'windows') {
          const helper = command.split(';$php=')[0]
          assert.ok(helper.includes('Read-SecurityProcess'))
          const native = await client.runCommand(helper + ";Read-SecurityProcess (Join-Path $env:SystemRoot 'System32\\cmd.exe') @('/d','/c','echo','NATIVE_SECURITY_READ_OK')", { timeoutSeconds: 10 })
          assert.equal(native.exitCode, 0)
          assert.equal(native.stdout.trim(), 'NATIVE_SECURITY_READ_OK')
        }
      } finally { await lease.close(); await ssh.closeSessions() }
    })
  }
})
