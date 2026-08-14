import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { createKubernetesApiCommand, createSignedCommand, NetdataClient } from '../src/netdata-client.js'

const ACTION_KEY = '11'.repeat(32)

test('signed command envelope authenticates exactly the encoded payload', () => {
  const envelope = createSignedCommand('printf hello', ACTION_KEY, 1710000000000)
  const secondEnvelope = createSignedCommand('printf hello', ACTION_KEY, 1710000000000)
  const payload = Buffer.from(envelope.payload, 'base64url').toString('utf8')
  assert.match(payload, /^v=1\nissuedAt=1710000000\nrequestId=/)
  assert.equal(
    envelope.mac,
    createHmac('sha256', Buffer.from(ACTION_KEY, 'hex')).update(payload).digest('hex')
  )
  assert.equal(
    Buffer.from(payload.split('\n').find(line => line.startsWith('command=')).slice(8), 'base64url').toString(),
    'printf hello'
  )
  assert.notEqual(secondEnvelope.payload, envelope.payload)
  assert.notEqual(secondEnvelope.mac, envelope.mac)
})

test('Kubernetes API commands use a strict encoded request format', () => {
  const command = createKubernetesApiCommand({
    method: 'post',
    path: '/apis/batch/v1/namespaces/webminai/jobs',
    body: { kind: 'Job' }
  })
  const fields = Object.fromEntries(command.split('\n').map(line => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))
  assert.equal(fields.v, '1')
  assert.equal(fields.method, 'POST')
  assert.equal(Buffer.from(fields.path, 'base64url').toString(), '/apis/batch/v1/namespaces/webminai/jobs')
  assert.equal(Buffer.from(fields.body, 'base64url').toString(), '{"kind":"Job"}')
  assert.equal(fields.contentType, 'application/json')
  assert.throws(() => createKubernetesApiCommand({ method: 'EXEC', path: '/api/v1/nodes' }), /method/)
  assert.throws(() => createKubernetesApiCommand({ method: 'GET', path: '/api/v1/../secrets' }), /path/)
  assert.throws(() => createKubernetesApiCommand({ method: 'POST', path: '/api/v1/nodes' }), /require a body/)
})

test('Netdata client reaches only loopback through system SSH', async () => {
  const calls = []
  const ssh = {
    async execute (connectionUrl, command, options = {}) {
      calls.push({ connectionUrl, command, options })
      return { stdout: '{"exitCode":0,"stdout":"done"}' }
    }
  }
  const client = new NetdataClient({
    ssh,
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })
  const result = await client.runCommand('id', { timeoutSeconds: 12 })
  assert.equal(result.stdout, 'done')
  assert.match(calls[0].command, /http:\/\/127\.0\.0\.1:19999\/api\/v3\/function/)
  assert.match(calls[0].command, /--data-binary @-/)
  assert.equal(calls[0].command.includes(ACTION_KEY), false)
  const body = JSON.parse(calls[0].options.input)
  assert.match(body.mac, /^[a-f0-9]{64}$/)
  assert.equal(calls[0].options.timeoutMs, 17000)
})

test('FreeBSD execution inventory recognizes ready Podman Compose on a non-jail host', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://freebsd.example', actionKey: ACTION_KEY })
  client.runCommand = async command => {
    assert.match(command, /freebsd-version/)
    return {
      exitCode: 0,
      stdout: 'freebsdVersion=15.1-RELEASE-p2|15.1-RELEASE-p2\narchitecture=amd64\njailed=0\npodmanCli=yes\npodmanReady=yes\ncomposeAvailable=yes\ncomposeCommand=podman-compose\ninstallSupported=yes\n',
      stderr: ''
    }
  }
  const inventory = await client.freebsdExecutionInventory()
  assert.equal(inventory.platform, 'freebsd')
  assert.equal(inventory.docker.runtime, 'podman')
  assert.equal(inventory.docker.installSupported, true)
  assert.equal(inventory.docker.composeCommand, 'podman-compose')
  assert.equal(inventory.docker.requiresExplicitLinuxPlatform, true)
  assert.equal(inventory.docker.virtualizationRequired, false)
  assert.match(inventory.docker.virtualizationInstructions, /jails and VFS/u)
})

