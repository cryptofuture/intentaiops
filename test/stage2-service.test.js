import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Stage2Service } from '../src/stage2-service.js'

test('stage 2 rejects invalid readiness polling configuration', () => {
  for (const readinessAttempts of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => new Stage2Service({ ssh: {}, readinessAttempts }),
      new TypeError('readinessAttempts must be a positive integer')
    )
  }
  for (const readinessIntervalMs of [-1, 0.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => new Stage2Service({ ssh: {}, readinessIntervalMs }),
      new TypeError('readinessIntervalMs must be a non-negative integer')
    )
  }
})

test('stage 2 accepts zero-delay polling with a positive attempt count', async () => {
  let attempts = 0
  const service = new Stage2Service({
    ssh: {},
    readinessAttempts: 2,
    readinessIntervalMs: 0
  })
  service.probe = async () => ({
    status: ++attempts === 2 ? 'active' : 'inactive',
    error: 'not ready'
  })

  const result = await service.waitForReadiness({ connectionUrl: 'ssh://host.example' })

  assert.equal(result.status, 'active')
  assert.equal(attempts, 2)
})

for (const expectedPlatform of ['linux', 'windows']) {
  test(`${expectedPlatform} activation finalization commits a verified plugin update`, async () => {
    const lifecycle = []
    const service = new Stage2Service({ ssh: {} })
    service.waitForReadiness = async options => {
      assert.equal(options.expectedPlatform, expectedPlatform)
      return {
        status: 'active',
        health: { version: '0.7.2' },
        executionIdentity: expectedPlatform === 'windows' ? 'system' : 'root'
      }
    }
    service.runInstalledLifecycleCommand = async options => lifecycle.push(options)

    const result = await service.verifyAndFinalizeActivation({
      connectionUrl: `ssh://${expectedPlatform}.example`,
      actionKey: '40'.repeat(32),
      activation: { status: 'active', pluginAction: 'updated', netdataAction: 'existing' },
      expectedPlatform,
      elevation: expectedPlatform === 'windows' ? 'windows-admin' : 'sudo-n'
    })

    assert.equal(result.observed.status, 'active')
    assert.equal(lifecycle.length, 1)
    assert.equal(lifecycle[0].command, 'commit')
  })

  test(`${expectedPlatform} activation finalization preserves diagnostics and rolls back`, async () => {
    const lifecycle = []
    const service = new Stage2Service({ ssh: {}, debug: true })
    const cause = new Error('probe failed')
    service.waitForReadiness = async () => ({ status: 'inactive', error: 'not ready', cause })
    service.diagnostics = async options => {
      assert.equal(options.platform, expectedPlatform)
      return `${expectedPlatform} diagnostics`
    }
    service.runInstalledLifecycleCommand = async options => lifecycle.push(options)

    await assert.rejects(service.verifyAndFinalizeActivation({
      connectionUrl: `ssh://${expectedPlatform}.example`,
      actionKey: '41'.repeat(32),
      activation: { status: 'active', pluginAction: 'updated', netdataAction: 'existing' },
      expectedPlatform,
      elevation: expectedPlatform === 'windows' ? 'windows-admin' : 'sudo-n'
    }), error => {
      assert.equal(error.cause, cause)
      assert.equal(error.diagnostics, `${expectedPlatform} diagnostics`)
      return true
    })
    assert.equal(lifecycle.length, 1)
    assert.equal(lifecycle[0].command, 'rollback-activation')
  })

  test(`${expectedPlatform} activation finalization aggregates verification and rollback failures`, async () => {
    const service = new Stage2Service({ ssh: {} })
    service.waitForReadiness = async () => ({ status: 'inactive', error: 'not ready' })
    service.runInstalledLifecycleCommand = async () => { throw new Error('rollback failed') }

    await assert.rejects(service.verifyAndFinalizeActivation({
      connectionUrl: `ssh://${expectedPlatform}.example`,
      actionKey: '42'.repeat(32),
      activation: { status: 'active', pluginAction: 'updated', netdataAction: 'existing' },
      expectedPlatform,
      elevation: expectedPlatform === 'windows' ? 'windows-admin' : 'sudo-n'
    }), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.message, 'stage 2 activation and rollback both failed')
      assert.match(error.errors[0].message, /health verification failed/u)
      assert.match(error.errors[1].message, /rollback failed/u)
      return true
    })
  })

  test(`${expectedPlatform} activation finalization deactivates a newly installed plugin after version mismatch`, async () => {
    const deactivations = []
    const service = new Stage2Service({ ssh: {} })
    service.waitForReadiness = async () => ({ status: 'active', health: { version: '0.6.0' } })
    service.deactivate = async options => deactivations.push(options)

    await assert.rejects(service.verifyAndFinalizeActivation({
      connectionUrl: `ssh://${expectedPlatform}.example`,
      actionKey: '43'.repeat(32),
      activation: { status: 'active', pluginAction: 'installed', netdataAction: 'installed' },
      expectedPlatform,
      elevation: expectedPlatform === 'windows' ? 'windows-admin' : 'sudo-n'
    }), /plugin version verification failed/u)

    assert.equal(deactivations.length, 1)
    assert.equal(deactivations[0].removeManagedNetdata, true)
    assert.equal(deactivations[0].elevation, expectedPlatform === 'windows' ? 'windows-admin' : 'sudo-n')
  })
}

