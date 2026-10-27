import assert from 'node:assert/strict'
import test from 'node:test'
import { listCommonTasks, buildCommonTask } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in native Windows parses every supported catalog script without executing it', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 180000
}, async () => {
  const execution = { platform: 'windows', identity: 'LocalSystem', docker: { cliAvailable: true, daemonReachable: true, composeAvailable: true, serverOs: 'linux', serverVersion: '28' } }
  const docker = { platform: 'windows', preference: 'auto', preferred: true, ready: true }
  const batches = [[]]
  for (const task of listCommonTasks({ platform: 'windows' })) {
    const built = buildCommonTask(task.id, 901, { platform: 'windows', windowsExecution: execution, docker, inventory: { webminaiExecution: execution } })
    const scripts = [...built.plan.commands, ...built.plan.revertCommands].map(command => ({ label: `${task.id}/${command.id}`, script: command.command }))
    for (const key of ['verifyApplied', 'verifyReverted', 'stateProbe']) if (built[key]) scripts.push({ label: `${task.id}/${key}`, script: built[key] })
    for (const script of scripts) {
      if (Buffer.byteLength(JSON.stringify([...batches.at(-1), script])) > 14000) batches.push([])
      batches.at(-1).push(script)
    }
  }
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    for (const batch of batches) {
      const payload = Buffer.from(JSON.stringify(batch)).toString('base64')
      const command = `$ErrorActionPreference='Stop';$entries=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;foreach($entry in $entries){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($entry.script,[ref]$tokens,[ref]$errors);if($errors.Count){throw ('Catalog syntax invalid: '+$entry.label+': '+$errors[0].Message)}};Write-Output ('WINDOWS_CATALOG_PARSE_OK='+$entries.Count)`
      assert.ok(Buffer.byteLength(command) <= 32768)
      const result = await client.runCommand(command, { timeoutSeconds: 30 })
      assert.equal(result.exitCode, 0, result.stderr)
      assert.equal(result.stdout.trim(), `WINDOWS_CATALOG_PARSE_OK=${batch.length}`)
    }
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
