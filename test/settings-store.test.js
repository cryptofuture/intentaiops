import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { argon2Available, createKdfParameters } from '../src/crypto-vault.js'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'

const PASSPHRASE = 'correct horse battery staple'

test('Kubernetes kubeconfigs are encrypted, rekeyed, and keep independent Stage 2 state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intentaiops-kubernetes-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SettingsStore(root)
  const settings = await store.initialize()
  const kubeconfig = 'apiVersion: v1\nclusters: []\nprivate-marker: never-render-or-store-plainly\n'

  await store.addKubernetesCluster({
    settings,
    passphrase: PASSPHRASE,
    clusterId: 'production',
    kubeconfig,
    apiServer: 'https://cluster.example:6443',
    contextName: 'production-context'
  })
  const raw = await readFile(store.settingsPath, 'utf8')
  assert.doesNotMatch(raw, /never-render-or-store-plainly|cluster\.example|production-context/)

  const decrypted = await store.decryptKubernetesCluster({
    settings,
    passphrase: PASSPHRASE,
    clusterId: 'production'
  })
  assert.equal(decrypted.kubeconfig, kubeconfig)
  assert.equal(decrypted.apiServer, 'https://cluster.example:6443')
  assert.equal(decrypted.contextName, 'production-context')
  assert.match(decrypted.actionKey, /^[a-f0-9]{64}$/)
  assert.equal(decrypted.desiredStage2, 'inactive')

  await store.setKubernetesStage2State({ settings, clusterId: 'production', desired: 'active' })
  await store.changePassphrase({
    settings,
    currentPassphrase: PASSPHRASE,
    newPassphrase: 'five other random words protect this vault'
  })
  await assert.rejects(store.decryptKubernetesCluster({ settings, passphrase: PASSPHRASE, clusterId: 'production' }))
  const rekeyed = await store.decryptKubernetesCluster({
    settings,
    passphrase: 'five other random words protect this vault',
    clusterId: 'production'
  })
  assert.equal(rekeyed.kubeconfig, kubeconfig)
  assert.equal(rekeyed.desiredStage2, 'active')
})

test('an empty vault requires an encrypted verifier before it can be unlocked', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-empty-vault-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SettingsStore(root)
  const settings = await store.initialize()

  assert.equal(store.vaultNeedsInitialization(settings), true)
  await assert.rejects(store.unlockVault({ settings, passphrase: PASSPHRASE }), /must be initialized/)
  await store.initializeVault({ settings, passphrase: PASSPHRASE })
  assert.equal(store.vaultNeedsInitialization(settings), false)
  assert.deepEqual(await store.unlockVault({ settings, passphrase: PASSPHRASE }), {
    migrated: false,
    kdf: settings.kdf.name
  })
  await assert.rejects(store.unlockVault({
    settings,
    passphrase: 'another sufficiently long password'
  }))
})

test('a successfully authenticated legacy scrypt vault upgrades atomically to Argon2id', async t => {
  if (!argon2Available()) return t.skip('compatible @node-rs/argon2 binary is unavailable')
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-scrypt-upgrade-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyKdfFactory = () => ({
    name: 'scrypt',
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    maxmem: 64 * 1024 * 1024,
    salt: 'AAECAwQFBgcICQoLDA0ODw'
  })
  const legacyStore = new SettingsStore(root, { kdfFactory: legacyKdfFactory })
  const legacy = await legacyStore.initialize()
  await legacyStore.addServer({
    settings: legacy,
    passphrase: PASSPHRASE,
    serverId: 'legacy',
    connectionUrl: 'ssh://legacy.example.test',
    hostFingerprint: `SHA256:${'e5'.repeat(32)}`
  })
  const beforeFailedUnlock = await readFile(legacyStore.settingsPath, 'utf8')
  const store = new SettingsStore(root)
  const loaded = await store.load()
  await assert.rejects(store.unlockVault({
    settings: loaded,
    passphrase: 'another sufficiently long password'
  }))
  assert.equal(await readFile(store.settingsPath, 'utf8'), beforeFailedUnlock)

  const result = await store.unlockVault({ settings: loaded, passphrase: PASSPHRASE })
  assert.deepEqual(result, { migrated: true, kdf: 'argon2id' })
  assert.equal(loaded.kdf.name, 'argon2id')
  assert.ok(loaded.vaultVerifier?.secret)
  assert.equal((await store.decryptServer({
    settings: loaded,
    passphrase: PASSPHRASE,
    serverId: 'legacy'
  })).connectionUrl, 'ssh://legacy.example.test')
  assert.deepEqual((await store.load()).kdf, loaded.kdf)
})