test('stage 2 activation copies over SCP, installs over SSH, verifies, and cleans up', async () => {
  const calls = []
  const ssh = {
    async copy (connectionUrl, local, remote) {
      calls.push({ type: 'copy', connectionUrl, local, remote })
      return { code: 0 }
    },
    async execute (connectionUrl, command, options = {}) {
      calls.push({ type: 'execute', connectionUrl, command, options })
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Ab12Cd34\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","netdataAction":"installed","pluginAction":"installed","pluginVersion":"0.7.2","previousPluginVersion":"none"}\n' }
      }
      if (command.includes('/api/v3/info')) return { stdout: '{"os":"linux"}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{"functions":["webminai:command"]}' }
      if (command.includes('webminai%3Ahealth')) return rootHealthResponse()
      if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
      if (command.includes("' commit")) return { stdout: 'WEBMINAI_RESULT {"status":"committed"}\n' }
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })
  const actionKey = '44'.repeat(32)
  const result = await service.activate({ connectionUrl: 'ssh://host.example', actionKey })

  assert.equal(result.status, 'active')
  assert.equal(result.ownership, 'managed')
  assert.equal(result.observed.status, 'active')
  assert.equal(result.observed.executionIdentity, 'root')
  assert.equal(calls.filter(call => call.type === 'copy').length, 2)
  const installer = calls.find(call => call.command?.includes(' activate '))
  assert.equal(installer.command.includes(actionKey), false)
  assert.equal(installer.command.includes('webminai-root'), false)
  assert.match(installer.command, /install-if-needed/)
  assert.match(installer.command, /'0\.7\.2'$/)
  assert.equal(installer.options.input, `${actionKey}\n`)
  assert.ok(calls.some(call => call.command?.startsWith("rm -rf -- '/tmp/webminai.Ab12Cd34'")))
})

test('FreeBSD activation selects the native architecture artifact and verifies the plugin platform', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-freebsd-artifact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pluginPath = path.join(directory, 'webminai.plugin-freebsd-amd64')
  await writeFile(pluginPath, 'freebsd artifact')
  const calls = []
  const ssh = {
    async copy (connectionUrl, local, remote) {
      calls.push({ type: 'copy', local, remote })
    },
    async execute (connectionUrl, command, options = {}) {
      calls.push({ type: 'execute', command, options })
      if (command.includes('$(uname -s)')) return { stdout: 'system=FreeBSD\nmachine=amd64\n' }
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.FreeBSD1\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","platform":"freebsd","netdataAction":"installed","pluginAction":"installed","pluginVersion":"0.7.2","previousPluginVersion":"none"}\n' }
      }
      if (command.includes('/api/v3/info')) return { stdout: '{"os":"freebsd"}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{}' }
      if (command.includes('webminai%3Ahealth')) return rootHealthResponse('freebsd')
      if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPaths: { 'freebsd-amd64': pluginPath }
  })

  const result = await service.activate({
    connectionUrl: 'ssh://freebsd.example',
    actionKey: '43'.repeat(32),
    installNetdata: true
  })

  assert.equal(result.platform, 'freebsd')
  assert.equal(result.observed.health.platform, 'freebsd')
  assert.equal(calls.find(call => call.type === 'copy' && call.remote.endsWith('/webminai.plugin')).local, pluginPath)
  assert.equal(calls.find(call => call.command?.includes(' activate ')).options.timeoutMs, 30 * 60 * 1000)
})

