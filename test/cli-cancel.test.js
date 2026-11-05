import assert from 'node:assert/strict'
import test from 'node:test'
import { addHost, addKubernetesCluster, changeVaultPassphrase, chooseElevation, claimNetdataCloud, redactHealthText, unlock } from '../src/cli.js'
import { VaultAuthenticationError } from '../src/crypto-vault.js'
import { createHash } from 'node:crypto'

test('elevation reuses a verified SSH password and falls back to the normal prompt', async () => {
  const ui = quietUi({ secrets: ['different sudo password'] })
  let probes = 0
  const saved = async () => { probes++; return 'verified password' }
  assert.deepEqual(await chooseElevation(ui, { hasSudo: true }, saved), { elevation: 'sudo-password', sudoPassword: 'verified password' })
  assert.deepEqual(await chooseElevation(ui, { hasSudo: true }, async password => password ?? null), { elevation: 'sudo-password', sudoPassword: 'different sudo password' })
  for (const capabilities of [{ isRoot: true }, { hasPasswordlessSudo: true }, { hasPasswordlessDoas: true }, { platform: { os: 'windows' }, isAdministrator: true }]) await chooseElevation(ui, capabilities, saved)
  assert.equal(probes, 1)
})

test('elevation validates and saves entered passwords, reprompting only after rejection', async () => {
  const ui = quietUi({ secrets: ['wrong', 'right'] })
  ui.warn = () => {}
  const candidates = []
  const elevation = await chooseElevation(ui, { hasSudo: true }, async password => {
    candidates.push(password)
    return password === 'right' ? password : null
  })
  assert.deepEqual(candidates, [undefined, 'wrong', 'right'])
  assert.deepEqual(elevation, { elevation: 'sudo-password', sudoPassword: 'right' })
})

test('Netdata claiming reuses the saved host sudo password without an elevation prompt', async () => {
  const ui = quietUi({ answers: ['https://app.netdata.cloud'], confirm: true })
  const prompts = []
  ui.secret = async label => {
    prompts.push(label)
    return prompts.length === 1 ? '' : prompts.length === 2 ? 'a'.repeat(48) : ''
  }
  ui.ask = async label => label.startsWith('Claim URL') ? 'https://app.netdata.cloud' : '11111111-2222-3333-4444-555555555555'
  let claimed = false
  await claimNetdataCloud({
    ui,
    settings: {},
    passphrase: 'vault',
    serverId: 'host',
    status: { capabilities: { hasNetdata: true, hasSudo: true }, cloud: { claimed: false } },
    admin: {
      savedSudoPassword: async () => 'saved sudo password',
      claimNetdataCloud: async args => {
        claimed = true
        assert.equal(args.sudoPassword, 'saved sudo password')
        return { cloud: { status: 'online' } }
      }
    }
  })
  assert.equal(claimed, true)
  assert.ok(!prompts.includes('Sudo password'))
})

test('vault unlock retries only authentication failures and retains the final cause', async () => {
  const errors = []
  const ui = quietUi({ secrets: ['wrong passphrase one', 'wrong passphrase two', 'wrong passphrase three'] })
  ui.error = message => errors.push(message)
  const authenticationErrors = []
  const store = unlockStore(async () => {
    const error = new VaultAuthenticationError()
    authenticationErrors.push(error)
    throw error
  })

  await assert.rejects(unlock(ui, store), error => {
    assert.equal(error.message, 'unable to unlock the vault')
    assert.equal(error.cause, authenticationErrors.at(-1))
    return true
  })
  assert.deepEqual(errors, Array(3).fill('The vault passphrase is incorrect.'))
})

test('vault unlock surfaces format failures without retrying them as passphrase errors', async () => {
  const errors = []
  let decryptions = 0
  const ui = quietUi({ secrets: ['valid length passphrase'] })
  ui.error = message => errors.push(message)
  const formatError = new Error('unsupported encrypted settings format')
  const store = unlockStore(async () => {
    decryptions++
    throw formatError
  })

  await assert.rejects(unlock(ui, store), error => error === formatError)
  assert.equal(decryptions, 1)
  assert.deepEqual(errors, [])
})

test('Add Host returns immediately when the host name is blank', async () => {
  let opened = false
  const result = await addHost({
    context: addHostContext({
      answers: [''],
      open: () => { opened = true }
    })
  })
  assert.equal(result, null)
  assert.equal(opened, false)
})

test('Add Host can cancel at the SSH destination or authentication steps', async () => {
  let opened = 0
  const destination = await addHost({
    context: addHostContext({ answers: ['alpha', ''], open: () => { opened++ } })
  })
  assert.equal(destination, null)

  const authentication = await addHost({
    context: addHostContext({ answers: ['alpha', 'ssh root@alpha.test'], choice: null, open: () => { opened++ } })
  })
  assert.equal(authentication, null)
  assert.equal(opened, 0)
})

