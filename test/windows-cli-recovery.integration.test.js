import assert from 'node:assert/strict'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { recoveryBaselineCommand } from '../src/remote-recovery-baseline.js'

test('opt-in Windows CLI baseline rejects changed content, hardlinks, junctions, writable paths and invalid registry evidence', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 120000
}, async () => {
  const command = recoveryBaselineCommand('intent-ai-ops-windows', 84)
    .replace('$state="C:\\ProgramData\\WebminAI\\Tasks\\$TaskId-intent-ai-ops-install"', '$state=Join-Path $fixture \'state\'')
    .replace("$root='C:\\ProgramData\\IntentAIOps\\Cli'", "$root=Join-Path $fixture 'root'")
  assert.ok(command.includes('$state=Join-Path $fixture'))
  const fixture = [
    "$ErrorActionPreference='Stop'",
    "$fixture=Join-Path 'C:\\ProgramData\\WebminAI\\Tasks' ('recovery-fixture-'+[guid]::NewGuid().ToString('N'))",
    'New-Item -ItemType Directory -Path $fixture|Out-Null',
    'try {',
    "$state=Join-Path $fixture 'state';$root=Join-Path $fixture 'root'",
    "New-Item -ItemType Directory -Path $state,(Join-Path $root 'bin'),(Join-Path $root 'npm\\node_modules\\intent-ai-ops\\bin') -Force|Out-Null",
    "foreach($name in @('baseline','owns-root','installed')){[IO.File]::WriteAllText((Join-Path $state $name),'')}",
    "$paths=Join-Path $state 'paths-before.json';[IO.File]::WriteAllText($paths,'{\"version\":2,\"Machine\":{\"raw\":\"fixture\",\"kind\":\"String\",\"value\":\"fixture\"},\"User\":{\"raw\":null,\"kind\":null,\"value\":null}}')",
    "foreach($name in @('bin\\intentaiops.cmd','node-path.txt','npm\\node_modules\\intent-ai-ops\\bin\\intentaiops.js')){[IO.File]::WriteAllText((Join-Path $root $name),'DO NOT EXECUTE')}",
    `$probe=[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString('base64')}')))`,
    "$first=& $probe;if($first-notmatch'^[a-f0-9]{64}$'-or(& $probe)-cne$first){throw 'Baseline digest is not stable'}",
    "$extra=Join-Path $root 'unrelated.txt';[IO.File]::WriteAllText($extra,'preserve');if((& $probe)-ceq$first){throw 'Added unrelated file was not detected'};Remove-Item -LiteralPath $extra",
    "$node=Join-Path $root 'node-path.txt';$link=Join-Path $fixture 'hardlink';New-Item -ItemType HardLink -Path $link -Target $node|Out-Null;$blocked=$false;try{& $probe|Out-Null}catch{$blocked=$true};if(-not$blocked){throw 'Hard link was accepted'};Remove-Item -LiteralPath $link",
    "$junction=Join-Path $root 'junction';New-Item -ItemType Junction -Path $junction -Target $state|Out-Null;$blocked=$false;try{& $probe|Out-Null}catch{$blocked=$true};if(-not$blocked){throw 'Junction was accepted'};[IO.Directory]::Delete($junction)",
    "$acl=Get-Acl -LiteralPath $node;$changed=Get-Acl -LiteralPath $node;$changed.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $node -AclObject $changed;$blocked=$false;try{& $probe|Out-Null}catch{$blocked=$true};Set-Acl -LiteralPath $node -AclObject $acl;if(-not$blocked){throw 'Writable file was accepted'}",
    "$marker=Join-Path $state 'installed';Remove-Item -LiteralPath $marker;$blocked=$false;try{& $probe|Out-Null}catch{$blocked=$true};[IO.File]::WriteAllText($marker,'');if(-not$blocked){throw 'Missing ownership marker was accepted'}",
    "$unexpected=Join-Path $state 'unrelated.txt';[IO.File]::WriteAllText($unexpected,'preserve');$blocked=$false;try{& $probe|Out-Null}catch{$blocked=$true};Remove-Item -LiteralPath $unexpected;if(-not$blocked){throw 'Unknown task state was accepted'}",
    "[IO.File]::WriteAllText($paths,'{\"version\":1}');$blocked=$false;try{& $probe|Out-Null}catch{$blocked=$true};if(-not$blocked){throw 'Invalid registry baseline was accepted'}",
    "Write-Output 'WINDOWS_CLI_RECOVERY_BASELINE_OK'",
    '} finally {Remove-Item -LiteralPath $fixture -Recurse -Force}'
  ].join('\n')
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    const result = await client.runCommand(fixture, { timeoutSeconds: 60 })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'WINDOWS_CLI_RECOVERY_BASELINE_OK')
  } finally { await lease.close(); await ssh.closeSessions() }
})