test('FreeBSD activation fails before mutation when its native artifact is missing', async () => {
  const ssh = {
    async execute (connectionUrl, command) {
      assert.match(command, /uname -s/)
      return { stdout: 'system=FreeBSD\nmachine=amd64\n' }
    }
  }
  const service = new Stage2Service({
    ssh,
    pluginPaths: { 'freebsd-amd64': '/artifacts/missing-freebsd-plugin' }
  })
  await assert.rejects(service.activate({
    connectionUrl: 'ssh://freebsd.example',
    actionKey: '42'.repeat(32)
  }), /npm run build:plugin:freebsd/)
})

test('macOS activation uses sudo-compatible Unix Stage 2 flow and verifies root plugin', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-macos-artifact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pluginPath = path.join(directory, 'webminai.plugin-macos-arm64')
  await writeFile(pluginPath, 'macos artifact')
  const calls = []
  const ssh = {
    async copy (connectionUrl, local, remote) { calls.push({ type: 'copy', local, remote }) },
    async execute (connectionUrl, command, options = {}) {
      calls.push({ type: 'execute', command, options })
      if (command.includes('$(uname -s)')) return { stdout: 'system=Darwin\nmachine=arm64\n' }
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.MacArm12\n' }
      if (command.includes(' activate ')) return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","platform":"macos","netdataAction":"installed","pluginAction":"installed","pluginVersion":"0.7.2","previousPluginVersion":"none"}\n' }
      if (command.includes('/api/v3/info')) return { stdout: '{"os":"macos"}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{}' }
      if (command.includes('webminai%3Ahealth')) return rootHealthResponse('macos')
      if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPaths: { 'macos-arm64': pluginPath }
  })
  const result = await service.activate({
    connectionUrl: 'ssh://mac.example',
    actionKey: '45'.repeat(32),
    elevation: 'sudo-password',
    sudoPassword: 'test-password'
  })
  assert.equal(result.platform, 'macos')
  assert.equal(result.observed.executionIdentity, 'root')
  assert.match(calls.find(call => call.command?.includes(' activate ')).command, /sudo -k -S/)
})

test('Windows activation installs over system SSH and verifies LocalSystem execution', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-windows-artifact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pluginPath = path.join(directory, 'webminai.plugin-windows-amd64.exe')
  await writeFile(pluginPath, 'windows artifact')
  const calls = []
  const ssh = {
    async copy (connectionUrl, local, remote) {
      calls.push({ type: 'copy', local, remote })
    },
    async execute (connectionUrl, command, options = {}) {
      calls.push({ type: 'execute', command, options })
      if (command.includes('uname -s')) throw new Error('uname is not available')
      const script = decodePowerShellCommand(command)
      if (script?.includes("Write-Output 'system=Windows_NT'")) {
        return { stdout: 'system=Windows_NT\r\nmachine=AMD64\r\n' }
      }
      if (script?.includes('Temp\\webminai.')) {
        return { stdout: 'C:/Windows/Temp/webminai.Ab12Cd34\r\n' }
      }
      if (script?.includes('Remove-Item -LiteralPath')) return { stdout: '' }
      if (command.includes(' Activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","platform":"windows","netdataAction":"installed","pluginAction":"installed","pluginVersion":"0.7.2","identity":"system","isLocalSystem":true}\r\n' }
      }
      if (command.includes('/api/v3/info')) return { stdout: '{"os":"windows"}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{"functions":["webminai:command"]}' }
      if (command.includes('webminai%3Ahealth')) return windowsHealthResponse()
      if (command.includes('webminai%3Acommand')) return windowsExecutionResponse()
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    windowsInstallerPath: '/artifacts/webminai-stage2-windows.ps1',
    pluginPaths: { 'windows-amd64': pluginPath }
  })

  const result = await service.activate({
    connectionUrl: 'ssh://windows.example',
    actionKey: '41'.repeat(32),
    elevation: 'windows-admin'
  })

  assert.equal(result.platform, 'windows')
  assert.equal(result.observed.executionIdentity, 'system')
  assert.equal(result.observed.health.isLocalSystem, true)
  assert.equal(result.observed.rootExecution.hostExecution, true)
  assert.deepEqual(calls.filter(call => call.type === 'copy').map(call => path.basename(call.local)), [
    'webminai-stage2-windows.ps1',
    'webminai.plugin-windows-amd64.exe',
    'webminai-command-runner-windows.ps1'
  ])
  const activation = calls.find(call => call.command?.includes(' Activate '))
  assert.match(activation.command, /C:\/Windows\/Temp\/webminai\.Ab12Cd34\/webminai-stage2-windows\.ps1 Activate/)
  assert.match(activation.command, /C:\/Windows\/Temp\/webminai\.Ab12Cd34\/webminai-command-runner\.ps1/)
  assert.equal(activation.command.includes('41'.repeat(32)), false)
  assert.equal(activation.options.input, `${'41'.repeat(32)}\n`)
  assert.ok(calls.some(call => decodePowerShellCommand(call.command)?.includes('Remove-Item -LiteralPath')))
})