test('Add Host can remain temporary while preserving its fingerprint history alias', async () => {
  const fingerprint = `SHA256:${'c3'.repeat(32)}`
  let added
  let alias
  let initialized = false
  let closed = false
  const context = addHostContext({
    answers: ['temporary-host', 'ssh admin@temporary.example'],
    secrets: ['saved ssh password'],
    choices: ['password', 'save'],
    open: async () => ({
      ssh: {
        execute: async () => ({ stdout: 'WEBMINAI_SSH_OK\n' }),
        hostFingerprint: async () => fingerprint
      },
      close: async () => { closed = true }
    })
  })
  context.settingsStore.addTemporaryServer = async options => {
    added = options
    return { historyId: 'host-c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3' }
  }
  context.workspace.setDirectoryAlias = (serverId, historyId) => { alias = { serverId, historyId } }
  context.workspace.ensureInitialized = async () => { initialized = true }

  const result = await addHost({ context, temporary: true })
  assert.equal(result, 'temporary-host')
  assert.equal(closed, true)
  assert.equal(added.hostFingerprint, fingerprint)
  assert.equal(added.sshCredential, 'saved ssh password')
  assert.equal(alias.serverId, 'temporary-host')
  assert.equal(initialized, true)
})

test('Add Host identifies an existing machine before asking to save another credential', async () => {
  const fingerprint = `SHA256:${'d4'.repeat(32)}`
  let closed = false
  const context = addHostContext({ answers: ['second', 'ssh admin@second.test'], choice: 'password', open: async () => ({ ssh: { execute: async () => ({ stdout: 'WEBMINAI_SSH_OK\n' }), hostFingerprint: async () => fingerprint }, close: async () => { closed = true } }) })
  context.settings.servers.first = { hostFingerprint: fingerprint }
  const errors = []
  context.ui.error = message => errors.push(message)
  context.ui.secret = async () => assert.fail('must not ask for a password after an identity collision')
  assert.equal(await addHost({ context }), null)
  assert.equal(closed, true)
  assert.match(errors[0], /already configured as first/u)
  assert.match(errors[0], /not a duplicate password/u)
  assert.match(errors[0], /cloned machine ID/u)
})

for (const platform of ['linux', 'freebsd']) {
  for (const approved of [false, true]) {
    test(`duplicate ${platform} VPS identity replacement requires explicit confirmation: ${approved}`, async () => {
      let machineId = platform === 'linux' ? 'a'.repeat(32) : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let mutations = 0; let added
      const fingerprint = () => `SHA256:${createHash('sha256').update(`${platform}:${machineId}`).digest('hex')}`
      const originalFingerprint = fingerprint()
      const context = addHostContext({
        answers: ['second', 'ssh admin@second.test'],
        choices: ['password', 'save'],
        secrets: ['shared password'],
        open: async () => ({
          ssh: {
            hostFingerprint: async () => fingerprint(),
            execute: async (url, command, options) => {
              if (command === 'echo WEBMINAI_SSH_OK') return { stdout: 'WEBMINAI_SSH_OK\n' }
              if (command === 'hostname') return { stdout: 'same-cloned-hostname\n' }
              if (command.includes("printf 'uid=%s")) return { stdout: `system=${platform === 'linux' ? 'Linux' : 'FreeBSD'}\nmachine=x86_64\nuid=0\nsudo=no\n` }
              if (command.startsWith('test "$(uname -s)"')) return { stdout: machineId }
              if (command === '/bin/sh') {
                assert.equal(approved, true)
                mutations++
                machineId = platform === 'linux' ? options.input.match(/printf[^\n]*'([a-f0-9]{32})'/u)[1] : options.input.match(/prepare \/etc\/hostid "\$host_tmp" '([a-f0-9-]{36})'/u)[1]
                return { code: 0, stdout: platform === 'linux' ? 'WEBMINAI_MACHINE_ID_CHANGED\n' : 'WEBMINAI_FREEBSD_HOST_ID_CHANGED\n' }
              }
              throw new Error('Unexpected test operation')
            }
          },
          close: async () => {}
        })
      })
      const existing = { hostFingerprint: originalFingerprint }
      context.settings.servers.first = existing
      context.settingsStore.decryptServer = async () => ({ connectionUrl: 'ssh://admin@first.test' })
      context.settingsStore.addServer = async args => { added = args; return { historyId: 'new-history' } }
      context.workspace.setDirectoryAlias = () => {}
      context.workspace.ensureInitialized = async () => {}
      const prompts = []; const lines = []
      context.ui.line = (label, value) => lines.push([label, value])
      context.ui.confirm = async (question, defaultValue) => { prompts.push(question); assert.equal(defaultValue, false); return approved }
      const result = await addHost({ context })
      assert.equal(result, approved ? 'second' : null)
      assert.equal(mutations, approved ? 1 : 0)
      assert.equal(prompts.length, 1)
      assert.match(prompts[0], /different VPS from first/u)
      assert.ok(lines.some(([label, value]) => label === 'Existing configured host' && value === 'first'))
      assert.ok(lines.some(([label, value]) => label === 'Connected hostname' && value === 'same-cloned-hostname'))
      assert.deepEqual(existing, { hostFingerprint: originalFingerprint })
      if (approved) { assert.notEqual(added.hostFingerprint, originalFingerprint); assert.equal(added.sshCredential, 'shared password') } else assert.equal(added, undefined)
    })
  }
}

