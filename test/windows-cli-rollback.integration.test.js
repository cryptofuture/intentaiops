import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIntentAiOpsInstallTask } from '../src/intent-ai-ops-install-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in Windows CLI rollback preserves raw PATH, registry types and refuses concurrent changes', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const built = buildIntentAiOpsInstallTask(901, 'windows')
  const command = built.plan.revertCommands[0].command
    .replaceAll("[Environment]::GetEnvironmentVariable('Path',$scope)", '(Get-FixturePath $scope)')
  assert.doesNotMatch(command, /\[Environment\]::SetEnvironmentVariable/u)
  const fixture = [
    "$ErrorActionPreference='Stop'",
    "$script:original=@{version=2;Machine=@{raw='%SystemRoot%\\Machine;;';kind='ExpandString';value='C:\\Windows\\Machine;;'};User=@{raw='C:\\User;';kind='String';value='C:\\User;'}};$script:changed=@{};$script:removed=@()",
    'function Test-Path {param($LiteralPath,$PathType);return $true}',
    "function Get-Item {param($LiteralPath);if($LiteralPath -notlike 'Registry::*'){return @{Length=100;FullName='fixture-baseline.json'}};$scope=if($LiteralPath -like '*HKEY_LOCAL_MACHINE*'){'Machine'}else{'User'};$key=[pscustomobject]@{Scope=$scope};$key|Add-Member ScriptMethod GetValue {param($name,$default,$options);return $script:raw[$this.Scope]};$key|Add-Member ScriptMethod GetValueKind {param($name);return $script:kind[$this.Scope]};$key|Add-Member ScriptMethod OpenSubKey {param($name,$write);if(-not $write){throw 'Registry is read-only'};return $this};$key|Add-Member ScriptMethod SetValue {param($name,$value,$kind);$script:changed[$this.Scope]=@{raw=$value;kind=[string]$kind}};$key|Add-Member ScriptMethod DeleteValue {param($name,$missing);$script:changed[$this.Scope]=@{raw=$null;kind=$null}};$key|Add-Member ScriptMethod Flush {};$key|Add-Member ScriptMethod Close {};return $key}",
    'function Get-Content {param($LiteralPath,[switch]$Raw);return ($script:original|ConvertTo-Json -Depth 4 -Compress)}',
    'function Get-FixturePath($scope){return $script:current[$scope]}',
    "function Remove-Item {param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction);if($LiteralPath -notin @('" + built.plan.modifiedFiles[0] + "','" + built.plan.modifiedFiles[1] + "')){throw 'Unexpected deletion target'};$script:removed+=$LiteralPath}",
    `$rollback=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString('base64')}')))`,
    "$bin='" + built.plan.modifiedFiles[1] + "\\bin';$script:current=@{Machine='C:\\Windows\\Machine;'+$bin;User='C:\\User;'+$bin};$script:raw=$script:current.Clone();$script:kind=@{Machine='String';User='String'}",
    '& $rollback',
    "foreach($scope in @('Machine','User')){if($script:changed[$scope].raw -cne $script:original[$scope].raw -or $script:changed[$scope].kind -cne $script:original[$scope].kind){throw 'Original PATH registry data was not restored'}};if($script:removed.Count -ne 2){throw 'Task data was not cleaned'}",
    "$script:changed=@{};$script:removed=@();$script:current.Machine+=';C:\\Unrelated';$blocked=$false;try{& $rollback}catch{if($_.Exception.Message -notlike 'PATH_CHANGED:*'){throw};$blocked=$true};if(-not $blocked -or $script:changed.Count -ne 0 -or $script:removed.Count -ne 0){throw 'Concurrent changes were overwritten'}",
    "$script:current=$script:raw.Clone();$script:raw.Machine='%SystemRoot%\\Unrelated';$blocked=$false;try{& $rollback}catch{if($_.Exception.Message -notlike 'PATH_CHANGED:*'){throw};$blocked=$true};if(-not $blocked -or $script:changed.Count -ne 0){throw 'Raw registry changes were overwritten'}",
    "$script:raw=$script:current.Clone();$script:original.Machine.kind='Binary';$blocked=$false;try{& $rollback}catch{if($_.Exception.Message -ne 'Invalid PATH baseline'){throw};$blocked=$true};if(-not $blocked -or $script:changed.Count -ne 0){throw 'Invalid registry metadata was accepted'};$script:original.Machine.kind='ExpandString'",
    "$script:original.version=1;$blocked=$false;try{& $rollback}catch{if($_.Exception.Message -notlike 'PATH baseline lacks registry metadata*'){throw};$blocked=$true};if(-not $blocked -or $script:changed.Count -ne 0){throw 'Legacy baseline was silently reinterpreted'};$script:original.version=2",
    "$script:original.User=$null;$blocked=$false;try{& $rollback}catch{if($_.Exception.Message -ne 'Invalid PATH baseline'){throw};$blocked=$true};if(-not $blocked -or $script:changed.Count -ne 0){throw 'Missing baseline scope was accepted'}",
    "Write-Output 'WINDOWS_CLI_ROLLBACK_OK'"
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
    assert.equal(result.stdout.trim(), 'WINDOWS_CLI_ROLLBACK_OK')
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