test('Windows capabilities tolerate CRLF and report administrator state', async () => {
  const ssh = {
    async execute (connectionUrl, command) {
      if (command.includes("printf 'system=%s")) throw new Error('not a POSIX host')
      return {
        stdout: 'system=Windows_NT\r\nmachine=AMD64\r\nuid=system\r\nadministrator=yes\r\ncurl=yes\r\nnetdata=yes\r\nrunner=yes\r\n'
      }
    }
  }
  const service = new Stage2Service({ ssh })

  assert.deepEqual(await service.capabilities({ connectionUrl: 'ssh://windows.example' }), {
    platform: {
      os: 'windows',
      architecture: 'amd64',
      system: 'Windows_NT',
      machine: 'AMD64',
      supported: true
    },
    uid: NaN,
    isRoot: false,
    isAdministrator: true,
    hasSudo: false,
    hasPasswordlessSudo: false,
    hasDoas: false,
    hasPasswordlessDoas: false,
    hasCurl: true,
    hasNetdata: true,
    hasStage2Runner: true,
    docker: {
      platform: 'windows',
      installSupported: false,
      installMethod: null,
      cliAvailable: false,
      daemonReachable: false,
      composeAvailable: false,
      composeCommand: null,
      hostIsContainer: false,
      containerRuntime: null
    }
  })
})

test('Windows platform hint skips the failed POSIX capability round trip', async () => {
  const commands = []
  const ssh = {
    async execute (connectionUrl, command) {
      commands.push(command)
      if (command.includes("printf 'system=%s")) throw new Error('POSIX probe should not run')
      return {
        stdout: 'system=Windows_NT\r\nmachine=AMD64\r\nuid=system\r\nadministrator=yes\r\ncurl=yes\r\nnetdata=yes\r\nrunner=yes\r\n'
      }
    }
  }
  const service = new Stage2Service({ ssh })

  const capabilities = await service.capabilities({
    connectionUrl: 'ssh://windows.example',
    platformHint: 'windows'
  })

  assert.equal(capabilities.platform.os, 'windows')
  assert.equal(commands.length, 1)
  assert.match(commands[0], /powershell\.exe/)
})