test('an existing Argon2id vault is never downgraded by a scrypt-only writer', async t => {
  if (!argon2Available()) return t.skip('compatible @node-rs/argon2 binary is unavailable')
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-no-downgrade-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const argonStore = new SettingsStore(root)
  const settings = await argonStore.initialize()
  await argonStore.initializeVault({ settings, passphrase: PASSPHRASE })
  const before = await readFile(argonStore.settingsPath, 'utf8')
  const fallbackStore = new SettingsStore(root, {
    kdfFactory: () => createKdfParameters({ preferArgon2: false })
  })
  const loaded = await fallbackStore.load()
  assert.deepEqual(await fallbackStore.unlockVault({ settings: loaded, passphrase: PASSPHRASE }), {
    migrated: false,
    kdf: 'argon2id'
  })
  assert.equal(await readFile(fallbackStore.settingsPath, 'utf8'), before)
})

test('settings store encrypts server secrets and preserves stage 2 state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-settings-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const store = new SettingsStore(root)
  const settings = await store.initialize()
  await assert.rejects(store.initialize(), /already exists/)

  const connectionUrl = 'ssh://admin@example.test:2222?identity=%2Fkeys%2Fadmin'
  const sshCredential = 'private key passphrase / password'
  const primaryFingerprint = `SHA256:${'11'.repeat(32)}`
  const entry = await store.addServer({
    settings,
    passphrase: 'correct horse battery staple',
    serverId: 'primary',
    connectionUrl,
    sshCredential,
    hostFingerprint: primaryFingerprint
  })

  const raw = await readFile(path.join(root, 'settings.json'), 'utf8')
  assert.equal(raw.includes(connectionUrl), false)
  assert.equal(raw.includes('/keys/admin'), false)
  assert.equal(raw.includes(sshCredential), false)
  assert.equal((await stat(path.join(root, 'settings.json'))).mode & 0o777, 0o600)
  assert.equal(entry.secret.algorithm, 'aes-256-gcm')

  const reloaded = await store.load()
  assert.deepEqual(await store.decryptApplicationDefaults({
    settings: reloaded,
    passphrase: 'correct horse battery staple'
  }), { adminEmail: null })
  await store.setApplicationDefaults({
    settings: reloaded,
    passphrase: 'correct horse battery staple',
    defaults: { adminEmail: 'owner@example.test' }
  })
  const encryptedDefaults = await readFile(path.join(root, 'settings.json'), 'utf8')
  assert.equal(encryptedDefaults.includes('owner@example.test'), false)
  assert.deepEqual(await store.decryptApplicationDefaults({
    settings: reloaded,
    passphrase: 'correct horse battery staple'
  }), { adminEmail: 'owner@example.test' })
  const decrypted = await store.decryptServer({
    settings: reloaded,
    passphrase: 'correct horse battery staple',
    serverId: 'primary'
  })
  assert.equal(decrypted.connectionUrl, connectionUrl)
  assert.equal(decrypted.sshCredential, sshCredential)
  assert.match(decrypted.actionKey, /^[a-f0-9]{64}$/)
  assert.equal(decrypted.desiredStage2, 'inactive')

  await store.addServer({
    settings: reloaded,
    passphrase: 'correct horse battery staple',
    serverId: 'secondary',
    connectionUrl: 'ssh://admin@secondary.example.test',
    hostFingerprint: `SHA256:${'22'.repeat(32)}`
  })
  const secondary = await store.decryptServer({
    settings: reloaded,
    passphrase: 'correct horse battery staple',
    serverId: 'secondary'
  })
  assert.match(secondary.actionKey, /^[a-f0-9]{64}$/)
  assert.notEqual(secondary.actionKey, decrypted.actionKey)
  const encryptedWithTwoHosts = await readFile(path.join(root, 'settings.json'), 'utf8')
  assert.equal(encryptedWithTwoHosts.includes(decrypted.actionKey), false)
  assert.equal(encryptedWithTwoHosts.includes(secondary.actionKey), false)

  const previousSalt = reloaded.kdf.salt
  await store.changePassphrase({
    settings: reloaded,
    currentPassphrase: 'correct horse battery staple',
    newPassphrase: 'a different vault passphrase'
  })
  assert.notEqual(reloaded.kdf.salt, previousSalt)
  assert.deepEqual(await store.decryptApplicationDefaults({
    settings: reloaded,
    passphrase: 'a different vault passphrase'
  }), { adminEmail: 'owner@example.test' })
  await assert.rejects(store.decryptServer({
    settings: reloaded,
    passphrase: 'correct horse battery staple',
    serverId: 'primary'
  }))
  const reloadedAfterChange = await store.load()
  const rekeyed = await store.decryptServer({
    settings: reloadedAfterChange,
    passphrase: 'a different vault passphrase',
    serverId: 'primary'
  })
  assert.equal(rekeyed.connectionUrl, connectionUrl)
  assert.equal(rekeyed.sshCredential, sshCredential)
  assert.equal(rekeyed.actionKey, decrypted.actionKey)
  assert.deepEqual(await store.decryptApplicationDefaults({
    settings: reloadedAfterChange,
    passphrase: 'a different vault passphrase'
  }), { adminEmail: 'owner@example.test' })
  await store.setServerSshCredential({
    settings: reloadedAfterChange,
    passphrase: 'a different vault passphrase',
    serverId: 'primary',
    sshCredential: null
  })
  assert.equal((await store.decryptServer({
    settings: reloadedAfterChange,
    passphrase: 'a different vault passphrase',
    serverId: 'primary'
  })).sshCredential, null)
  await assert.rejects(
    store.decryptServer({ settings: reloaded, passphrase: 'this passphrase is wrong', serverId: 'primary' })
  )

  await store.setStage2State({
    settings: reloaded,
    serverId: 'primary',
    desired: 'active',
    ownership: 'managed'
  })
  const updated = await store.load()
  assert.equal(updated.servers.primary.desiredStage2, 'active')
  assert.equal(updated.servers.primary.netdataOwnership, 'managed')
})

