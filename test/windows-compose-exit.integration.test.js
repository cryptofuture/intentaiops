import assert from 'node:assert/strict'
import test from 'node:test'
import { windowsDockerPowerShellAdapter } from '../src/windows-compose-foundation.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { NetdataClient } from '../src/netdata-client.js'
import { buildCommonTask } from '../src/common-tasks.js'

test('opt-in Windows Docker adapter preserves native failure instead of guessing from stderr', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST,
  timeout: 60000
}, async () => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const host = await store.decryptServer({ settings: await store.load(), passphrase: process.env.VAULT_TEST, serverId: 'windows-lab' })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const client = new NetdataClient({ ssh: lease.ssh, connectionUrl: host.connectionUrl, actionKey: host.actionKey })
    const adapter = windowsDockerPowerShellAdapter(10000)
    const success = await client.runCommand(`${adapter};& $docker --version;Write-Output ('ADAPTER_EXIT='+$global:LASTEXITCODE)`, { timeoutSeconds: 20 })
    assert.equal(success.exitCode, 0, success.stderr)
    assert.match(success.stdout, /ADAPTER_EXIT=0/u)
    const formatted = await client.runCommand(`${adapter};& $docker version --format '{{printf "%s" .Client.Version}}'`, { timeoutSeconds: 20 })
    assert.equal(formatted.exitCode, 0, formatted.stderr)
    assert.match(formatted.stdout.trim(), /^[0-9]+\.[0-9]+\.[0-9]+/u)
    const failure = await client.runCommand(`${adapter};& $docker version --intent-invalid-flag;Write-Output ('ADAPTER_EXIT='+$global:LASTEXITCODE)`, { timeoutSeconds: 20 })
    assert.equal(failure.exitCode, 125)
    assert.match(failure.stdout, /ADAPTER_EXIT=125/u)
    assert.match(failure.stderr, /unknown flag/u)
    const built = buildCommonTask('magento-windows', 901, { platform: 'windows', windowsExecution: { platform: 'windows', docker: { serverOs: 'linux' } }, docker: { ready: true } })
    const verifier = built.plan.commands.find(command => command.id === 'verify-restart').command
    for (const scenario of ['delayed', 'unhealthy', 'bad-pong']) {
      const fake = `$script:checks=0;$script:search=0;function Start-Sleep {};function Invoke-WebRequest {return [pscustomobject]@{Content='WEBMINAI_MAGENTO_OK'}};$docker={$global:LASTEXITCODE=0;if($args[0]-eq'inspect'){$script:checks++;if('${scenario}'-eq'unhealthy'-or$script:checks-lt 3){Write-Output 'starting'}else{Write-Output 'healthy'};return};if($args-contains'curl'){$script:search++};if($args-contains'ping'){Write-Output $(if('${scenario}'-eq'bad-pong'){'NOT-PONG'}else{'PONG'})}}`
      const script = verifier.replace(windowsDockerPowerShellAdapter(900000), fake).replace(/Set-Location -LiteralPath '[^']+'/u, '$null=$null')
      assert.ok(!script.includes('Start-Process'), 'Disposable readiness fixture must not invoke real Docker')
      const expected = scenario === 'unhealthy' ? 'Magento dependency health did not recover.' : 'Valkey health failed.'
      const source = scenario === 'delayed'
        ? `${script};if($script:checks-lt 5-or$script:search-ne 1){throw 'Readiness was not awaited'};Write-Output 'READINESS_DELAY_OK'`
        : `try{${script};throw 'Unexpected readiness success'}catch{if($_.Exception.Message-ne'${expected}'){throw};${scenario === 'unhealthy' ? "if($script:checks-ne 120-or$script:search-ne 0){throw 'Readiness deadline was not bounded'};" : ''}Write-Output 'READINESS_REJECTED'}`
      const result = await client.runCommand(source, { timeoutSeconds: 20 })
      assert.equal(result.exitCode, 0, result.stderr)
      assert.match(result.stdout, scenario === 'delayed' ? /READINESS_DELAY_OK/u : /READINESS_REJECTED/u)
    }
    const n8n = buildCommonTask('n8n-windows', 902, { platform: 'windows', windowsExecution: { platform: 'windows', docker: { serverOs: 'linux' } }, docker: { ready: true } }).plan.commands.find(command => command.id === 'verify-restart').command
    for (const scenario of ['delayed', 'unavailable']) {
      const fake = `$script:probes=0;$script:restarts=0;function Start-Sleep {};function Invoke-WebRequest {param($Uri,[switch]$UseBasicParsing,$TimeoutSec);if($Uri.EndsWith('/webminai-health')){return [pscustomobject]@{Content='WEBMINAI_N8N_OK'}};if($Uri.EndsWith('/healthz')){$script:probes++;if('${scenario}'-eq'unavailable'-or$script:probes-lt 3){throw 'Proxy is not ready'}};return [pscustomobject]@{StatusCode=200;Content='<!DOCTYPE html><html>n8n</html>'}};$docker={$global:LASTEXITCODE=0;if($args[0]-eq'inspect'){Write-Output 'healthy'};if($args-contains'restart'){$script:restarts++}}`
      const script = n8n.replace(windowsDockerPowerShellAdapter(), fake).replace(/Set-Location -LiteralPath '[^']+'/u, '$null=$null')
      assert.ok(!script.includes('Start-Process'))
      const source = scenario === 'delayed'
        ? `${script};if($script:probes-ne 3-or$script:restarts-ne 1){throw 'Unexpected HTTP retry or restart count'};Write-Output 'N8N_DELAY_OK'`
        : `try{${script};throw 'Unexpected proxy readiness success'}catch{if($_.Exception.Message-ne'n8n application UI and proxied health did not become ready.'){throw};if($script:probes-ne 60-or$script:restarts-ne 1){throw 'HTTP deadline was not bounded'};Write-Output 'N8N_REJECTED'}`
      const result = await client.runCommand(source, { timeoutSeconds: 20 })
      assert.equal(result.exitCode, 0, result.stderr)
      assert.match(result.stdout, scenario === 'delayed' ? /N8N_DELAY_OK/u : /N8N_REJECTED/u)
    }
  } finally {
    await lease.close()
    await ssh.closeSessions()
  }
})
