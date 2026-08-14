import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { HostSessionFactory } from '../src/host-session-factory.js'

function dependencies ({ savedCredential = null, fingerprintError = null } = {}) {
  const calls = []
  const session = {
    ssh: {
      async hostFingerprint () {
        if (fingerprintError) throw fingerprintError
        return 'SHA256:stable-host'
      }
    },
    async close () { calls.push('close') }
  }
  const settingsStore = {
    dataRoot: '/tmp/webminai-test',
    async decryptServer () {
      return { connectionUrl: 'ssh://root@example.test', authentication: 'auto', sshCredential: savedCredential }
    },
    async registerHostFingerprint (input) {
      calls.push({ fingerprint: input.fingerprint })
      return 'host-sha256-stable'
    }
  }
  const workspace = {
    directoryAliases: new Map(),
    setDirectoryAlias (serverId, historyId) { calls.push({ alias: [serverId, historyId] }) }
  }
  return { calls, session, settingsStore, workspace }
}

test('host session factory owns credential fallback, fingerprint registration, and host composition', async () => {
  const setup = dependencies({ savedCredential: 'encrypted-value' })
  const warnings = []
  let attempts = 0
  const baseSsh = {
    async openInteractiveSession (connectionUrl, options) {
      setup.calls.push({ connectionUrl, options })
      attempts++
      if (attempts === 1) throw new Error('credential rejected')
      return setup.session
    }
  }
  const factory = new HostSessionFactory({
    dataRoot: '/tmp/webminai-test',
    settingsStore: setup.settingsStore,
    workspace: setup.workspace,
    baseSsh,
    onWarning: warning => warnings.push(warning)
  })
  const opened = await factory.open({
    settings: { servers: { prod: { historyId: 'legacy' } } },
    passphrase: 'test-passphrase',
    serverId: 'prod'
  })

  assert.equal(attempts, 2)
  assert.match(warnings[0], /credential rejected/u)
  assert.equal(opened.server.historyId, 'host-sha256-stable')
  assert.equal(opened.admin.ssh, setup.session.ssh)
  assert.equal(opened.stage2.ssh, setup.session.ssh)
  assert.deepEqual(setup.calls.find(call => call.alias).alias, ['prod', 'host-sha256-stable'])
})

test('host session factory closes the sole SSH session when fingerprint setup fails', async () => {
  const setup = dependencies({ fingerprintError: new Error('fingerprint failed') })
  const factory = new HostSessionFactory({
    dataRoot: '/tmp/webminai-test',
    settingsStore: setup.settingsStore,
    workspace: setup.workspace,
    baseSsh: { async openInteractiveSession () { return setup.session } }
  })

  await assert.rejects(factory.open({
    settings: { servers: { prod: {} } },
    passphrase: 'test-passphrase',
    serverId: 'prod'
  }), /fingerprint failed/u)
  assert.equal(setup.calls.filter(call => call === 'close').length, 1)
})

test('host session factory reports SSH success before host identity probing finishes', async () => {
  const setup = dependencies()
  const progress = []
  let releaseFingerprint
  setup.session.ssh.hostFingerprint = async () => new Promise(resolve => { releaseFingerprint = resolve })
  const factory = new HostSessionFactory({
    dataRoot: '/tmp/webminai-test',
    settingsStore: setup.settingsStore,
    workspace: setup.workspace,
    baseSsh: { async openInteractiveSession () { return setup.session } }
  })

  const opening = factory.open({
    settings: { servers: { prod: {} } },
    passphrase: 'test-passphrase',
    serverId: 'prod',
    onProgress: event => progress.push(event)
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(progress.slice(0, 3).map(event => [event.phase, event.state]), [
    ['ssh', 'started'],
    ['ssh', 'completed'],
    ['identity', 'started']
  ])
  releaseFingerprint('SHA256:stable-host')
  await opening
  assert.equal(progress.at(-1).phase, 'identity')
  assert.equal(progress.at(-1).state, 'completed')
})

test('host runtime dependency direction stays behind public factory and admin methods', async () => {
  const [cli, multiHost] = await Promise.all([
    readFile(new URL('../src/cli.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/multi-host-service.js', import.meta.url), 'utf8')
  ])
  assert.doesNotMatch(cli, /function connectedHost\b/u)
  assert.match(cli, /function runConnectedHostSession\b/u)
  assert.doesNotMatch(multiHost, /admin\.stage2|admin\.ssh|admin\.workspace/u)
  assert.match(multiHost, /admin\.capabilities/u)
})