test('macOS execution inventory distinguishes Homebrew availability from hypervisor support', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://mac.example', actionKey: ACTION_KEY })
  client.runCommand = async command => {
    assert.match(command, /kern\.hv_support/u)
    assert.match(command, /\.colima\/default\/docker\.sock/u)
    return {
      exitCode: 0,
      stdout: 'macosVersion=15.7.9\narchitecture=x86_64\nmemoryBytes=4294967296\ncpuCount=2\nhypervisorSupport=0\nbrewPath=/usr/local/bin/brew\nbrewPrefix=/usr/local\nbrewRepository=/usr/local/Homebrew\nruntimeUser=mac\nruntimeHome=/Users/mac\ncolimaPath=\ndockerPath=\ndockerSocket=\ndockerCli=no\ndockerDaemon=no\ncomposeAvailable=no\ncomposeCommand=\ninstallSupported=no\n',
      stderr: ''
    }
  }
  const inventory = await client.macosExecutionInventory()
  assert.equal(inventory.platform, 'macos')
  assert.equal(inventory.packageManager, 'homebrew')
  assert.equal(inventory.hypervisorSupport, false)
  assert.equal(inventory.docker.installSupported, false)
  assert.equal(inventory.docker.runtimeUser, 'mac')
  assert.equal(inventory.docker.installMethod, 'homebrew-colima')
  assert.equal(inventory.docker.virtualizationRequired, true)
  assert.equal(inventory.docker.virtualizationAvailable, false)
})

test('Netdata client decodes plugin output after transport', async () => {
  const client = new NetdataClient({
    ssh: {
      async execute () {
        return {
          stdout: JSON.stringify({
            exitCode: 0,
            outputEncoding: 'base64',
            stdout: Buffer.from('hello ✓').toString('base64'),
            stderr: ''
          })
        }
      }
    },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })
  const result = await client.runCommand('true')
  assert.equal(result.stdout, 'hello ✓')
  assert.equal(result.stderr, '')
})

test('Netdata client runs a durable job through short signed polling requests and cleans it up', async () => {
  const calls = []
  const responses = [
    { status: 'accepted', state: 'running', jobId: 'ab'.repeat(16) },
    { status: 'ok', state: 'running', jobId: 'ab'.repeat(16), outputEncoding: 'base64', stdout: Buffer.from('building\n').toString('base64'), stderr: '' },
    { status: 'ok', state: 'succeeded', jobId: 'ab'.repeat(16), exitCode: 0, signal: 0, timedOut: false, outputEncoding: 'base64', stdout: Buffer.from('complete\n').toString('base64'), stderr: '' },
    { status: 'ok', state: 'cleaned', jobId: 'ab'.repeat(16) }
  ]
  const client = new NetdataClient({
    ssh: {
      async execute (connectionUrl, command, options) {
        calls.push({ command, options })
        return { stdout: JSON.stringify(responses.shift()) }
      }
    },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })
  const states = []
  const result = await client.runJob('printf complete', {
    timeoutSeconds: 900,
    pollIntervalMs: 100,
    onStatus: status => states.push(status.state)
  })
  assert.deepEqual(states, ['running', 'succeeded'])
  assert.equal(result.stdout, 'complete\n')
  assert.equal(result.cleaned, true)
  assert.match(calls[0].command, /webminai%3Ajob_start/)
  assert.match(calls[1].command, /webminai%3Ajob_status/)
  assert.match(calls[3].command, /webminai%3Ajob_cleanup/)
  const envelope = JSON.parse(calls[0].options.input)
  const payload = Buffer.from(envelope.payload, 'base64url').toString('utf8')
  const encodedRequest = payload.split('\n').find(line => line.startsWith('command=')).slice(8)
  const request = Buffer.from(encodedRequest, 'base64url').toString('utf8')
  assert.match(request, /^timeoutSeconds=900\ncommand=/u)
  assert.equal(Buffer.from(request.split('\n')[1].slice(8), 'base64url').toString(), 'printf complete')
  assert.equal(calls.every(call => call.options.timeoutMs === 15000), true)
})

