import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWindowsDockerBootstrapTask } from '../src/windows-docker-bootstrap-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in native Docker memory and reboot guards fail safely before runtime checks', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const plan = buildWindowsDockerBootstrapTask(1, { platform: 'windows' }, {}).plan
  const guard = plan.commands.find(item => item.id === 'preflight').command.split(';$statePath=')[0]
  const preflight = plan.commands.find(item => item.id === 'preflight').command
  const rebootGuard = plan.commands.find(item => item.id === 'wait-docker-ready').command.split(';$docker=')[0].replaceAll('exit 0', 'return')
  assert.ok(!guard.includes('New-Item'))
  assert.ok(rebootGuard.includes('WEBMINAI_REBOOT_REQUIRED'))
  const fixture = [
    "$ErrorActionPreference='Stop'",
    'function Get-CimInstance {param($ClassName,$ErrorAction);switch($ClassName){Win32_OperatingSystem{return @{ProductType=1;BuildNumber=26200}};Win32_ComputerSystem{return @{TotalPhysicalMemory=8584982528;HypervisorPresent=$true}};Win32_Processor{return @{SecondLevelAddressTranslationExtensions=$true}};Win32_PhysicalMemory{if($script:denied){throw \'Fixture memory access denied\'};return [pscustomobject]@{Capacity=$script:capacity}};default{throw \'Unexpected CIM class\'}}}',
    `$guard=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(guard).toString('base64')}')))`,
    '$script:capacity=8GB; & $guard',
    "$script:capacity=7GB;$blocked=$false;try{& $guard}catch{if($_.Exception.Message -notlike 'INSUFFICIENT_MEMORY:*'){throw};$blocked=$true};if(-not $blocked){throw 'Insufficient memory was accepted'}",
    "$script:denied=$true;$blocked=$false;try{& $guard}catch{if($_.Exception.Message -ne 'Fixture memory access denied'){throw};$blocked=$true};if(-not $blocked){throw 'Denied memory evidence was accepted'}",
    'function Get-Content {param($LiteralPath,[switch]$Raw);return \'{"rebootRequired":true}\'}',
    "function Test-Path {param($LiteralPath,$PathType);throw 'Runtime checked before required reboot'}",
    `$rebootGuard=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(rebootGuard).toString('base64')}')))`,
    "$out=@(& $rebootGuard);if($out -notcontains 'WEBMINAI_REBOOT_REQUIRED'){throw 'Required reboot was not surfaced'}",
    '$script:denied=$false;$script:capacity=8GB',
    'function Test-Path {param($LiteralPath,$PathType);return $false}',
    'function New-Item {param($Path,$ItemType,[switch]$Force)}',
    "function Get-WindowsOptionalFeature {param([switch]$Online,$FeatureName,$ErrorAction);return [pscustomobject]@{State='Disabled'}}",
    'function Set-Content {param($LiteralPath,[Parameter(ValueFromPipeline=$true)]$Value,$Encoding);process{$script:captured=$Value}}',
    `$preflight=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(preflight).toString('base64')}')))`,
    "$null=& $preflight;$baseline=$script:captured|ConvertFrom-Json;if($baseline.version-ne 2-or$baseline.dockerPathPresent-isnot[bool]){throw 'Docker PATH ownership baseline was not captured'};if($script:captured-match'FIRST|%SystemRoot%|MachinePath'){throw 'Raw environment data leaked into baseline'}",
    "Write-Output 'WINDOWS_DOCKER_MEMORY_OK'"
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
    assert.equal(result.stdout.trim(), 'WINDOWS_DOCKER_MEMORY_OK')
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
