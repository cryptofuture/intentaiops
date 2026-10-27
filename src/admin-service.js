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
import { planFingerprint } from './execution-journal.js'
import { detectOperationLoop } from './operation-loop-detector.js'
import { executionDiagnostics, diagnosticSummary } from './execution-diagnostics.js'
import { captureExecutionEvidence } from './host-execution-evidence.js'
import { RemoteRecoveryState } from './remote-recovery-state.js'
import { RemoteRecoveryTransport } from './remote-recovery-transport.js'
import { commonTaskRecoveryManifest, commonTaskRecoverySupported, RemoteCommonTaskJournal, retrieveRecoveryExecution, regenerateCommonTaskRecovery } from './remote-common-task-recovery.js'
import { inspectRecoveryBaseline } from './remote-recovery-baseline.js'
import { startExecutionHeartbeat } from './execution-heartbeat.js'
import { guardAdminMutations } from './host-mutation-ownership.js'
import { recordApplicationSecurity } from './software-security.js'

const REMOTE_RECOVERY_EXECUTION = Symbol('reviewed remote common-task recovery')

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
    this.remoteRecovery = new RemoteRecoveryState(this.dataRoot)
    guardAdminMutations(this)
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
    catalogId = null,
    previousAttempts,
    retryInstructions,
    consultationContext,
    candidateContext,
    applicationDefaults,
    requireRevert = true,
    onProgress
  }) {
    const loop = detectOperationLoop(previousAttempts, settings.operationLoop)
    if (loop.detected && !retryInstructions?.trim()) throw new Error(`${loop.reason}; alternative operator instructions required`)
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
      catalogId,
      previousAttempts,
      retryInstructions,
      consultationContext,
      deploymentBlueprint: foundation?.blueprint ?? null,
      candidateContext,
      applicationDefaults,
      requireRevert,
      onProgress
    })
    if (!foundation) return applicationPlan
    return validateCommandPlan(composeFoundationAssistedPlan({
      foundation,
      applicationPlan,
      platform: observedPlatform(observed),
      docker: observed.webminaiDocker ?? {}
    }), rules.policy, { requireRevert })
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

  async execute ({ settings, passphrase, serverId, taskId, plan, approve, onResult, onProgress, beforeCommand, requireRevert = true, executionObserver, recoveryAuthorization }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const rules = await this.workspace.loadRules(serverId)
    if (taskId === undefined) return executeApprovedPlan({ plan, policy: rules.policy, netdata: this.netdata(server), approve, onResult, onProgress, requireRevert })
    const recoveryState = this.remoteRecovery.get(settings.servers?.[serverId]?.hostFingerprint, taskId)
    if (recoveryState?.manifest.recoveryId && recoveryAuthorization !== REMOTE_RECOVERY_EXECUTION) throw new Error('Use remote common-task recovery to recheck the source head, baseline and ownership before execution')
    const lease = this.tasks.acquireExecution(serverId, taskId, plan)
    const heartbeat = startExecutionHeartbeat(this.tasks, serverId, taskId, lease.owner)
    try {
      const saved = this.tasks.get(serverId, taskId)
      const remoteJournal = await this.remoteTaskJournal({ settings, serverId, taskId, plan, server, task: saved })
      if (saved.results?.length && this.tasks.executionEvents(serverId, taskId).length === 0) throw new Error('legacy execution has no journal; continuation requires operator investigation')
      const state = this.tasks.executionState(serverId, taskId)
      if (this.tasks.rollbackState(serverId, taskId).some(command => command.status !== 'pending')) throw new Error('rollback has started; do not resume the original deployment')
      if (state.some(command => ['uncertain', 'failed'].includes(command.status))) throw new Error('task requires operator reconciliation before continuation; no commands were dispatched')
      const previous = this.tasks.get(serverId, taskId).results ?? []
      const recordExecutionEvent = async event => {
        heartbeat.check()
        if (event.type !== 'command_dispatched') this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, event)
        // Recovery callbacks must not re-enter the SSH connection they are restoring.
        if (remoteJournal && event.type !== 'execution_recovery') {
          let baselineDigest = null
          if (event.type === 'command_completed' && commonTaskRecoverySupported(saved.catalogId, recoveryState?.manifest.platform)) {
            baselineDigest = await inspectRecoveryBaseline(this.netdata(server), saved.catalogId, taskId, plan.compatibilityManifest?.host?.family).catch(() => null)
          }
          await remoteJournal.append(event, { baselineDigest })
        }
        if (event.type !== 'execution_recovery') await executionObserver?.(event)
        if (event.type === 'command_dispatched') this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, event)
        if (event.type === 'execution_paused' && event.metadata?.reason === 'recovery_requires_approval') {
          const control = this.tasks.control(serverId, taskId)
          if (control.action === 'run') this.tasks.setControl(serverId, taskId, 'pause', control.version)
        }
      }
      if (this.tasks.executionEvents(serverId, taskId).length) await recordExecutionEvent({ type: 'execution_resumed' })
      const results = await executeApprovedPlan({
        plan,
        policy: rules.policy,
        netdata: this.netdata(server),
        approve,
        onResult,
        onProgress: event => {
          this.tasks.appendProgress(serverId, taskId, event)
          return onProgress?.(event)
        },
        beforeCommand: async (item, { recheck = false } = {}) => {
          const control = this.tasks.control(serverId, taskId)
          if (control.action !== 'run') {
            await recordExecutionEvent({ type: 'execution_paused', metadata: { aborted: control.action === 'abort' } })
            return false
          }
          if (!recheck && beforeCommand && await beforeCommand(item) === false) {
            await recordExecutionEvent({ type: 'execution_paused' })
            return false
          }
          return true
        },
        completedCommandIds: state.filter(command => command.status === 'completed').map(command => command.commandId),
        onExecutionEvent: recordExecutionEvent,
        requireRevert
      })
      const confirmed = state.filter(command => command.status === 'completed').map(command => previous.find(result => result.id === command.commandId && result.status === 'completed') ?? { id: command.commandId, status: 'completed', result: { exitCode: 0, stdout: '[completion confirmed by execution journal]', stderr: '' } })
      if (remoteJournal && !this.tasks.executionState(serverId, taskId).some(command => command.status === 'uncertain')) await remoteJournal.release()
      const all = [...confirmed, ...results]
      if (plan.commands.every(command => all.some(result => result.id === command.id && result.status === 'completed'))) {
        try { recordApplicationSecurity({ admin: this, serverId, task: saved, results: all, onProgress }) } catch {
          try { onProgress?.({ type: 'security_report_unavailable', message: 'Security assessment unavailable; installation outcomes are unchanged and patch state remains unknown.' }) } catch {}
        }
      }
      return all
    } finally {
      heartbeat.stop()
      this.tasks.releaseExecution(serverId, taskId, lease.owner)
    }
  }

  async revertTask ({ settings, passphrase, serverId, taskId, reviewedPlan, approve, onResult, onProgress }) {
    const task = this.tasks.get(serverId, taskId)
    if (task.catalogId === 'intent-ai-ops-windows' && ((reviewedPlan ?? task.plan)?.modifiedFiles ?? []).some(file => path.win32.normalize(file).replace(/[\\/]+$/u, '').toLowerCase() === 'c:\\programdata\\intentaiops')) throw new Error('Legacy Windows CLI rollback targets the recovery ledger parent; prepare a separately reviewed cleanup that preserves Recovery')
    if (!reviewedPlan && (!task.plan || !Array.isArray(task.plan.revertCommands) || task.plan.revertCommands.length === 0)) {
      throw new Error(`task ${taskId} has no revert plan`)
    }
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const rules = await this.workspace.loadRules(serverId)
    const revertPlan = reviewedPlan ?? savedRevertPlan(task)
    const remoteJournal = await this.remoteTaskJournal({ settings, serverId, taskId, plan: reviewedPlan ? { ...task.plan, revertCommands: reviewedPlan.commands } : task.plan, server, task })
    const lease = this.tasks.acquireExecution(serverId, taskId, task.plan)
    const heartbeat = startExecutionHeartbeat(this.tasks, serverId, taskId, lease.owner)
    try {
      if (reviewedPlan) {
        const executed = new Set(this.tasks.executionState(serverId, taskId).filter(command => command.status !== 'pending').map(command => command.commandId))
        if (reviewedPlan.commands.some(command => executed.has(command.id))) throw new Error('rollback revision reuses an executed deployment command; propose new reviewed cleanup commands')
      }
      if (this.tasks.executionState(serverId, taskId).some(command => command.status === 'uncertain')) throw new Error('rollback requires operator reconciliation of uncertain commands')
      if (this.tasks.rollbackState(serverId, taskId).some(command => command.status === 'uncertain')) throw new Error('rollback outcome requires reconciliation before further changes')
      if (!reviewedPlan && this.tasks.executionEvents(serverId, taskId).length && this.tasks.executionState(serverId, taskId).some(command => command.status !== 'completed')) throw new Error('partial execution requires a separately reviewed rollback plan; saved rollback commands do not identify their forward changes')
      this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, { type: 'rollback_started' })
      await remoteJournal?.append({ type: 'rollback_started' }, { operation: 'rollback' })
      const rollbackRevision = planFingerprint(revertPlan)
      const history = this.tasks.allExecutionEvents(serverId, taskId).filter(event => event.metadata.rollbackRevision === rollbackRevision && event.commandId && !['plan_approved', 'execution_recovery'].includes(event.type))
      const last = new Map(history.map(event => [event.commandId, event]))
      if ([...last.values()].some(event => !['command_completed', 'command_prepared'].includes(event.type))) throw new Error('rollback outcome needs reconciliation; rollback will not be repeated')
      const results = await executeApprovedPlan({
        plan: revertPlan,
        policy: rules.policy,
        netdata: this.netdata(server),
        approve,
        onResult,
        onProgress: event => { this.tasks.appendProgress(serverId, taskId, event); return onProgress?.(event) },
        completedCommandIds: [...last.values()].filter(event => event.type === 'command_completed').map(event => event.commandId),
        onExecutionEvent: async event => {
          heartbeat.check()
          if (event.type !== 'command_dispatched') this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, { ...event, metadata: { ...event.metadata, operation: 'rollback', rollbackRevision } })
          if (event.type === 'command_prepared') this.tasks.markReverting(serverId, taskId)
          if (event.type !== 'execution_recovery') await remoteJournal?.append(event, { operation: 'rollback' })
          if (event.type === 'command_dispatched') this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, { ...event, metadata: { ...event.metadata, operation: 'rollback', rollbackRevision } })
        },
        requireRevert: false
      })
      const confirmed = [...last.values()].filter(event => event.type === 'command_completed').map(event => task.revertResults?.find(result => result.id === event.commandId && result.status === 'completed') ?? { id: event.commandId, status: 'completed', result: { exitCode: 0, stdout: '[completion confirmed by execution journal]', stderr: '' } })
      const combined = [...confirmed, ...results]
      const completion = { type: 'rollback_completed', metadata: { completed: combined.length === revertPlan.commands.length && combined.every(result => result.status === 'completed') } }
      this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, completion)
      await remoteJournal?.append(completion, { operation: 'rollback' })
      if (remoteJournal && !this.tasks.rollbackState(serverId, taskId).some(command => command.status === 'uncertain')) await remoteJournal.release()
      return combined
    } finally {
      heartbeat.stop()
      this.tasks.releaseExecution(serverId, taskId, lease.owner)
    }
  }

  createTask (serverId, request, options) {
    return this.tasks.create(serverId, request, options)
  }

  async reconcileTask ({ settings, passphrase, serverId, taskId, onProgress }) {
    const task = this.tasks.get(serverId, taskId)
    const lease = this.tasks.acquireExecution(serverId, taskId, task.plan)
    const heartbeat = startExecutionHeartbeat(this.tasks, serverId, taskId, lease.owner)
    try {
      const server = await this.serverSecrets({ settings, passphrase, serverId })
      const netdata = this.netdata(server)
      const rollbackPlans = [savedRevertPlan(task), ...this.tasks.revisions(serverId, taskId).filter(revision => revision.approved && revision.plan.operatorRollback).map(revision => revision.plan)]
      let remoteJournal
      for (const command of [...this.tasks.executionState(serverId, taskId), ...this.tasks.rollbackState(serverId, taskId)]) {
        heartbeat.check()
        if (command.status !== 'uncertain') continue
        this.tasks.renewExecution(serverId, taskId, lease.owner)
        const report = progress => {
          const state = progress.state === 'running' ? 'job_running' : progress.state
          const message = state === 'reconnecting' ? 'Reconnecting SSH to retrieve the recorded job result.' : state === 'reconnected' ? 'SSH reconnected. Checking the existing job.' : state === 'job_running' ? 'Job still running. Operator review needed before continuation.' : 'Operator review needed before continuation.'
          const metadata = { state, message, jobId: command.jobId, ...(command.rollbackRevision ? { operation: 'rollback', rollbackRevision: command.rollbackRevision } : {}) }
          this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, { type: 'execution_recovery', commandId: command.commandId, attemptId: command.attemptId, metadata })
          const event = { phase: 'execution-recovery', commandId: command.commandId, ...metadata }
          this.tasks.appendProgress(serverId, taskId, event)
          return onProgress?.(event)
        }
        let remote = { state: 'unknown', exitCode: null }
        let reconciliationError
        try { if (command.jobId && netdata.jobStatus) remote = await netdata.jobStatus(command.jobId, { onRecovery: report }) } catch (error) { reconciliationError = error; await report({ state: 'operator_review_required' }) }
        const prepared = this.tasks.allExecutionEvents(serverId, taskId).find(event => event.type === 'command_prepared' && event.commandId === command.commandId && event.attemptId === command.attemptId && (event.metadata.rollbackRevision ?? null) === (command.rollbackRevision ?? null))
        const commands = command.rollbackRevision ? rollbackPlans.find(plan => planFingerprint(plan) === command.rollbackRevision)?.commands : task.plan.commands
        const item = commands?.find(item => item.id === command.commandId)
        const after = await captureExecutionEvidence(netdata, { item, before: prepared?.metadata.evidenceBefore })
        const diagnostics = executionDiagnostics({ item, result: remote, error: reconciliationError, before: prepared?.metadata.evidenceBefore, after })
        if (diagnostics.length) {
          this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, { type: 'execution_recovery', commandId: command.commandId, attemptId: command.attemptId, metadata: { diagnostics, jobId: command.jobId, ...(after ? { evidenceAfter: after } : {}), ...(command.rollbackRevision ? { operation: 'rollback', rollbackRevision: command.rollbackRevision } : {}) } })
          const progress = { phase: 'execution-diagnostics', commandId: command.commandId, outcome: remote.state, message: diagnosticSummary(diagnostics), diagnostics }
          this.tasks.appendProgress(serverId, taskId, progress)
          await onProgress?.(progress)
        }
        if (reconciliationError) throw reconciliationError
        if (remote.state === 'running') await report(remote)
        if (remote.state === 'unknown') await report({ state: 'operator_review_required' })
        if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(remote.state)) continue
        const completed = remote.state === 'succeeded' && remote.exitCode === 0
        const completion = {
          type: completed ? 'command_completed' : 'command_failed',
          commandId: command.commandId,
          attemptId: command.attemptId,
          metadata: { jobId: command.jobId, state: remote.state, exitCode: remote.exitCode, reconciled: true, ...(diagnostics.length ? { diagnostics } : {}), ...(command.rollbackRevision ? { operation: 'rollback', rollbackRevision: command.rollbackRevision } : {}) }
        }
        this.tasks.appendExecutionEvent(serverId, taskId, lease.owner, completion)
        const result = { id: command.commandId, status: completed ? 'completed' : 'failed', result: { exitCode: remote.exitCode, stdout: '[remote output omitted during reconciliation]', stderr: '' }, ...(diagnostics.length ? { diagnostics } : {}) }
        if (command.rollbackRevision) this.tasks.appendRevertResult(serverId, taskId, result)
        else this.tasks.appendResult(serverId, taskId, result)
        remoteJournal = await this.remoteTaskJournal({ settings, serverId, taskId, server, task, plan: command.rollbackRevision ? { ...task.plan, revertCommands: commands } : task.plan })
        if (remoteJournal) {
          const baselineDigest = completed && !command.rollbackRevision && commonTaskRecoverySupported(task.catalogId, this.remoteRecovery.get(settings.servers?.[serverId]?.hostFingerprint, taskId)?.manifest.platform)
            ? await inspectRecoveryBaseline(netdata, task.catalogId, taskId, task.plan.compatibilityManifest?.host?.family).catch(() => null)
            : null
          await remoteJournal.append(completion, { operation: command.rollbackRevision ? 'rollback' : 'deployment', baselineDigest })
        }
      }
      if (remoteJournal && ![...this.tasks.executionState(serverId, taskId), ...this.tasks.rollbackState(serverId, taskId)].some(command => command.status === 'uncertain')) await remoteJournal.release()
      const state = this.tasks.executionState(serverId, taskId)
      if (task.status === 'running' && ![...state, ...this.tasks.rollbackState(serverId, taskId)].some(command => command.status === 'uncertain')) this.tasks.saveResults(serverId, taskId, this.tasks.get(serverId, taskId).results ?? [])
      return state
    } finally {
      heartbeat.stop()
      this.tasks.releaseExecution(serverId, taskId, lease.owner)
    }
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

  saveTaskPlan (serverId, taskId, plan, recovery) {
    if (recovery) {
      const manifest = commonTaskRecoveryManifest({ ...recovery, taskId, plan })
      this.remoteRecovery.register(manifest)
    }
    return this.tasks.savePlan(serverId, taskId, plan)
  }

  async remoteTaskJournal ({ settings, serverId, taskId, plan, server, task }) {
    const target = settings.servers?.[serverId]?.hostFingerprint
    if (!task?.catalogId || !target) return null
    const saved = this.remoteRecovery.get(target, taskId)
    if (!saved) return null
    await this.assertRecoveryHostIdentity(server, target)
    return new RemoteCommonTaskJournal({ transport: new RemoteRecoveryTransport({ client: this.netdata(server), platform: saved.manifest.platform }), state: this.remoteRecovery, target, taskId, plan })
  }

  async listRemoteCommonTasks ({ settings, passphrase, serverId, after = '' }) {
    const { transport, target } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    const key = await transport.key()
    if (!key) return { available: false, executions: [] }
    this.remoteRecovery.pin(target, key)
    return transport.list(after)
  }

  async inspectRemoteRecoveryKey ({ settings, passphrase, serverId }) {
    const { transport, target } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    const key = await transport.key()
    if (!key) throw new Error('No remote recovery signing key exists; inspection does not provision one')
    const known = this.remoteRecovery.currentKey(target)
    if (!known) this.remoteRecovery.pin(target, key)
    return { target, pinnedFingerprint: known?.fingerprint ?? key.fingerprint, publishedFingerprint: key.fingerprint, changed: !!known && known.fingerprint !== key.fingerprint, hasRotation: !!key.rotation }
  }

  async rotateRemoteRecoveryKey ({ settings, passphrase, serverId, expectedFingerprint, approved = false }) {
    if (approved !== true || !/^[a-f0-9]{64}$/u.test(expectedFingerprint)) throw new Error('Explicit recovery key rotation approval is required')
    const { transport, target } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    const key = await transport.key()
    if (!key || key.fingerprint !== expectedFingerprint) throw new Error('Recovery key changed after review')
    this.remoteRecovery.pin(target, key)
    const replacement = await transport.rotateKey(expectedFingerprint, target)
    this.remoteRecovery.acceptKeyRotation(target, replacement, expectedFingerprint)
    return { target, previousFingerprint: expectedFingerprint, fingerprint: replacement.fingerprint }
  }

  async acceptRemoteRecoveryKeyRotation ({ settings, passphrase, serverId, expectedFingerprint, publishedFingerprint, approved = false }) {
    if (approved !== true || !/^[a-f0-9]{64}$/u.test(expectedFingerprint) || !/^[a-f0-9]{64}$/u.test(publishedFingerprint)) throw new Error('Explicit recovery key transition approval is required')
    const { transport, target } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    const key = await transport.key()
    if (!key || key.fingerprint !== publishedFingerprint) throw new Error('Published recovery key changed after review')
    this.remoteRecovery.acceptKeyRotation(target, key, expectedFingerprint)
    return { target, previousFingerprint: expectedFingerprint, fingerprint: key.fingerprint }
  }

  async inspectRemoteCommonTask ({ settings, passphrase, serverId, executionId }) {
    const { transport, target } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    return retrieveRecoveryExecution({ transport, state: this.remoteRecovery, target, executionId })
  }

  async prepareRemoteCommonTaskRecovery ({ settings, passphrase, serverId, executionId, options }) {
    const { transport, target, client } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    const verified = await retrieveRecoveryExecution({ transport, state: this.remoteRecovery, target, executionId })
    const original = verified.records[0]
    if (!commonTaskRecoverySupported(original.catalogId, original.platform) || original.platform !== options.platform) throw new Error('Common-task baseline validation is not registered for this target and task family')
    if (verified.records.some(record => record.operation !== 'deployment')) throw new Error('Recovery or rollback has already started; inspect that operation instead of generating another cleanup')
    const baselineDigest = await inspectRecoveryBaseline(client, original.catalogId, original.taskId, options.linuxContext?.management?.family)
    const proposal = regenerateCommonTaskRecovery({ ...verified, options, baselineDigest })
    const task = this.createTask(serverId, `Reviewed remote common-task recovery: ${original.catalogId}, execution ${executionId}`)
    this.saveTaskPlan(serverId, task.id, proposal.plan)
    const manifest = Object.fromEntries(['executionId', 'target', 'identityMethod', 'platform', 'catalogId', 'taskId', 'catalogDigest', 'planDigest', 'rollbackDigest', 'revision', 'parentRevision'].map(field => [field, original[field]]))
    this.remoteRecovery.registerRecovery(task.id, manifest, { sequence: verified.sequence, head: verified.head, recoveryId: proposal.recoveryId, recoveryPlanDigest: planFingerprint(proposal.plan), baselineDigest })
    const ownership = await transport.ownership({ executionId, sequence: verified.sequence, head: verified.head })
    return { ...proposal, taskId: task.id, ownership }
  }

  async executeRemoteCommonTaskRecovery ({ settings, passphrase, serverId, taskId, options, approve, onResult, onProgress, takeoverFingerprint, takeoverApproved = false }) {
    if (takeoverFingerprint !== undefined && (takeoverApproved !== true || !/^[a-f0-9]{64}$/u.test(takeoverFingerprint))) throw new Error('Explicit ownership takeover approval is required')
    const { transport, target, client } = await this.remoteRecoveryConnection({ settings, passphrase, serverId })
    const saved = this.remoteRecovery.get(target, taskId)
    if (!saved?.manifest.recoveryId) throw new Error('No locally reviewed remote recovery proposal exists')
    const meta = saved.manifest
    if (saved.sequence !== meta.sourceSequence || saved.head !== meta.sourceHead) throw new Error('Recovery already started; inspect and reconcile before further changes')
    const verified = await retrieveRecoveryExecution({ transport, state: this.remoteRecovery, target, executionId: meta.executionId })
    if (verified.head !== meta.sourceHead) throw new Error('Remote recovery approval is stale')
    const baselineDigest = await inspectRecoveryBaseline(client, meta.catalogId, meta.taskId, options.linuxContext?.management?.family)
    const proposal = regenerateCommonTaskRecovery({ ...verified, options, baselineDigest, recoveryId: meta.recoveryId })
    const task = this.tasks.get(serverId, taskId)
    if (planFingerprint(proposal.plan) !== meta.recoveryPlanDigest || planFingerprint(task.plan) !== meta.recoveryPlanDigest) throw new Error('Recovery plan changed; fresh review is required')
    const journal = new RemoteCommonTaskJournal({ transport, state: this.remoteRecovery, target, taskId, plan: proposal.plan })
    const results = await this.execute({
      settings,
      passphrase,
      serverId,
      taskId,
      plan: proposal.plan,
      approve,
      onResult,
      onProgress,
      requireRevert: false,
      recoveryAuthorization: REMOTE_RECOVERY_EXECUTION,
      executionObserver: async event => {
        if (takeoverFingerprint && !journal.claimed) {
          const current = this.remoteRecovery.get(target, taskId)
          await transport.takeover({ executionId: meta.executionId, sequence: current.sequence, head: current.head, owner: current.owner, ownerFingerprint: takeoverFingerprint })
          journal.claimed = true
          await journal.append({ type: 'recovery_approved' }, { operation: 'recovery' })
        }
        return journal.append(event, { operation: 'recovery' })
      }
    })
    if (journal.claimed) await journal.append({ type: 'rollback_completed', metadata: { completed: results.length === proposal.plan.commands.length && results.every(result => result.status === 'completed') } }, { operation: 'recovery' })
    if (!this.tasks.executionState(serverId, taskId).some(command => command.status === 'uncertain')) await journal.release()
    return results
  }

  async remoteRecoveryConnection ({ settings, passphrase, serverId }) {
    const server = await this.serverSecrets({ settings, passphrase, serverId })
    const target = settings.servers?.[serverId]?.hostFingerprint
    if (!/^SHA256:[a-f0-9]{64}$/u.test(target)) throw new Error('Verified host identity is required for remote recovery')
    await this.assertRecoveryHostIdentity(server, target)
    const client = this.netdata(server)
    const health = await client.health()
    return { target, client, transport: new RemoteRecoveryTransport({ client, platform: health.platform }) }
  }

  async assertRecoveryHostIdentity (server, expected) {
    if (typeof this.ssh.hostFingerprint !== 'function' || await this.ssh.hostFingerprint(server.connectionUrl) !== expected) throw new Error('Current host identity does not match the recovery target')
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

function savedRevertPlan (task) {
  return { ...task.plan, summary: `Revert task ${task.id}: ${task.plan.summary}`, changeOverview: `Restore the state captured before task ${task.id}`, commands: task.plan.revertCommands, revertCommands: [] }
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