test('Netdata client exposes signed job cancellation', async () => {
  let request
  const client = new NetdataClient({
    ssh: {
      async execute (connectionUrl, command, options) {
        request = { command, envelope: JSON.parse(options.input) }
        return { stdout: JSON.stringify({ status: 'ok', state: 'cancelling', jobId: 'cd'.repeat(16) }) }
      }
    },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })
  const result = await client.cancelJob('cd'.repeat(16))
  assert.equal(result.state, 'cancelling')
  assert.match(request.command, /webminai%3Ajob_cancel/)
  const payload = Buffer.from(request.envelope.payload, 'base64url').toString('utf8')
  const encodedRequest = payload.split('\n').find(line => line.startsWith('command=')).slice(8)
  assert.equal(Buffer.from(encodedRequest, 'base64url').toString(), 'cd'.repeat(16))
})

test('durable job polling survives a short Netdata plugin restart', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://server.example', actionKey: ACTION_KEY })
  const jobId = '12'.repeat(16)
  let statusCalls = 0
  client.startJob = async () => ({ status: 'accepted', state: 'running', jobId })
  client.jobStatus = async () => {
    statusCalls++
    if (statusCalls === 1) {
      const cause = new Error('SSH command failed with exit code 22')
      cause.result = { stdout: '{"status":404,"error":"job not found"}', stderr: 'curl: 404' }
      throw new Error('Netdata job status failed', { cause })
    }
    return { status: 'ok', state: 'succeeded', jobId, exitCode: 0, stdout: 'resumed', stderr: '' }
  }
  client.cleanupJob = async () => ({ status: 'ok', state: 'cleaned', jobId })
  const states = []
  const result = await client.runJob('long-command', {
    pollIntervalMs: 100,
    onStatus: status => states.push(status.state)
  })
  assert.deepEqual(states, ['temporarily_unavailable', 'succeeded'])
  assert.equal(result.stdout, 'resumed')
  assert.equal(result.cleaned, true)
})

test('durable job polling recovers from an SSH transport timeout', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://host', actionKey: ACTION_KEY })
  const jobId = '34'.repeat(16)
  let polls = 0
  client.startJob = async () => ({ status: 'accepted', state: 'running', jobId })
  client.jobStatus = async () => {
    polls++
    if (polls === 1) {
      const error = new Error('Netdata POST failed: SSH command failed with exit code null')
      error.cause = { result: { code: null, signal: 'SIGTERM', stdout: '', stderr: '' } }
      throw error
    }
    return { status: 'ok', state: 'succeeded', jobId, exitCode: 0, stdout: 'resumed', stderr: '' }
  }
  client.cleanupJob = async () => ({ status: 'ok', state: 'cleaned', jobId })
  const result = await client.runJob('true', { pollIntervalMs: 100 })
  assert.equal(result.state, 'succeeded')
  assert.equal(result.stdout, 'resumed')
  assert.equal(polls, 2)
})

test('Docker execution inventory detects Compose and a containerized host', async () => {
  const client = new NetdataClient({
    ssh: {},
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })
  client.runCommand = async command => {
    assert.match(command, /systemd-detect-virt --container/)
    assert.match(command, /\/dev\/lxd\/sock/)
    assert.match(command, /docker compose version/)
    return {
      exitCode: 0,
      stdout: 'containerRuntime=lxc\ndockerCli=yes\ndockerDaemon=yes\ndockerCompose=yes\ndockerComposeCommand=docker compose\n',
      stderr: ''
    }
  }
  assert.deepEqual(await client.dockerExecutionInventory(), {
    platform: 'linux',
    installSupported: false,
    installMethod: null,
    cliAvailable: true,
    daemonReachable: true,
    composeAvailable: true,
    composeCommand: 'docker compose',
    hostIsContainer: true,
    containerRuntime: 'lxc',
    virtualizationRequired: false,
    virtualizationAvailable: true,
    virtualizationInstructions: 'Docker Engine uses Linux namespaces and cgroups; VT-x, AMD-V, and nested virtualization are not required. Nested Docker inside a container instead requires explicit outer-host privileges.'
  })
})