test('Linux platform hint uses the POSIX capability probe first', async () => {
  const commands = []
  const service = new Stage2Service({
    ssh: {
      async execute (connectionUrl, command) {
        commands.push(command)
        if (command.includes('powershell.exe')) throw new Error('Windows probe should not run')
        return {
          stdout: 'system=Linux\nmachine=x86_64\nuid=0\nsudo=no\nsudoNonInteractive=no\ndoas=no\ndoasNonInteractive=no\ncurl=yes\nnetdata=yes\nrunner=yes\n'
        }
      }
    }
  })

  const capabilities = await service.capabilities({
    connectionUrl: 'ssh://linux.example',
    platformHint: 'linux'
  })

  assert.equal(capabilities.platform.os, 'linux')
  assert.equal(commands.length, 1)
  assert.match(commands[0], /printf 'system=%s/u)
})

test('capability detection distinguishes nested Docker availability from the container host safeguard', async () => {
  const service = new Stage2Service({
    ssh: {
      async execute () {
        return {
          stdout: 'system=Linux\nmachine=x86_64\nuid=0\nsudo=no\nsudoNonInteractive=no\ndoas=no\ndoasNonInteractive=no\ncurl=yes\nnetdata=yes\nrunner=yes\ncontainerRuntime=lxc\ndockerCli=yes\ndockerDaemon=yes\ndockerCompose=yes\ndockerComposeCommand=docker compose\n'
        }
      }
    }
  })
  const capabilities = await service.capabilities({ connectionUrl: 'ssh://lxd.example' })
  assert.deepEqual(capabilities.docker, {
    platform: 'linux',
    installSupported: false,
    installMethod: null,
    cliAvailable: true,
    daemonReachable: true,
    composeAvailable: true,
    composeCommand: 'docker compose',
    hostIsContainer: true,
    containerRuntime: 'lxc'
  })
})

test('status probe derives Windows LocalSystem execution from plugin health', async () => {
  const ssh = {
    async execute (connectionUrl, command) {
      if (command.includes('/api/v3/info')) return { stdout: '{"os":"windows"}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{"functions":["webminai:command"]}' }
      if (command.includes('webminai%3Ahealth')) return windowsHealthResponse()
      if (command.includes('webminai%3Acommand')) return windowsExecutionResponse()
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({ ssh })

  const observed = await service.probe({
    connectionUrl: 'ssh://windows.example',
    actionKey: '40'.repeat(32)
  })

  assert.equal(observed.status, 'active')
  assert.equal(observed.executionIdentity, 'system')
  assert.equal(observed.rootExecution.identity, 'system')
})

test('Windows deactivation uses the persistent PowerShell runner', async () => {
  const ssh = {
    async execute (connectionUrl, command) {
      assert.match(command, /C:\/ProgramData\/WebminAI\/stage2\.ps1 Deactivate _ remove-managed$/)
      return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"removed","platform":"windows"}\r\n' }
    }
  }
  const service = new Stage2Service({ ssh })

  assert.deepEqual(await service.deactivate({
    connectionUrl: 'ssh://windows.example',
    removeManagedNetdata: true,
    elevation: 'windows-admin'
  }), { ownership: 'managed', status: 'removed', platform: 'windows' })
})

test('plugin-only activation requires existing Netdata without extra artifacts', async () => {
  const calls = []
  const ssh = {
    async copy (connectionUrl, local, remote) {
      calls.push({ type: 'copy', local, remote })
    },
    async execute (connectionUrl, command) {
      calls.push({ type: 'execute', command })
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Plugin12\n' }
      if (command.includes(' activate ')) {
        assert.match(command, /require-existing/)
        return { stdout: 'WEBMINAI_RESULT {"ownership":"preexisting","status":"active","netdataAction":"existing","pluginAction":"updated","pluginVersion":"0.7.2","previousPluginVersion":"0.1.0"}\n' }
      }
      if (command.includes('/api/v3/info')) return { stdout: '{}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{}' }
      if (command.includes('webminai%3Ahealth')) return rootHealthResponse()
      if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
      if (command.includes("' commit")) return { stdout: 'WEBMINAI_RESULT {"status":"committed"}\n' }
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })
  const result = await service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '45'.repeat(32),
    installNetdata: false
  })
  assert.equal(result.status, 'active')
  assert.equal(result.pluginAction, 'updated')
  assert.equal(result.pluginVersion, '0.7.2')
  assert.equal(result.previousPluginVersion, '0.1.0')
  assert.equal(result.netdataAction, 'existing')
  assert.equal(calls.filter(call => call.type === 'copy').length, 2)
})

test('stage 2 deactivation can request removal only for managed Netdata', async () => {
  const ssh = {
    async execute (connectionUrl, command) {
      assert.match(command, /deactivate remove-managed$/)
      return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"removed"}\n' }
    }
  }
  const service = new Stage2Service({ ssh })
  assert.deepEqual(await service.deactivate({
    connectionUrl: 'ssh://host.example',
    removeManagedNetdata: true
  }), { ownership: 'managed', status: 'removed' })
})

test('failed activation verification rolls back managed Netdata', async () => {
  const commands = []
  const ssh = {
    async copy () {},
    async execute (connectionUrl, command) {
      commands.push(command)
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Rollback1\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","netdataAction":"installed"}\n' }
      }
      if (command.includes('/api/v3/')) throw new Error('Netdata is unavailable')
      if (command.includes('deactivate remove-managed')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"removed"}\n' }
      }
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })
  await assert.rejects(service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '55'.repeat(32)
  }), /health verification/)
  assert.ok(commands.some(command => command.includes('deactivate remove-managed')))
})

