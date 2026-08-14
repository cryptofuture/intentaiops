import path from 'node:path'
import { CodexPlanner } from './codex-planner.js'
import { resolveDockerPolicy } from './docker-policy.js'
import { composeFoundationAssistedPlan, executableFoundationFromCandidates } from './deployment-foundations.js'
import { NetdataClient } from './netdata-client.js'
import { detectPersistedPlatform } from './platform-identity.js'
import { executeApprovedPlan, validateCommandPlan } from './plan-validator.js'
import { LinuxHostContextService } from './linux-host-context.js'
import { ServerWorkspace } from './server-workspace.js'
import { SettingsStore } from './settings-store.js'
import { Stage2Service } from './stage2-service.js'
import { SystemSsh } from './system-ssh.js'
import { TaskStore } from './task-store.js'

export class AdminService {
  constructor ({
    dataRoot,
    ssh = new SystemSsh(),
    settings = new SettingsStore(dataRoot),
    workspace = new ServerWorkspace(dataRoot),
    tasks = null,
    stage2 = new Stage2Service({ ssh }),
    planner = new CodexPlanner(),
    linuxContext = new LinuxHostContextService()
  }) {
    this.dataRoot = path.resolve(dataRoot)
    this.ssh = ssh
    this.settings = settings
    this.workspace = workspace
    this.tasks = tasks ?? new TaskStore(dataRoot, { directoryAliases: workspace.directoryAliases })
    this.stage2 = stage2
    this.planner = planner
    this.linuxContext = linuxContext
  }

  async addServer ({
    settings,
    passphrase,
    serverId,
    connectionUrl,
    authentication,
    sshCredential = null,
    hostFingerprint = null,
    temporary = false,
    policy = {}
  }) {
    const add = temporary
      ? this.settings.addTemporaryServer.bind(this.settings)
      : this.settings.addServer.bind(this.settings)
    const entry = await add({
      settings,
      passphrase,
      serverId,
      connectionUrl,
      authentication,
      sshCredential,
      hostFingerprint
    })
    if (entry.historyId && typeof this.workspace.setDirectoryAlias === 'function') {
      this.workspace.setDirectoryAlias(serverId, entry.historyId)
    }
    if (typeof this.workspace.ensureInitialized === 'function') await this.workspace.ensureInitialized(serverId, policy)
    else await this.workspace.initialize(serverId, policy)
    return entry
  }

  async activate ({ settings, passphrase, serverId, elevation, sudoPassword, installNetdata = true }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const result = await this.stage2.activate({ ...server, elevation, sudoPassword, installNetdata })
    await this.settings.setStage2State({
      settings,
      serverId,
      desired: 'active',
      ownership: result.ownership
    })
    await this.workspace.enableRootExecution(serverId)
    return result
  }

  async deactivate ({
    settings,
    passphrase,
    serverId,
    removeManagedNetdata = false,
    elevation,
    sudoPassword
  }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const result = await this.stage2.deactivate({
      ...server,
      removeManagedNetdata,
      elevation,
      sudoPassword
    })
    await this.settings.setStage2State({
      settings,
      serverId,
      desired: 'inactive',
      ownership: result.ownership
    })
    return result
  }

  async claimNetdataCloud ({ settings, passphrase, serverId, claimToken, claimUrl, roomIds, elevation, sudoPassword }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    return this.stage2.claim({
      connectionUrl: server.connectionUrl,
      claimToken,
      claimUrl,
      roomIds,
      elevation,
      sudoPassword
    })
  }

  async capabilities ({ settings, passphrase, serverId }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    return this.stage2.capabilities(server)
  }

  async refreshInventory ({ settings, passphrase, serverId }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const client = this.netdata(server)
    const inventory = await client.inventory()
    const health = await client.health()
    const platform = health.platform ?? detectPersistedPlatform(inventory) ?? (await this.stage2.capabilities(server)).platform.os
    const rules = await this.workspace.loadRules(serverId)
    let dockerCapability = { platform }
    if (platform === 'windows') {
      inventory.webminaiExecution = await client.windowsExecutionInventory()
      dockerCapability = {
        platform: 'windows',
        installSupported: false,
        ...inventory.webminaiExecution.docker
      }
    }
    if (platform === 'linux') {
      const [docker, execution] = await Promise.all([
        client.dockerExecutionInventory().catch(error => ({ platform: 'linux', error: error.message })),
        client.linuxExecutionInventory()
      ])
      dockerCapability = docker
      inventory.webminaiLinuxContext = await this.refreshLinuxHostContext({
        settings,
        passphrase,
        serverId,
        inventory,
        client,
        execution,
        docker
      })
    }
    if (platform === 'freebsd') {
      inventory.webminaiExecution = await client.freebsdExecutionInventory()
      dockerCapability = inventory.webminaiExecution.docker
    }
    if (platform === 'macos') {
      inventory.webminaiExecution = await client.macosExecutionInventory()
      dockerCapability = inventory.webminaiExecution.docker
    }
    inventory.webminaiDocker = resolveDockerPolicy({
      preference: rules.preferences.docker,
      capability: dockerCapability,
      inventory
    })
    const healthContext = await this.loadHealthContext(serverId)
    if (healthContext) inventory.webminaiHealthContext = healthContext
    const updateContext = await this.loadUpdateContext(serverId)
    if (updateContext) inventory.webminaiUpdateContext = updateContext
    await this.workspace.saveObserved(serverId, inventory)
    return inventory
  }