test('Linux execution inventory is collected through the signed plugin without changing the host', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://server.example', actionKey: ACTION_KEY })
  client.runCommand = async (command, options) => {
    assert.match(command, /\/etc\/os-release/)
    assert.match(command, /commandName in apt apt-cache dnf/)
    assert.match(command, /installedPackagesBase64/)
    assert.match(command, /serviceUnitsBase64/)
    assert.match(command, /probeVersion nginx nginx -v/)
    assert.deepEqual(options, { timeoutSeconds: 30 })
    return {
      exitCode: 0,
      stdout: `osReleaseBase64=${Buffer.from('ID=ubuntu\nVERSION_ID="24.04"\n').toString('base64')}\narchitecture=x86_64\nkernel=6.8.0\ninit=systemd\ncommand_apt=yes\ncommand_systemctl=yes\n`,
      stderr: ''
    }
  }
  const inventory = await client.linuxExecutionInventory()
  assert.equal(inventory.osRelease.ID, 'ubuntu')
  assert.equal(inventory.osRelease.VERSION_ID, '24.04')
  assert.equal(inventory.commands.apt, true)
  assert.equal(inventory.commands.systemctl, true)
  assert.deepEqual(inventory.installedPackages, [])
  assert.deepEqual(inventory.serviceUnits, [])
})

test('Netdata inventory identifies the preferred API and includes alert state', async () => {
  const calls = []
  const client = new NetdataClient({
    ssh: {
      async execute (connectionUrl, command) {
        calls.push(command)
        return { stdout: JSON.stringify({ command }) }
      }
    },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })

  const inventory = await client.inventory()
  assert.equal(inventory.source.name, 'Netdata Agent')
  assert.equal(inventory.source.apiVersion, 3)
  assert.ok(inventory.source.preferredFor.includes('containers'))
  assert.equal(inventory.source.endpoints.data, '/api/v3/data')
  assert.match(inventory.alerts.command, /\/api\/v3\/alerts/)
  assert.equal(calls.length, 5)
})

test('Netdata inventory retains available data when an optional v3 endpoint is unavailable', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://server.example', actionKey: ACTION_KEY })
  client.info = async () => ({ host: 'alpha' })
  client.contexts = async () => ({ contexts: ['system.cpu'] })
  client.nodeInstances = async () => ({ nodes: ['alpha'] })
  client.functions = async () => ({ functions: [] })
  client.alerts = async () => { throw new Error('HTTP 404 endpoint unavailable') }
  const inventory = await client.inventory()
  assert.deepEqual(inventory.info, { host: 'alpha' })
  assert.deepEqual(inventory.contexts, { contexts: ['system.cpu'] })
  assert.equal(inventory.alerts, null)
  assert.match(inventory.source.endpointErrors.alerts, /404/u)
})

test('root readiness executes a signed host filesystem write probe', async () => {
  let signedCommand
  const client = new NetdataClient({
    ssh: {
      async execute (connectionUrl, command, options) {
        const envelope = JSON.parse(options.input)
        const payload = Buffer.from(envelope.payload, 'base64url').toString('utf8')
        const encodedCommand = payload.split('\n').find(line => line.startsWith('command=')).slice(8)
        signedCommand = Buffer.from(encodedCommand, 'base64url').toString('utf8')
        return {
          stdout: JSON.stringify({
            exitCode: 0,
            outputEncoding: 'base64',
            stdout: Buffer.from('WEBMINAI_HOST_ROOT_OK\n').toString('base64'),
            stderr: ''
          })
        }
      }
    },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })

  assert.deepEqual(await client.rootExecutionHealth(), {
    status: 'ok',
    identity: 'root',
    hostExecution: true
  })
  assert.match(signedCommand, /\/etc\/\.webminai-root-probe-[0-9a-f-]+/)
  assert.match(signedCommand, /rm -f/)
})

