import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { normalizeDockerPreference } from './docker-policy.js'
import { rootExecutionPolicy } from './execution-policy.js'
import { resolveServerDirectory } from './server-id.js'

const RULES_FORMAT = 'webminai-server-rules'
const RULES_VERSION = 1

export class ServerWorkspace {
  constructor (dataRoot, { directoryAliases = new Map() } = {}) {
    this.dataRoot = path.resolve(dataRoot)
    this.directoryAliases = directoryAliases
  }

  directory (serverId) {
    return resolveServerDirectory(this.dataRoot, this.directoryAliases.get(serverId) ?? serverId)
  }

  setDirectoryAlias (serverId, historyId) {
    resolveServerDirectory(this.dataRoot, serverId)
    resolveServerDirectory(this.dataRoot, historyId)
    this.directoryAliases.set(serverId, historyId)
  }

  clearDirectoryAlias (serverId) {
    this.directoryAliases.delete(serverId)
  }

  async initialize (serverId, policy = {}) {
    const directory = this.directory(serverId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const rules = {
      format: RULES_FORMAT,
      version: RULES_VERSION,
      policy,
      preferences: { docker: 'auto' }
    }
    await this.saveRules(serverId, rules)
    return normalizeRules(rules)
  }

  async ensureInitialized (serverId, policy = {}) {
    try {
      return await this.loadRules(serverId)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return this.initialize(serverId, policy)
    }
  }

  async loadRules (serverId) {
    const rules = JSON.parse(await readFile(path.join(this.directory(serverId), 'rules.json'), 'utf8'))
    return normalizeRules(rules)
  }

  async saveRules (serverId, rules) {
    await this.writeJson(serverId, 'rules.json', normalizeRules(rules))
  }

  async enableRootExecution (serverId) {
    const rules = await this.loadRules(serverId)
    rules.policy = rootExecutionPolicy(rules.policy)
    await this.saveRules(serverId, rules)
    return rules
  }

  async setDockerPreference (serverId, preference) {
    const rules = await this.loadRules(serverId)
    rules.preferences.docker = normalizeDockerPreference(preference)
    await this.saveRules(serverId, rules)
    return rules
  }

  async saveObserved (serverId, inventory, observedAt = new Date()) {
    const observed = {
      format: 'webminai-observed-inventory',
      version: 1,
      observedAt: observedAt.toISOString(),
      inventory
    }
    await this.writeJson(serverId, 'observed.json', observed)
    return observed
  }

  async loadObserved (serverId) {
    return JSON.parse(await readFile(path.join(this.directory(serverId), 'observed.json'), 'utf8'))
  }

  async saveHostContext (serverId, context) {
    await this.writeJson(serverId, 'host-context.json', context)
    return context
  }

  async loadHostContext (serverId) {
    return JSON.parse(await readFile(path.join(this.directory(serverId), 'host-context.json'), 'utf8'))
  }

  async saveHealthContext (serverId, context) {
    await this.writeJson(serverId, 'health-context.json', context)
    return context
  }

  async loadHealthContext (serverId) {
    return JSON.parse(await readFile(path.join(this.directory(serverId), 'health-context.json'), 'utf8'))
  }

  async saveUpdateContext (serverId, context) {
    await this.writeJson(serverId, 'update-context.json', context)
    return context
  }

  async loadUpdateContext (serverId) {
    return JSON.parse(await readFile(path.join(this.directory(serverId), 'update-context.json'), 'utf8'))
  }

  async writeJson (serverId, filename, value) {
    const directory = this.directory(serverId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const destination = path.join(directory, filename)
    const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
  }
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRules (rules) {
  if (rules.format !== RULES_FORMAT || rules.version !== RULES_VERSION || !isObject(rules.policy)) {
    throw new Error('invalid server rules file')
  }
  const preferences = rules.preferences === undefined ? {} : rules.preferences
  if (!isObject(preferences)) throw new Error('invalid server rules file')
  return {
    ...rules,
    preferences: {
      ...preferences,
      docker: normalizeDockerPreference(preferences.docker)
    }
  }
}
