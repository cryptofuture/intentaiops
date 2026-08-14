import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { parseSshConnection } from './connection.js'
import {
  DEFAULT_SCRYPT_KDF,
  argon2Available,
  createKdfParameters,
  decryptJson,
  deriveVaultKey,
  encryptJson
} from './crypto-vault.js'
import { resolveServerDirectory, validateServerId } from './server-id.js'
import { normalizeApplicationDefaults } from './application-defaults.js'

const SETTINGS_FORMAT = 'webminai-settings'
const SETTINGS_VERSION = 1
const APPLICATION_DEFAULTS_AAD = `${SETTINGS_FORMAT}:application-defaults`
const VAULT_VERIFIER_AAD = `${SETTINGS_FORMAT}:vault-verifier`
const VAULT_VERIFIER = Object.freeze({ format: SETTINGS_FORMAT, purpose: 'vault-verifier', version: SETTINGS_VERSION })

export class SettingsStore {
  constructor (dataRoot, { kdfFactory = createKdfParameters } = {}) {
    this.dataRoot = path.resolve(dataRoot)
    this.settingsPath = path.join(this.dataRoot, 'settings.json')
    this.temporaryServerIds = new Set()
    this.kdfFactory = kdfFactory
  }

  async initialize () {
    try {
      await access(this.settingsPath)
      throw new Error('settings file already exists')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const settings = {
      format: SETTINGS_FORMAT,
      version: SETTINGS_VERSION,
      kdf: this.kdfFactory(),
      hostHistories: {},
      servers: {},
      clusters: {}
    }

    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 })
    await this.save(settings)
    return settings
  }

  async load () {
    const settings = JSON.parse(await readFile(this.settingsPath, 'utf8'))
    if (settings.format !== SETTINGS_FORMAT || settings.version !== SETTINGS_VERSION) {
      throw new Error('unsupported settings file')
    }
    if (!settings.kdf || !settings.servers || typeof settings.servers !== 'object' || Array.isArray(settings.servers)) {
      throw new Error('invalid settings file')
    }
    if (settings.clusters !== undefined && !isObject(settings.clusters)) throw new Error('invalid Kubernetes cluster registry')
    if (settings.hostHistories !== undefined && (!isObject(settings.hostHistories) || !validHostHistories(settings.hostHistories))) {
      throw new Error('invalid host history registry')
    }
    settings.hostHistories ??= {}
    settings.clusters ??= {}

    return settings
  }

  async initializeVault ({ settings, passphrase }) {
    if (!this.vaultNeedsInitialization(settings)) {
      throw new Error(settings.vaultVerifier ? 'vault verifier already exists' : 'cannot initialize a vault that already contains encrypted data')
    }
    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      settings.vaultVerifier = { secret: encryptJson(key, VAULT_VERIFIER_AAD, VAULT_VERIFIER) }
    } finally {
      key.fill(0)
    }
    await this.save(settings)
    return { migrated: false, kdf: settings.kdf.name }
  }

  vaultNeedsInitialization (settings) {
    return !settings.vaultVerifier && Object.keys(settings.servers).length === 0 && Object.keys(settings.clusters ?? {}).length === 0 && !settings.applicationDefaults
  }

  async unlockVault ({ settings, passphrase }) {
    if (this.vaultNeedsInitialization(settings)) {
      throw new Error('the vault has no encrypted verifier and must be initialized')
    }
    const currentKey = await deriveVaultKey(passphrase, settings.kdf)
    try {
      this.verifyVaultKey(settings, currentKey)
      if (!vaultUpgradeRequired(settings)) return { migrated: false, kdf: settings.kdf.name }
      const payloads = this.decryptVaultPayloads(settings, currentKey)
      return await this.reencryptVault({ settings, passphrase, payloads })
    } finally {
      currentKey.fill(0)
    }
  }

  async addServer ({
    settings,
    passphrase,
    serverId,
    connectionUrl,
    authentication = 'auto',
    sshCredential = null,
    hostFingerprint = null
  }) {
    return this.addServerEntry({
      settings,
      passphrase,
      serverId,
      connectionUrl,
      authentication,
      sshCredential,
      hostFingerprint,
      temporary: false
    })
  }

  async addTemporaryServer ({
    settings,
    passphrase,
    serverId,
    connectionUrl,
    authentication = 'auto',
    sshCredential = null,
    hostFingerprint
  }) {
    return this.addServerEntry({
      settings,
      passphrase,
      serverId,
      connectionUrl,
      authentication,
      sshCredential,
      hostFingerprint,
      temporary: true
    })
  }

  async addServerEntry ({
    settings,
    passphrase,
    serverId,
    connectionUrl,
    authentication,
    sshCredential,
    hostFingerprint,
    temporary
  }) {
    validateServerId(serverId)
    parseSshConnection(connectionUrl)
    if (!['auto', 'key', 'password'].includes(authentication)) {
      throw new TypeError('authentication must be auto, key, or password')
    }
    if (settings.servers[serverId]) {
      throw new Error(`server already exists: ${serverId}`)
    }
    if (!hostFingerprint) throw new TypeError('new hosts require a stable host fingerprint')
    validateSshCredential(sshCredential)
    const history = registerFingerprint(settings, serverId, hostFingerprint)

    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      this.authenticateOrInitializeVault(settings, key)
      settings.servers[serverId] = {
        desiredStage2: 'inactive',
        netdataOwnership: 'unknown',
        hostFingerprint,
        historyId: history.historyId,
        ...(temporary ? { temporary: true } : {}),
        secret: encryptJson(key, serverId, {
          connectionUrl,
          authentication,
          sshCredential,
          actionKey: randomBytes(32).toString('hex')
        })
      }
    } finally {
      key.fill(0)
    }

    if (temporary) this.temporaryServerIds.add(serverId)
    const directory = resolveServerDirectory(this.dataRoot, history.historyId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.save(settings)
    return settings.servers[serverId]
  }

  isTemporaryServer (serverId) {
    return this.temporaryServerIds.has(serverId)
  }

  async removeServer ({ settings, serverId }) {
    validateServerId(serverId)
    if (!settings.servers[serverId]) throw new Error(`unknown server: ${serverId}`)
    delete settings.servers[serverId]
    this.temporaryServerIds.delete(serverId)
    await this.save(settings)
  }

  async decryptServer ({ settings, passphrase, serverId }) {
    validateServerId(serverId)
    const server = settings.servers[serverId]
    if (!server) throw new Error(`unknown server: ${serverId}`)

    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      return {
        ...decryptJson(key, serverId, server.secret),
        desiredStage2: server.desiredStage2,
        netdataOwnership: server.netdataOwnership,
        hostFingerprint: server.hostFingerprint ?? null,
        historyId: server.historyId ?? serverId,
        temporary: Boolean(server.temporary || this.isTemporaryServer(serverId))
      }
    } finally {
      key.fill(0)
    }
  }

  async addKubernetesCluster ({ settings, passphrase, clusterId, kubeconfig, apiServer, contextName }) {
    validateServerId(clusterId)
    validateKubeconfig(kubeconfig)
    validateKubernetesEndpoint(apiServer)
    if (typeof contextName !== 'string' || contextName.length === 0 || contextName.length > 512 || /[\0\r\n]/u.test(contextName)) {
      throw new TypeError('Kubernetes context name is invalid')
    }
    settings.clusters ??= {}
    if (settings.servers[clusterId] || settings.clusters[clusterId]) throw new Error(`target already exists: ${clusterId}`)

    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      this.authenticateOrInitializeVault(settings, key)
      settings.clusters[clusterId] = {
        desiredStage2: 'inactive',
        secret: encryptJson(key, clusterAad(clusterId), {
          kubeconfig,
          apiServer,
          contextName,
          actionKey: randomBytes(32).toString('hex')
        })
      }
    } finally {
      key.fill(0)
    }
    await this.save(settings)
    return settings.clusters[clusterId]
  }

  async decryptKubernetesCluster ({ settings, passphrase, clusterId }) {
    validateServerId(clusterId)
    const cluster = settings.clusters?.[clusterId]
    if (!cluster) throw new Error(`unknown Kubernetes cluster: ${clusterId}`)
    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      return {
        ...decryptJson(key, clusterAad(clusterId), cluster.secret),
        desiredStage2: cluster.desiredStage2
      }
    } finally {
      key.fill(0)
    }
  }

  async setKubernetesStage2State ({ settings, clusterId, desired }) {
    validateServerId(clusterId)
    const cluster = settings.clusters?.[clusterId]
    if (!cluster) throw new Error(`unknown Kubernetes cluster: ${clusterId}`)
    if (!['active', 'inactive'].includes(desired)) throw new TypeError('desired Stage 2 state must be active or inactive')
    cluster.desiredStage2 = desired
    await this.save(settings)
  }

  async removeKubernetesCluster ({ settings, clusterId }) {
    validateServerId(clusterId)
    if (!settings.clusters?.[clusterId]) throw new Error(`unknown Kubernetes cluster: ${clusterId}`)
    delete settings.clusters[clusterId]
    await this.save(settings)
  }

  async setServerSshCredential ({ settings, passphrase, serverId, sshCredential }) {
    validateServerId(serverId)
    validateSshCredential(sshCredential)
    const server = settings.servers[serverId]
    if (!server) throw new Error(`unknown server: ${serverId}`)
    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      const decrypted = decryptJson(key, serverId, server.secret)
      server.secret = encryptJson(key, serverId, { ...decrypted, sshCredential })
    } finally {
      key.fill(0)
    }
    await this.save(settings)
  }

  async registerHostFingerprint ({ settings, serverId, fingerprint, preferredHistoryId = null }) {
    validateServerId(serverId)
    const server = settings.servers[serverId]
    if (!server) throw new Error(`unknown server: ${serverId}`)
    validateFingerprint(fingerprint)
    if (server.hostFingerprint && server.hostFingerprint !== fingerprint) {
      throw new Error(`host identity changed for ${serverId}; refusing to attach another host's task history`)
    }
    const history = registerFingerprint(settings, serverId, fingerprint, preferredHistoryId)
    server.hostFingerprint = fingerprint
    server.historyId = history.historyId
    await this.save(settings)
    return history.historyId
  }

  async decryptApplicationDefaults ({ settings, passphrase }) {
    if (!settings.applicationDefaults) return normalizeApplicationDefaults()
    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      return normalizeApplicationDefaults(decryptJson(key, APPLICATION_DEFAULTS_AAD, settings.applicationDefaults.secret))
    } finally {
      key.fill(0)
    }
  }

  async setApplicationDefaults ({ settings, passphrase, defaults }) {
    const normalized = normalizeApplicationDefaults(defaults)
    const key = await deriveVaultKey(passphrase, settings.kdf)
    try {
      this.authenticateOrInitializeVault(settings, key)
      settings.applicationDefaults = {
        secret: encryptJson(key, APPLICATION_DEFAULTS_AAD, normalized)
      }
    } finally {
      key.fill(0)
    }
    await this.save(settings)
    return normalized
  }

  async setStage2State ({ settings, serverId, desired, ownership }) {
    validateServerId(serverId)
    const server = settings.servers[serverId]
    if (!server) throw new Error(`unknown server: ${serverId}`)
    if (!['active', 'inactive'].includes(desired)) {
      throw new TypeError('desired stage 2 state must be active or inactive')
    }

    server.desiredStage2 = desired
    if (ownership !== undefined) {
      if (!['managed', 'preexisting', 'unknown'].includes(ownership)) {
        throw new TypeError('invalid Netdata ownership')
      }
      server.netdataOwnership = ownership
    }
    await this.save(settings)
  }

  async changePassphrase ({ settings, currentPassphrase, newPassphrase }) {
    if (this.vaultNeedsInitialization(settings)) {
      throw new Error('the vault has no encrypted verifier and must be initialized')
    }
    const currentKey = await deriveVaultKey(currentPassphrase, settings.kdf)
    let payloads
    try {
      this.verifyVaultKey(settings, currentKey)
      payloads = this.decryptVaultPayloads(settings, currentKey)
    } finally {
      currentKey.fill(0)
    }
    await this.reencryptVault({ settings, passphrase: newPassphrase, payloads })
    return settings
  }

  async reencryptVault ({ settings, passphrase, payloads }) {
    const nextKdf = this.kdfFactory()
    const nextKey = await deriveVaultKey(passphrase, nextKdf)
    let nextSettings
    try {
      nextSettings = {
        ...settings,
        kdf: nextKdf,
        vaultVerifier: { secret: encryptJson(nextKey, VAULT_VERIFIER_AAD, VAULT_VERIFIER) },
        ...(payloads.applicationDefaults
          ? { applicationDefaults: { secret: encryptJson(nextKey, APPLICATION_DEFAULTS_AAD, payloads.applicationDefaults) } }
          : {}),
        servers: Object.fromEntries(Object.entries(settings.servers).map(([serverId, server]) => [
          serverId,
          {
            ...server,
            secret: encryptJson(nextKey, serverId, payloads.servers.get(serverId))
          }
        ])),
        clusters: Object.fromEntries(Object.entries(settings.clusters ?? {}).map(([clusterId, cluster]) => [
          clusterId,
          {
            ...cluster,
            secret: encryptJson(nextKey, clusterAad(clusterId), payloads.clusters.get(clusterId))
          }
        ]))
      }
    } finally {
      nextKey.fill(0)
      payloads.servers.clear()
      payloads.clusters.clear()
    }

    await this.save(nextSettings)
    settings.kdf = nextSettings.kdf
    settings.vaultVerifier = nextSettings.vaultVerifier
    settings.servers = nextSettings.servers
    settings.clusters = nextSettings.clusters
    if (nextSettings.applicationDefaults) settings.applicationDefaults = nextSettings.applicationDefaults
    else delete settings.applicationDefaults
    return { migrated: true, kdf: nextKdf.name }
  }

  verifyVaultKey (settings, key) {
    if (settings.vaultVerifier) {
      const verifier = decryptJson(key, VAULT_VERIFIER_AAD, settings.vaultVerifier.secret)
      if (verifier?.format !== VAULT_VERIFIER.format || verifier?.purpose !== VAULT_VERIFIER.purpose || verifier?.version !== VAULT_VERIFIER.version) {
        throw new Error('invalid encrypted vault verifier')
      }
      return
    }
    const firstServer = Object.keys(settings.servers)[0]
    if (firstServer) {
      decryptJson(key, firstServer, settings.servers[firstServer].secret)
      return
    }
    const firstCluster = Object.keys(settings.clusters ?? {})[0]
    if (firstCluster) {
      decryptJson(key, clusterAad(firstCluster), settings.clusters[firstCluster].secret)
      return
    }
    if (settings.applicationDefaults) {
      decryptJson(key, APPLICATION_DEFAULTS_AAD, settings.applicationDefaults.secret)
      return
    }
    throw new Error('the vault has no encrypted verifier and must be initialized')
  }

  authenticateOrInitializeVault (settings, key) {
    if (this.vaultNeedsInitialization(settings)) {
      settings.vaultVerifier = { secret: encryptJson(key, VAULT_VERIFIER_AAD, VAULT_VERIFIER) }
      return
    }
    this.verifyVaultKey(settings, key)
  }

  decryptVaultPayloads (settings, key) {
    const servers = new Map()
    for (const [serverId, server] of Object.entries(settings.servers)) {
      validateServerId(serverId)
      servers.set(serverId, decryptJson(key, serverId, server.secret))
    }
    const clusters = new Map()
    for (const [clusterId, cluster] of Object.entries(settings.clusters ?? {})) {
      validateServerId(clusterId)
      clusters.set(clusterId, decryptJson(key, clusterAad(clusterId), cluster.secret))
    }
    const applicationDefaults = settings.applicationDefaults
      ? decryptJson(key, APPLICATION_DEFAULTS_AAD, settings.applicationDefaults.secret)
      : null
    return { servers, clusters, applicationDefaults }
  }

  async save (settings) {
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.settingsPath}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      const persisted = {
        ...settings,
        servers: Object.fromEntries(Object.entries(settings.servers).filter(([serverId, server]) => !server.temporary && !this.temporaryServerIds.has(serverId)))
      }
      await handle.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, this.settingsPath)
  }
}

