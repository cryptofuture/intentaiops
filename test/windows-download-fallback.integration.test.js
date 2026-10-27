import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildWindowsBraveTask } from '../src/windows-brave-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { powershellCommand } from '../src/stage2-remote.js'

test('opt-in native PowerShell missing-curl fallback uses bounded downloads without installation', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const source = await readFile(new URL('../remote/webminai-stage2-windows.ps1', import.meta.url), 'utf8')
  const install = source.match(/function Install-Netdata \{[\s\S]*?\n\}/u)?.[0]
  assert.ok(install)
  const brave = buildWindowsBraveTask(1, { platform: 'windows' }).plan.commands[0].command
  const downloads = brave.match(/if\(Test-Path -LiteralPath \$curl -PathType Leaf\)\{.*?\}else\{Invoke-WebRequest[^}]+\}/gu)
  assert.equal(downloads?.length, 1)
  const fixture = [
    "$ErrorActionPreference='Stop'",
    '$script:downloads=@();$script:installs=0;$script:cleanups=0',
    'function Test-Path {param($LiteralPath,$PathType);return $false}',
    'function Invoke-WebRequest {param([switch]$UseBasicParsing,$Uri,$OutFile,$TimeoutSec,$ErrorAction,$Headers);if($script:failDownload){throw \'Fixture download failed\'};if(-not $UseBasicParsing -or $ErrorAction -ne \'Stop\' -or -not $OutFile -or $Uri -ne \'https://example.invalid/fixture\'){throw \'Unsafe fallback arguments\'};$script:downloads+=@{timeout=[int]$TimeoutSec}}',
    'function Start-Process {param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru);if($FilePath -ne \'msiexec.exe\' -or -not $Wait -or -not $PassThru -or $ArgumentList -notcontains \'/norestart\'){throw \'Unexpected native invocation\'};$script:installs++;return @{ExitCode=0}}',
    'function Remove-Item {param($LiteralPath,[switch]$Force,$ErrorAction);if($LiteralPath -notmatch \'webminai-netdata-[a-f0-9]{32}[.]msi$\'){throw \'Unexpected cleanup\'};$script:cleanups++}',
    "$NetdataDownload='https://example.invalid/fixture'",
    install,
    'Install-Netdata',
    "$curl='missing-fixture-curl.exe';$checksumAsset=@{browser_download_url='https://example.invalid/fixture'};$asset=$checksumAsset;$checksumFile='fixture.sha256';$installer='fixture.exe';$headers=@{}",
    ...downloads,
    "if(($script:downloads.timeout -join ',') -ne '600,30' -or $script:installs -ne 1 -or $script:cleanups -ne 1){throw 'Unexpected fallback lifecycle'}",
    "$script:failDownload=$true;$refused=$false;try{Install-Netdata}catch{if($_.Exception.Message -ne 'Fixture download failed'){throw};$refused=$true};if(-not $refused -or $script:installs -ne 1 -or $script:cleanups -ne 2){throw 'Download failure did not block installation'}",
    "Write-Output 'WINDOWS_DOWNLOAD_FALLBACK_OK'"
  ].join('\n')
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const result = await lease.ssh.execute(host.connectionUrl, powershellCommand('$fixture=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($fixture))'), { input: fixture })
    assert.equal(result.code, 0)
    assert.equal(result.stdout.trim(), 'WINDOWS_DOWNLOAD_FALLBACK_OK')
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