test('failed plugin-only update restores the previous plugin and preserves managed Netdata', async () => {
  const commands = []
  const ssh = {
    async copy () {},
    async execute (connectionUrl, command) {
      commands.push(command)
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.PluginFail1\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","netdataAction":"existing","pluginAction":"updated","pluginVersion":"0.7.2"}\n' }
      }
      if (command.includes('/api/v3/')) throw new Error('updated plugin is unavailable')
      if (command.includes('rollback-activation')) {
        return { stdout: 'WEBMINAI_RESULT {"status":"restored"}\n' }
      }
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })
  await assert.rejects(service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '56'.repeat(32),
    installNetdata: false
  }), /health verification/)
  assert.ok(commands.some(command => command.includes('rollback-activation')))
  assert.ok(!commands.some(command => command.includes('deactivate keep-netdata')))
  assert.ok(!commands.some(command => command.includes('deactivate remove-managed')))
})

test('failed verification preserves an unchanged existing Stage 2 installation', async () => {
  const commands = []
  const events = []
  const ssh = {
    async copy () {},
    async execute (connectionUrl, command) {
      commands.push(command)
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Unchanged1\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"active","netdataAction":"existing","pluginAction":"unchanged","pluginVersion":"0.7.2"}\n' }
      }
      if (command.includes('/api/v3/')) throw new Error('transient health failure')
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 1,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin',
    debug: true,
    onDebug: event => events.push(event)
  })
  await assert.rejects(service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '57'.repeat(32),
    installNetdata: false
  }), /health verification/)
  assert.ok(events.some(event => event.phase === 'rollback-preserve'))
  assert.ok(!commands.some(command => command.includes('deactivate')))
  assert.ok(!commands.some(command => command.includes('rollback-activation')))
})

test('stage 2 capability detection and sudo password transport are explicit', async () => {
  const calls = []
  const ssh = {
    async copy () {},
    async execute (connectionUrl, command, options = {}) {
      calls.push({ command, options })
      if (command.includes("printf 'uid=%s")) {
        return {
          stdout: 'system=FreeBSD\nmachine=amd64\nuid=1000\nsudo=yes\nsudoNonInteractive=no\ndoas=no\ndoasNonInteractive=no\ncurl=yes\nnetdata=no\nrunner=no\n'
        }
      }
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.SudoPass\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"preexisting","status":"active","netdataAction":"existing"}\n' }
      }
      if (command.includes('/api/v3/info')) return { stdout: '{}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{}' }
      if (command.includes('webminai%3Ahealth')) return rootHealthResponse()
      if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })
  assert.deepEqual(await service.capabilities({ connectionUrl: 'ssh://host.example' }), {
    platform: {
      os: 'freebsd',
      architecture: 'amd64',
      system: 'FreeBSD',
      machine: 'amd64',
      supported: true
    },
    uid: 1000,
    isRoot: false,
    isAdministrator: false,
    hasSudo: true,
    hasPasswordlessSudo: false,
    hasDoas: false,
    hasPasswordlessDoas: false,
    hasCurl: true,
    hasNetdata: false,
    hasStage2Runner: false,
    docker: {
      platform: 'freebsd',
      installSupported: false,
      installMethod: null,
      cliAvailable: false,
      daemonReachable: false,
      composeAvailable: false,
      composeCommand: null,
      hostIsContainer: false,
      containerRuntime: null
    }
  })

  await service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '66'.repeat(32),
    elevation: 'sudo-password',
    sudoPassword: 'sudo secret'
  })
  const activation = calls.find(call => call.command.includes(' activate '))
  assert.match(activation.command, /^sudo -k -S -p ''/)
  assert.equal(activation.command.includes('sudo secret'), false)
  assert.equal(activation.options.input, `sudo secret\n${'66'.repeat(32)}\n`)
})

