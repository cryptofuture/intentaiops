import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWindowsBraveTask } from '../src/windows-brave-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in Windows Brave rollback verifies its publisher and uninstalls without a Session 0 prompt', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const command = buildWindowsBraveTask(901, { platform: 'windows' }).plan.revertCommands[0].command
  const fixture = [
    "$ErrorActionPreference='Stop';$script:started=0;$script:removed=0;$script:valid=$true;$script:installed=$true;$script:exitCode=0;$script:remains=$false",
    "function Test-Path {param($LiteralPath);if($LiteralPath -like '*brave.exe'){return $script:installed};return $true}",
    'function Get-ItemProperty {param($Path,$ErrorAction);if($script:installed){return [pscustomobject]@{DisplayName=\'Brave\';QuietUninstallString=\'\';UninstallString=$script:uninstall}}}',
    "function Get-AuthenticodeSignature {param($LiteralPath);return @{Status=$(if($script:valid){'Valid'}else{'NotTrusted'});SignerCertificate=@{Subject='CN=Brave Software Inc'}}}",
    "function Start-Process {param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru);if($FilePath -ne 'C:\\Fixture\\setup.exe' -or $ArgumentList -notmatch '--force-uninstall' -or $ArgumentList -match '--delete-profile' -or -not $Wait -or -not $PassThru){throw 'Unsafe uninstaller invocation'};$script:started++;if($script:exitCode -in @(0,19) -and -not $script:remains){$script:installed=$false};return @{ExitCode=$script:exitCode}}",
    'function Import-Module {param($Name,$ErrorAction)}',
    'function Get-BitsTransfer {param($Name,$ErrorAction);return @()}',
    "function Remove-Item {param($LiteralPath,[switch]$Recurse,[switch]$Force);if($LiteralPath -ne 'C:\\ProgramData\\WebminAI\\Tasks\\901-brave'){throw 'Unexpected cleanup target'};$script:removed++}",
    `$rollback=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString('base64')}')))`,
    "$script:uninstall='\"C:\\Fixture\\setup.exe\" --uninstall --system-level';$out=@(& $rollback);if($script:started -ne 1 -or $script:removed -ne 1 -or $out -notcontains 'task-owned-brave-removed'){throw 'Silent rollback failed'}",
    "$script:installed=$true;$script:exitCode=19;$out=@(& $rollback);if($script:started -ne 2 -or $script:removed -ne 2 -or $out -notcontains 'task-owned-brave-removed'){throw 'Successful uninstall status19 was rejected'}",
    "$script:installed=$true;foreach($code in @(20,29)){$script:exitCode=$code;$blocked=$false;try{& $rollback}catch{$blocked=$true};if(-not $blocked -or $script:removed -ne 2){throw 'Failed or reboot-pending uninstall accepted'}}",
    "$script:exitCode=19;$script:remains=$true;$blocked=$false;try{& $rollback}catch{$blocked=$true};if(-not $blocked -or $script:removed -ne 2){throw 'Remaining installation was ignored'};$script:remains=$false;$script:started=1;$script:removed=1",
    "$script:valid=$false;$blocked=$false;try{& $rollback}catch{$blocked=$true};if(-not $blocked -or $script:started -ne 1 -or $script:removed -ne 1){throw 'Untrusted uninstaller was accepted'}",
    "$script:valid=$true;$script:uninstall+=' --delete-profile';$blocked=$false;try{& $rollback}catch{$blocked=$true};if(-not $blocked -or $script:started -ne 1 -or $script:removed -ne 1){throw 'Profile deletion was accepted'}",
    "Write-Output 'WINDOWS_BRAVE_ROLLBACK_FIXTURE_OK'"
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
    assert.equal(result.stdout.trim(), 'WINDOWS_BRAVE_ROLLBACK_FIXTURE_OK')
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