test('Windows execution inventory records package tools visible to LocalSystem', async () => {
  let signedCommand
  const client = new NetdataClient({
    ssh: {
      async execute (connectionUrl, command, options) {
        const envelope = JSON.parse(options.input)
        const payload = Buffer.from(envelope.payload, 'base64url').toString('utf8')
        signedCommand = Buffer.from(payload.split('\n').find(line => line.startsWith('command=')).slice(8), 'base64url').toString('utf8')
        const inventory = {
          platform: 'windows',
          identity: 'LocalSystem',
          powerShellVersion: '5.1.26200.6899',
          is64BitProcess: true,
          commands: { winget: false, chocolatey: false, msiexec: true, curl: true }
        }
        return {
          stdout: JSON.stringify({
            exitCode: 0,
            outputEncoding: 'base64',
            stdout: Buffer.from(JSON.stringify(inventory)).toString('base64'),
            stderr: ''
          })
        }
      }
    },
    connectionUrl: 'ssh://windows.example',
    actionKey: ACTION_KEY
  })

  const inventory = await client.windowsExecutionInventory()
  assert.equal(inventory.identity, 'LocalSystem')
  assert.equal(inventory.commands.winget, false)
  assert.equal(inventory.commands.msiexec, true)
  assert.match(signedCommand, /Get-Command winget\.exe/)
  assert.match(signedCommand, /chocolatey\\bin\\choco\.exe/)
  assert.match(signedCommand, /Docker\\Docker\\resources\\bin\\docker\.exe/)
  assert.match(signedCommand, /Start-Process -FilePath \$dockerPath/u)
  assert.match(signedCommand, /WaitForExit\(3000\)/u)
  assert.match(signedCommand, /\.OSType.*\.ServerVersion.*\.Architecture/u)
  assert.doesNotMatch(signedCommand, /\{\{json \.\}\}/u)
  assert.match(signedCommand, /VirtualizationFirmwareEnabled/u)
  assert.match(signedCommand, /slatReportedByProcessor/u)
  assert.match(signedCommand, /consoleUser/u)
  assert.match(signedCommand, /Microsoft-Windows-Subsystem-Linux/u)
})

test('Netdata request errors identify the failing endpoint and preserve SSH evidence', async () => {
  const remote = new Error('SSH command failed with exit code 22')
  remote.result = { code: 22, stdout: '{"status":404}', stderr: 'curl: 404' }
  const client = new NetdataClient({
    ssh: { async execute () { throw remote } },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY
  })
  await assert.rejects(client.health(), error => {
    assert.match(error.message, /GET \/api\/v3\/function\?function=webminai%3Ahealth/)
    assert.equal(error.cause, remote)
    return true
  })
})

test('Netdata health retries transient function readiness failures', async () => {
  let attempts = 0
  const client = new NetdataClient({
    ssh: {
      async execute () {
        attempts++
        if (attempts < 3) {
          const error = new Error('SSH command failed with exit code 22')
          error.result = { code: 22, stdout: '{"status":503}', stderr: 'curl: (22) HTTP 503' }
          throw error
        }
        return { stdout: '{"status":"ok","version":"0.5.0"}' }
      }
    },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY,
    healthRetryMs: 0
  })

  assert.deepEqual(await client.health(), { status: 'ok', version: '0.5.0' })
  assert.equal(attempts, 3)
})

test('Netdata health does not retry a permanent missing-function response', async () => {
  let attempts = 0
  const remote = new Error('SSH command failed with exit code 22')
  remote.result = { code: 22, stdout: '{"status":404}', stderr: 'curl: (22) HTTP 404' }
  const client = new NetdataClient({
    ssh: { async execute () { attempts++; throw remote } },
    connectionUrl: 'ssh://server.example',
    actionKey: ACTION_KEY,
    healthRetryMs: 0
  })

  await assert.rejects(client.health(), /Netdata GET/)
  assert.equal(attempts, 1)
})
