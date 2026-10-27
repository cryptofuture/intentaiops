import assert from 'node:assert/strict'
import test from 'node:test'
import { windowsDockerPathCleanup } from '../src/windows-docker-bootstrap-task.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'

test('opt-in Windows Docker PATH cleanup preserves other entries and registry kind, rejects duplicates and races', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const source = windowsDockerPathCleanup().replace("[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',$true)", '$script:key')
  assert.ok(!source.includes('OpenSubKey'), 'Fixture must not access the real registry')
  const fixture = [
    "$ErrorActionPreference='Stop'",
    '$script:key=[pscustomobject]@{Value=\'\';Kind=[Microsoft.Win32.RegistryValueKind]::ExpandString;Writes=0;Reads=0;KindReads=0;Race=$false;KindRace=$false}',
    "$script:key|Add-Member ScriptMethod GetValue {param($name,$default,$options);$this.Reads++;if($this.Race-and$this.Reads-eq 2){$this.Value='UNRELATED-EDIT'};return $this.Value}",
    '$script:key|Add-Member ScriptMethod GetValueKind {param($name);$this.KindReads++;if($this.KindRace-and$this.KindReads-eq 2){$this.Kind=[Microsoft.Win32.RegistryValueKind]::String};return $this.Kind}',
    '$script:key|Add-Member ScriptMethod SetValue {param($name,$value,$kind);$this.Writes++;$this.Value=$value;$this.Kind=$kind}',
    '$script:key|Add-Member ScriptMethod Close {}',
    `$cleanup=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}')))`,
    "$script:key.Value='FIRST;%ProgramFiles%\\Docker\\Docker\\resources\\bin;KEEP;';& $cleanup;if($script:key.Value-ne'FIRST;KEEP;'-or$script:key.Writes-ne 1-or$script:key.Kind-ne[Microsoft.Win32.RegistryValueKind]::ExpandString){throw 'Owned entry cleanup changed unrelated data or kind'}",
    "$script:key.Value='FIRST;KEEP;';$script:key.Writes=0;& $cleanup;if($script:key.Value-ne'FIRST;KEEP;'-or$script:key.Writes-ne 0){throw 'Absent Docker PATH was rewritten'}",
    "$script:key.Value='FIRST;%ProgramFiles%\\Docker\\Docker\\resources\\bin;%ProgramFiles%\\Docker\\Docker\\resources\\bin;KEEP;';$blocked=$false;try{& $cleanup}catch{$blocked=$_.Exception.Message-eq'Duplicate Docker PATH entries require operator review.'};if(-not $blocked-or$script:key.Writes-ne 0){throw 'Ambiguous duplicate entries were removed'}",
    "$script:key.Value='FIRST;%ProgramFiles%\\Docker\\Docker\\resources\\bin;KEEP;';$script:key.Reads=0;$script:key.Race=$true;$blocked=$false;try{& $cleanup}catch{$blocked=$_.Exception.Message-eq'Machine PATH changed; review before cleanup.'};if(-not $blocked-or$script:key.Writes-ne 0-or$script:key.Value-ne'UNRELATED-EDIT'){throw 'Concurrent PATH edit was overwritten'}",
    "$script:key.Value='FIRST;%ProgramFiles%\\Docker\\Docker\\resources\\bin;KEEP;';$script:key.Race=$false;$script:key.KindReads=0;$script:key.KindRace=$true;$blocked=$false;try{& $cleanup}catch{$blocked=$_.Exception.Message-eq'Machine PATH changed; review before cleanup.'};if(-not $blocked-or$script:key.Writes-ne 0-or$script:key.Kind-ne[Microsoft.Win32.RegistryValueKind]::String){throw 'Concurrent registry kind edit was overwritten'}",
    "Write-Output 'WINDOWS_DOCKER_PATH_OK'"
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
    assert.equal(result.stdout.trim(), 'WINDOWS_DOCKER_PATH_OK')
  } finally { await lease.close(); await ssh.closeSessions() }
})