test('unsupported platforms never offer an identity rewrite', async () => {
  for (const system of ['UnknownOS']) {
    const fingerprint = `SHA256:${'a'.repeat(64)}`
    const context = addHostContext({ answers: ['second', 'ssh admin@second.test'], choice: 'password', open: async () => ({ ssh: { hostFingerprint: async () => fingerprint, execute: async (_url, command) => command === 'echo WEBMINAI_SSH_OK' ? { stdout: 'WEBMINAI_SSH_OK\n' } : { stdout: `system=${system}\nmachine=amd64\nuid=1000\n` } }, close: async () => {} }) })
    context.settings.servers.first = { hostFingerprint: fingerprint }
    context.ui.confirm = async () => assert.fail('unsupported identity must not be rewritten')
    assert.equal(await addHost({ context }), null)
  }
})

test('Add Kubernetes cluster validates API access and saves the hidden kubeconfig encrypted', async () => {
  const kubeconfig = 'apiVersion: v1\nprivate-key-data: hidden-value\n'
  let saved
  const ui = quietUi({ answers: ['production'], choices: ['paste'], confirm: true })
  ui.secretEditor = async () => kubeconfig
  const result = await addKubernetesCluster({
    context: {
      ui,
      settingsStore: {
        addKubernetesCluster: async options => { saved = options }
      },
      settings: { servers: {}, clusters: {} },
      passphrase: 'vault passphrase',
      createKubernetesClient: source => ({
        server: new URL('https://cluster.example:6443'),
        contextName: 'production-context',
        clusterName: 'production-api',
        version: async () => ({ gitVersion: 'v1.36.1' }),
        nodes: async () => ({ items: [{ metadata: { name: 'worker-1' } }] }),
        source
      })
    }
  })

  assert.equal(result, 'production')
  assert.equal(saved.clusterId, 'production')
  assert.equal(saved.kubeconfig, kubeconfig)
  assert.equal(saved.apiServer, 'https://cluster.example:6443')
  assert.equal(saved.contextName, 'production-context')
})

test('vault passphrase change and sudo elevation treat blank secrets as cancel', async () => {
  let changed = false
  const ui = quietUi({ secrets: [''] })
  const result = await changeVaultPassphrase({
    ui,
    settingsStore: { changePassphrase: async () => { changed = true } },
    settings: { servers: {} },
    passphrase: 'current passphrase'
  })
  assert.equal(result, null)
  assert.equal(changed, false)

  const elevation = await chooseElevation(quietUi({ secrets: [''] }), { hasSudo: true })
  assert.equal(elevation, null)
})

test('manual Netdata claiming can cancel before retaining or sending a token', async () => {
  let claimed = false
  const ui = quietUi({ secrets: ['', ''] })
  await claimNetdataCloud({
    ui,
    admin: { claimNetdataCloud: async () => { claimed = true } },
    settings: {},
    passphrase: 'vault passphrase',
    serverId: 'alpha',
    status: { capabilities: { hasNetdata: true }, cloud: { claimed: false } },
    debug: true
  })
  assert.equal(claimed, false)
})

test('health evidence redacts credential-shaped log content before Codex receives it', () => {
  const redacted = redactHealthText('password=hunter2 token:abc123 Authorization:BearerValue Bearer eyJhbGciOi postgres://admin:secret@db/app https://name:pass@example.test/path')
  assert.doesNotMatch(redacted, /hunter2|abc123|BearerValue|eyJhbGciOi|admin:secret|name:pass/u)
  assert.match(redacted, /password=\[redacted\]/u)
  assert.match(redacted, /\[redacted-(?:service-)?url\]/u)
})

function addHostContext ({ answers, secrets = [], choice = 'auto', choices = null, open }) {
  return {
    ui: quietUi({ answers, secrets, choice, choices }),
    settingsStore: {
      addServer: async () => { throw new Error('must not save a cancelled host') }
    },
    workspace: {
      initialize: async () => { throw new Error('must not initialize a cancelled host') }
    },
    baseSsh: { openInteractiveSession: open },
    settings: { servers: {} },
    passphrase: 'vault passphrase'
  }
}

function quietUi ({ answers = [], secrets = [], choice = 'auto', choices = null, confirm = false } = {}) {
  return {
    clear () {},
    banner () {},
    heading () {},
    separator () {},
    info () {},
    warn () {},
    error () {},
    success () {},
    line () {},
    output: { write () {} },
    ask: async () => answers.shift() ?? '',
    secret: async () => secrets.shift() ?? '',
    choose: async () => choices ? choices.shift() : choice,
    confirm: async () => confirm,
    pause: async () => {}
  }
}

function unlockStore (unlockVault) {
  return {
    settingsPath: new URL(import.meta.url).pathname,
    dataRoot: '/tmp/webminai-unlock-test',
    load: async () => ({ servers: { primary: {} } }),
    vaultNeedsInitialization: () => false,
    unlockVault
  }
}