test('stage 2 lifecycle supports passwordless doas elevation', async () => {
  const ssh = {
    async execute (connectionUrl, command) {
      assert.match(command, /^doas -n/)
      assert.match(command, /deactivate keep-netdata$/)
      return { stdout: 'WEBMINAI_RESULT {"ownership":"preexisting","status":"inactive","platform":"freebsd"}\n' }
    }
  }
  const service = new Stage2Service({ ssh })
  const result = await service.deactivate({
    connectionUrl: 'ssh://freebsd.example',
    elevation: 'doas-n'
  })
  assert.equal(result.platform, 'freebsd')
})

test('debug activation collects diagnostics before health-failure rollback', async () => {
  const events = []
  const commands = []
  const ssh = {
    async copy () {},
    async execute (connectionUrl, command) {
      commands.push(command)
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Debug123\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'installer output\nWEBMINAI_RESULT {"ownership":"managed","status":"active","netdataAction":"installed"}\n' }
      }
      if (command.includes("printf '%s\\n' '=== system ==='")) {
        return { stdout: '=== netdata service ===\nfailed: plugin status 127\n', stderr: '' }
      }
      if (command.includes('/api/v3/')) {
        const error = new Error('curl failed')
        error.result = { code: 22, stdout: '', stderr: 'HTTP 404' }
        throw error
      }
      if (command.includes('deactivate remove-managed')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"managed","status":"removed"}\n' }
      }
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    debug: true,
    readinessAttempts: 1,
    onDebug: event => events.push(event),
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })

  await assert.rejects(service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '77'.repeat(32)
  }), error => {
    assert.match(error.message, /health verification failed/)
    assert.match(error.diagnostics, /plugin status 127/)
    return true
  })
  assert.ok(events.some(event => event.phase === 'diagnostics'))
  assert.ok(events.some(event => event.phase === 'rollback'))
  assert.ok(commands.some(command => command.includes('deactivate remove-managed')))
})

test('stage 2 activation waits for the Netdata plugin to become callable', async () => {
  const events = []
  let healthAttempts = 0
  const ssh = {
    async copy () {},
    async execute (connectionUrl, command) {
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Ready123\n' }
      if (command.includes(' activate ')) {
        return { stdout: 'WEBMINAI_RESULT {"ownership":"preexisting","status":"active","netdataAction":"existing"}\n' }
      }
      if (command.includes('/api/v3/info')) return { stdout: '{}' }
      if (command.includes('/api/v3/functions')) return { stdout: '{}' }
      if (command.includes('webminai%3Ahealth')) {
        healthAttempts++
        if (healthAttempts < 3) {
          const error = new Error('SSH command failed with exit code 22')
          error.result = { code: 22, stdout: '{"status":503}', stderr: 'curl: 503' }
          throw error
        }
        return rootHealthResponse()
      }
      if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    debug: true,
    onDebug: event => events.push(event),
    readinessAttempts: 3,
    readinessIntervalMs: 0,
    installerPath: '/artifacts/webminai-stage2.sh',
    pluginPath: '/artifacts/webminai.plugin'
  })

  const result = await service.activate({
    connectionUrl: 'ssh://host.example',
    actionKey: '88'.repeat(32)
  })

  assert.equal(result.observed.status, 'active')
  assert.equal(healthAttempts, 3)
  assert.equal(events.filter(event => event.phase === 'probe').length, 2)
  assert.equal(events.filter(event => event.phase === 'probe-wait').length, 0)
})

test('stage 2 rejects a plugin that is callable without root identity', async () => {
  const service = new Stage2Service({
    ssh: {
      async execute (connectionUrl, command, options = {}) {
        if (command.includes('/api/v3/info')) return { stdout: '{}' }
        if (command.includes('/api/v3/functions')) return { stdout: '{}' }
        if (command.includes('webminai%3Ahealth')) {
          return { stdout: '{"status":"ok","effectiveUid":1000}' }
        }
        if (command.includes('webminai%3Acommand')) return rootExecutionResponse()
        throw new Error(`unexpected command: ${command}`)
      }
    }
  })
  const observed = await service.probe({
    connectionUrl: 'ssh://host.example',
    actionKey: '99'.repeat(32)
  })
  assert.equal(observed.status, 'inactive')
  assert.match(observed.error, /not executing as root/)
})

