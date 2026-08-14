import assert from 'node:assert/strict'
import test from 'node:test'
import { addHost, addKubernetesCluster, changeVaultPassphrase, chooseElevation, claimNetdataCloud, redactHealthText, unlock } from '../src/cli.js'
import { VaultAuthenticationError } from '../src/crypto-vault.js'

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