function vaultUpgradeRequired (settings) {
  if (!settings.vaultVerifier) return true
  if (settings.kdf.name === 'argon2id') return false
  if (settings.kdf.name !== 'scrypt') return true
  if (argon2Available()) return true
  return settings.kdf.cost < DEFAULT_SCRYPT_KDF.cost ||
    settings.kdf.blockSize < DEFAULT_SCRYPT_KDF.blockSize ||
    settings.kdf.parallelization < DEFAULT_SCRYPT_KDF.parallelization ||
    settings.kdf.maxmem < DEFAULT_SCRYPT_KDF.maxmem
}

function registerFingerprint (settings, serverId, fingerprint, preferredHistoryId = null) {
  validateFingerprint(fingerprint)
  settings.hostHistories ??= {}
  for (const [configuredId, configured] of Object.entries(settings.servers)) {
    if (configuredId !== serverId && configured.hostFingerprint === fingerprint) {
      throw new Error(`host is already configured as ${configuredId}`)
    }
  }
  const now = new Date().toISOString()
  const existing = settings.hostHistories[fingerprint]
  const historyId = existing?.historyId ?? preferredHistoryId ?? historyIdForFingerprint(fingerprint)
  validateServerId(historyId)
  const conflictingHistory = Object.entries(settings.hostHistories).find(([knownFingerprint, known]) => knownFingerprint !== fingerprint && known.historyId === historyId)
  if (conflictingHistory) throw new Error(`task history ${historyId} is already associated with another host fingerprint`)
  const history = {
    historyId,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now
  }
  settings.hostHistories[fingerprint] = history
  return history
}