test('stage 2 privileged health requires Linux CAP_KILL in addition to uid 0', async () => {
  let commandProbe
  const service = new Stage2Service({
    ssh: {
      async execute (connectionUrl, command, options = {}) {
        if (command.includes('/api/v3/info')) return { stdout: '{}' }
        if (command.includes('/api/v3/functions')) return { stdout: '{}' }
        if (command.includes('webminai%3Ahealth')) return rootHealthResponse('linux')
        if (command.includes('webminai%3Acommand')) {
          commandProbe = options.input
          return rootExecutionResponse()
        }
        throw new Error(`unexpected command: ${command}`)
      }
    }
  })
  const observed = await service.probe({
    connectionUrl: 'ssh://host.example',
    actionKey: 'a9'.repeat(32),
    expectedPlatform: 'linux'
  })
  assert.equal(observed.status, 'active')
  const signedPayload = Buffer.from(JSON.parse(commandProbe).payload, 'base64url').toString('utf8')
  const encodedCommand = signedPayload.match(/^command=(.+)$/mu)?.[1]
  const decodedCommand = Buffer.from(encodedCommand, 'base64url').toString('utf8')
  assert.match(decodedCommand, /CAP_KILL/)
  assert.match(decodedCommand, /0x\$cap_eff & 32/)
})

test('Netdata Cloud claiming sends validated secrets only over stdin and verifies Cloud state', async () => {
  const calls = []
  let infoAttempts = 0
  const token = 'C'.repeat(48)
  const roomIds = '34ca9c79-2354-4300-b90f-29575e338f02'
  const ssh = {
    async copy (connectionUrl, local, remote) {
      calls.push({ type: 'copy', local, remote })
    },
    async execute (connectionUrl, command, options = {}) {
      calls.push({ type: 'execute', command, options })
      if (command.includes('mktemp')) return { stdout: '/tmp/webminai.Claim123\n' }
      if (command.includes(' claim')) return { stdout: 'WEBMINAI_RESULT {"status":"configured","reload":"yes"}\n' }
      if (command.includes('/api/v3/info')) {
        infoAttempts++
        return { stdout: JSON.stringify({ agents: [{ cloud: infoAttempts === 1 ? { id: 0, status: 'available', reason: 'Agent is not claimed yet' } : { id: 'node-id', status: 'online', url: 'https://app.netdata.cloud' } }] }) }
      }
      if (command.startsWith('rm -rf')) return { stdout: '' }
      throw new Error(`unexpected command: ${command}`)
    }
  }
  const service = new Stage2Service({
    ssh,
    readinessAttempts: 2,
    readinessIntervalMs: 0,
    installerPath: '/artifacts/webminai-stage2.sh'
  })
  const result = await service.claim({
    connectionUrl: 'ssh://host.example',
    claimToken: token,
    claimUrl: 'https://app.netdata.cloud',
    roomIds
  })
  assert.equal(result.status, 'configured')
  assert.equal(result.cloud.claimed, true)
  assert.equal(result.cloud.status, 'online')
  assert.equal(calls.filter(call => call.type === 'copy').length, 1)
  const claiming = calls.find(call => call.command?.includes(' claim'))
  assert.equal(claiming.command.includes(token), false)
  assert.equal(claiming.command.includes(roomIds), false)
  assert.equal(claiming.options.input, `${token}\nhttps://app.netdata.cloud\n${roomIds}\n`)
})

function rootHealthResponse (platform) {
  return {
    stdout: JSON.stringify({
      status: 'ok',
      version: '0.7.2',
      ...(platform ? { platform } : {}),
      effectiveUid: 0
    })
  }
}

function rootExecutionResponse () {
  return {
    stdout: JSON.stringify({
      exitCode: 0,
      outputEncoding: 'base64',
      stdout: Buffer.from('WEBMINAI_HOST_ROOT_OK\n').toString('base64'),
      stderr: ''
    })
  }
}

function windowsHealthResponse () {
  return {
    stdout: JSON.stringify({
      status: 'ok',
      version: '0.7.2',
      platform: 'windows',
      executionMode: 'windows-system',
      isLocalSystem: true
    })
  }
}

function windowsExecutionResponse () {
  return {
    stdout: JSON.stringify({
      exitCode: 0,
      outputEncoding: 'base64',
      stdout: Buffer.from('WEBMINAI_WINDOWS_SYSTEM_OK\r\n').toString('base64'),
      stderr: Buffer.from('').toString('base64')
    })
  }
}

function decodePowerShellCommand (command) {
  if (typeof command !== 'string') return null
  const match = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}
