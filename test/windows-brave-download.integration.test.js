import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWindowsBraveTask } from '../src/windows-brave-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in Windows Brave observes one durable transfer without restarting it', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const command = buildWindowsBraveTask(901, { platform: 'windows' }).plan.commands.find(item => item.id === 'wait-brave-download').command
    .replaceAll('exit 75', "return 'FIXTURE_EXIT_75'").replaceAll('exit 0', 'return')
  assert.doesNotMatch(command, /Start-BitsTransfer/u)
  const fixture = [
    "$ErrorActionPreference='Stop';$script:completed=0",
    'function Test-Path {param($LiteralPath,$PathType);return $false}',
    'function Get-Content {param($LiteralPath,[switch]$Raw);return \'{"preExisting":false}\'}',
    'function Import-Module {param($Name,$ErrorAction)}',
    'function Get-BitsTransfer {param($Name,$ErrorAction);return $script:jobs}',
    'function Complete-BitsTransfer {param($BitsJob);$script:completed++}',
    `$poll=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString('base64')}')))`,
    "$script:jobs=@(@{JobState='Transferring';BytesTransferred=10;BytesTotal=100});$out=@(& $poll);if($out -notcontains 'download-pending state=Transferring bytes=10/100' -or $out -notcontains 'FIXTURE_EXIT_75' -or $script:completed -ne 0){throw 'Running transfer was not preserved'}",
    "$script:jobs[0].JobState='TransientError';$out=@(& $poll);if($out -notcontains 'download-pending state=TransientError bytes=10/100' -or $script:completed -ne 0){throw 'Transient transfer was not preserved'}",
    "$script:jobs[0].JobState='Transferred';$out=@(& $poll);if($out -notcontains 'download-completed' -or $script:completed -ne 1){throw 'Transferred file was not acknowledged'}",
    "$script:jobs[0].JobState='Error';$blocked=$false;try{& $poll}catch{$blocked=$true};if(-not $blocked -or $script:completed -ne 1){throw 'Failed transfer was silently completed'}",
    "$script:jobs=@($script:jobs[0],$script:jobs[0]);$blocked=$false;try{& $poll}catch{$blocked=$true};if(-not $blocked){throw 'Duplicate transfer was silently selected'}",
    "Write-Output 'WINDOWS_BRAVE_TRANSFER_FIXTURE_OK'"
  ].join('\n')
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    const result = await client.runCommand(fixture, { timeoutSeconds: 30 })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'WINDOWS_BRAVE_TRANSFER_FIXTURE_OK')
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