test('temporary and re-added hosts retain fingerprint-associated task history without retaining the connection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-temporary-host-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const passphrase = 'correct horse battery staple'
  const fingerprint = `SHA256:${'a1'.repeat(32)}`
  const store = new SettingsStore(root)
  const settings = await store.initialize()
  const temporary = await store.addTemporaryServer({
    settings,
    passphrase,
    serverId: 'temporary-one',
    connectionUrl: 'ssh://temporary.example.test',
    authentication: 'password',
    sshCredential: 'temporary password',
    hostFingerprint: fingerprint
  })
  assert.equal(store.isTemporaryServer('temporary-one'), true)
  const aliases = new Map([['temporary-one', temporary.historyId]])
  const tasks = new TaskStore(root, { directoryAliases: aliases })
  const task = tasks.create('temporary-one', 'inspect the temporary host')

  const persistedText = await readFile(path.join(root, 'settings.json'), 'utf8')
  assert.equal(persistedText.includes('temporary-one'), false)
  assert.equal(persistedText.includes('temporary.example.test'), false)
  assert.equal(persistedText.includes('temporary password'), false)
  const nextStore = new SettingsStore(root)
  const nextSettings = await nextStore.load()
  assert.equal(nextSettings.servers['temporary-one'], undefined)
  const readded = await nextStore.addServer({
    settings: nextSettings,
    passphrase,
    serverId: 'permanent-name',
    connectionUrl: 'ssh://renamed.example.test',
    hostFingerprint: fingerprint
  })
  assert.equal(readded.historyId, temporary.historyId)
  const reattachedTasks = new TaskStore(root, {
    directoryAliases: new Map([['permanent-name', readded.historyId]])
  })
  assert.equal(reattachedTasks.get('permanent-name', task.id).request, 'inspect the temporary host')
})

test('removing and re-adding a saved host under another name preserves its task history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-readded-host-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const passphrase = 'correct horse battery staple'
  const fingerprint = `SHA256:${'b2'.repeat(32)}`
  const store = new SettingsStore(root)
  const settings = await store.initialize()
  const original = await store.addServer({
    settings,
    passphrase,
    serverId: 'old-name',
    connectionUrl: 'ssh://old.example.test',
    hostFingerprint: fingerprint
  })
  const tasks = new TaskStore(root, {
    directoryAliases: new Map([['old-name', original.historyId]])
  })
  const task = tasks.create('old-name', 'retained history entry')
  await store.removeServer({ settings, serverId: 'old-name' })

  const reloaded = await store.load()
  const readded = await store.addServer({
    settings: reloaded,
    passphrase,
    serverId: 'new-name',
    connectionUrl: 'ssh://new.example.test',
    hostFingerprint: fingerprint
  })
  assert.equal(readded.historyId, original.historyId)
  const restored = new TaskStore(root, {
    directoryAliases: new Map([['new-name', readded.historyId]])
  })
  assert.equal(restored.get('new-name', task.id).request, 'retained history entry')
  await assert.rejects(store.addServer({
    settings: reloaded,
    passphrase,
    serverId: 'duplicate-name',
    connectionUrl: 'ssh://duplicate.example.test',
    hostFingerprint: fingerprint
  }), /already configured as new-name/)
})

test('settings store rejects unsafe server ids and unsupported SSH passwords', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-settings-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SettingsStore(root)
  const settings = await store.initialize()

  await assert.rejects(store.addServer({
    settings,
    passphrase: 'correct horse battery staple',
    serverId: '../escape',
    connectionUrl: 'ssh://example.test'
  }), /server id/)
  await assert.rejects(store.addServer({
    settings,
    passphrase: 'correct horse battery staple',
    serverId: 'safe',
    connectionUrl: 'ssh://user:password@example.test'
  }), /passwords are not supported/)
})