function historyIdForFingerprint (fingerprint) {
  return `host-${fingerprint.slice('SHA256:'.length, 'SHA256:'.length + 40)}`
}

function validateFingerprint (fingerprint) {
  if (typeof fingerprint !== 'string' || !/^SHA256:[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new TypeError('invalid host fingerprint')
  }
}

function validateSshCredential (credential) {
  if (credential === null) return
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 4096 || /[\0\r\n]/u.test(credential)) {
    throw new TypeError('SSH credential must be a non-empty single-line string no longer than 4096 characters')
  }
}

function validateKubeconfig (value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2 * 1024 * 1024 || value.includes('\0')) {
    throw new TypeError('kubeconfig must be non-empty YAML no larger than 2 MiB')
  }
}

function validateKubernetesEndpoint (value) {
  const endpoint = new URL(value)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Kubernetes API endpoint must be an HTTPS origin without credentials or query parameters')
  }
}

function clusterAad (clusterId) {
  return `kubernetes:${clusterId}`
}

function validHostHistories (histories) {
  return Object.entries(histories).every(([fingerprint, history]) => {
    try {
      validateFingerprint(fingerprint)
      validateServerId(history?.historyId)
      return typeof history.firstSeenAt === 'string' && typeof history.lastSeenAt === 'string'
    } catch {
      return false
    }
  })
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