  async refreshLinuxHostContext ({ settings, passphrase, serverId, inventory, client, execution, docker = {} }) {
    const saveHostContext = requireWorkspaceMethod(this.workspace, 'saveHostContext')
    const previous = await this.loadHostContext(serverId)
    try {
      const netdata = client ?? this.netdata(await this.serverSecrets({ settings, passphrase, serverId }))
      const observedExecution = execution ?? await netdata.linuxExecutionInventory()
      const context = await this.linuxContext.build({ inventory, execution: observedExecution, docker, previous })
      if (context) await saveHostContext(serverId, context)
      return context
    } catch (error) {
      const observedAt = new Date().toISOString()
      const fallback = previous
        ? { ...previous, observedAt, refreshError: boundedContextError(error), cache: { ...previous.cache, reused: true } }
        : {
            format: 'webminai-linux-host-context',
            version: 1,
            observedAt,
            status: 'unavailable',
            refreshError: boundedContextError(error)
          }
      await saveHostContext(serverId, fallback)
      return fallback
    }
  }

  async loadHostContext (serverId) {
    if (typeof this.workspace.loadHostContext !== 'function') return null
    try {
      return await this.workspace.loadHostContext(serverId)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
  }

  async saveHealthContext (serverId, context) {
    return requireWorkspaceMethod(this.workspace, 'saveHealthContext')(serverId, context)
  }

  async loadHealthContext (serverId) {
    if (typeof this.workspace.loadHealthContext !== 'function') return null
    try {
      return await this.workspace.loadHealthContext(serverId)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
  }

  async saveUpdateContext (serverId, context) {
    return requireWorkspaceMethod(this.workspace, 'saveUpdateContext')(serverId, context)
  }

  async loadUpdateContext (serverId) {
    if (typeof this.workspace.loadUpdateContext !== 'function') return null
    try {
      return await this.workspace.loadUpdateContext(serverId)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
  }

  async plan ({
    settings,
    passphrase,
    serverId,
    request,
    inventory,
    taskId,
    previousAttempts,
    retryInstructions,
    consultationContext,
    candidateContext,
    applicationDefaults,
    onProgress
  }) {
    const rules = await this.workspace.loadRules(serverId)
    const observed = withDockerPreference(
      inventory ?? await this.refreshInventory({ settings, passphrase, serverId }),
      rules.preferences.docker
    )
    const foundation = executableFoundationFromCandidates(candidateContext)
    const applicationPlan = await this.planner.plan({
      serverDirectory: this.workspace.directory(serverId),
      request,
      inventory: observed,
      policy: rules.policy,
      taskId,
      previousAttempts,
      retryInstructions,
      consultationContext,
      deploymentBlueprint: foundation?.blueprint ?? null,
      candidateContext,
      applicationDefaults,
      onProgress
    })
    if (!foundation) return applicationPlan
    return validateCommandPlan(composeFoundationAssistedPlan({
      foundation,
      applicationPlan,
      platform: observedPlatform(observed),
      docker: observed.webminaiDocker ?? {}
    }), rules.policy)
  }

  async routeTask ({ settings, passphrase, serverId, request, inventory, candidates, onProgress }) {
    const observed = inventory ?? await this.refreshInventory({ settings, passphrase, serverId })
    return this.planner.routeTask({
      serverDirectory: this.workspace.directory(serverId),
      request,
      inventory: observed,
      candidates,
      onProgress
    })
  }

  async consult ({
    settings,
    passphrase,
    serverId,
    question,
    inventory,
    consultationContext,
    onProgress
  }) {
    const rules = await this.workspace.loadRules(serverId)
    const observed = withDockerPreference(
      inventory ?? await this.refreshInventory({ settings, passphrase, serverId }),
      rules.preferences.docker
    )
    return this.planner.consult({
      serverDirectory: this.workspace.directory(serverId),
      question,
      inventory: observed,
      policy: rules.policy,
      consultationContext,
      onProgress
    })
  }

  async execute ({ settings, passphrase, serverId, plan, approve, onResult, requireRevert = true }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const rules = await this.workspace.loadRules(serverId)
    return executeApprovedPlan({
      plan,
      policy: rules.policy,
      netdata: this.netdata(server),
      approve,
      onResult,
      requireRevert
    })
  }

  async revertTask ({ settings, passphrase, serverId, taskId, approve, onResult }) {
    const task = this.tasks.get(serverId, taskId)
    if (!task.plan || !Array.isArray(task.plan.revertCommands) || task.plan.revertCommands.length === 0) {
      throw new Error(`task ${taskId} has no revert plan`)
    }
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const rules = await this.workspace.loadRules(serverId)
    const revertPlan = {
      ...task.plan,
      summary: `Revert task ${taskId}: ${task.plan.summary}`,
      changeOverview: `Restore the state captured before task ${taskId}`,
      commands: task.plan.revertCommands,
      revertCommands: []
    }
    return executeApprovedPlan({
      plan: revertPlan,
      policy: rules.policy,
      netdata: this.netdata(server),
      approve,
      onResult,
      requireRevert: false
    })
  }

  createTask (serverId, request, options) {
    return this.tasks.create(serverId, request, options)
  }

  listTasks (serverId, options) {
    return this.tasks.list(serverId, options)
  }

  getTask (serverId, taskId) {
    return this.tasks.get(serverId, taskId)
  }

  getTaskRetryHistory (serverId, taskId, { limit = 20 } = {}) {
    const history = []
    const seen = new Set()
    let currentId = taskId
    while (currentId && history.length < limit && !seen.has(currentId)) {
      seen.add(currentId)
      const task = this.tasks.get(serverId, currentId)
      history.unshift(task)
      currentId = task.retryOfTaskId
    }
    return history
  }

  listPendingConsultations (serverId, options) {
    return this.tasks.listPendingConsultations(serverId, options)
  }

  getTaskConsultations (serverId, taskId) {
    return this.tasks.consultationsForTask(serverId, taskId)
  }

  saveTaskPlan (serverId, taskId, plan) {
    return this.tasks.savePlan(serverId, taskId, plan)
  }

  saveConsultation (serverId, taskId, consultation) {
    return this.tasks.saveConsultation(serverId, taskId, consultation)
  }

  markTaskRunning (serverId, taskId) {
    return this.tasks.markRunning(serverId, taskId)
  }

  saveTaskResults (serverId, taskId, results) {
    return this.tasks.saveResults(serverId, taskId, results)
  }

  appendTaskProgress (serverId, taskId, event) {
    return this.tasks.appendProgress(serverId, taskId, event)
  }

  appendTaskResult (serverId, taskId, result) {
    return this.tasks.appendResult(serverId, taskId, result)
  }

  markTaskReverting (serverId, taskId) {
    return this.tasks.markReverting(serverId, taskId)
  }

  appendTaskRevertResult (serverId, taskId, result) {
    return this.tasks.appendRevertResult(serverId, taskId, result)
  }

  saveTaskRevertResults (serverId, taskId, results) {
    return this.tasks.saveRevertResults(serverId, taskId, results)
  }

  saveTaskRevertError (serverId, taskId, error) {
    return this.tasks.saveRevertError(serverId, taskId, error)
  }

  saveTaskError (serverId, taskId, error) {
    return this.tasks.saveError(serverId, taskId, error)
  }

  cancelTask (serverId, taskId) {
    return this.tasks.cancel(serverId, taskId)
  }

  async serverSecrets ({ settings, passphrase, serverId }) {
    return this.settings.decryptServer({ settings, passphrase, serverId })
  }

  netdata ({ connectionUrl, actionKey }) {
    return new NetdataClient({ ssh: this.ssh, connectionUrl, actionKey })
  }
}

function withDockerPreference (inventory, preference) {
  return {
    ...inventory,
    webminaiDocker: resolveDockerPolicy({
      preference,
      capability: inventory?.webminaiDocker,
      inventory
    })
  }
}

function boundedContextError (error) {
  return String(error?.message ?? error).replaceAll(/[\r\n]+/gu, ' ').slice(0, 300)
}

function requireWorkspaceMethod (workspace, method) {
  if (typeof workspace?.[method] !== 'function') {
    throw new TypeError(`workspace.${method} must be a function`)
  }
  return workspace[method].bind(workspace)
}

function observedPlatform (inventory) {
  if (inventory?.webminaiLinuxContext) return 'linux'
  return detectPersistedPlatform(inventory) ?? 'linux'
}
