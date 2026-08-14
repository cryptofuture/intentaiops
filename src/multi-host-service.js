import { buildCandidatePlanningContext, buildCommonTask, isApplicationCommonTask } from './common-tasks.js'
import { DeploymentScorecard } from './deployment-scorecard.js'
import { MultiHostRunStore } from './multi-host-run-store.js'

export class MultiHostService {
  /** @param {import('./public-api-contracts.js').MultiHostServiceOptions} options */
  constructor ({ dataRoot, adminFor, runs = new MultiHostRunStore(dataRoot), scorecard = new DeploymentScorecard(dataRoot), concurrency = 4 }) {
    if (typeof adminFor !== 'function') throw new TypeError('adminFor must be a function')
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new TypeError('concurrency must be between 1 and 32')
    this.adminFor = adminFor
    this.runs = runs
    this.scorecard = scorecard
    this.concurrency = concurrency
  }

  listRuns (options) {
    return this.runs.list(options)
  }

  getRun (runId) {
    return this.runs.get(runId)
  }

  /**
   * @param {import('./public-api-contracts.js').MultiHostRunOptions} options
   * @returns {Promise<import('./public-api-contracts.js').MultiHostRun>}
   */
  async run ({
    settings,
    passphrase,
    serverIds,
    request,
    kind = 'ai',
    catalogId = null,
    retryOfRunId = null,
    retryInstructions = null,
    planningHints = {},
    applicationDefaults = {},
    review = async () => true,
    externalVerify,
    onEvent = () => {}
  }) {
    const parent = retryOfRunId === null ? null : this.runs.get(retryOfRunId)
    if (parent && serverIds.some(serverId => !parent.hosts.some(host => host.serverId === serverId))) {
      throw new Error(`retry hosts must belong to multi-host run ${retryOfRunId}`)
    }
    const run = this.runs.create({ request, kind, catalogId, serverIds, retryOfRunId, retryInstructions })
    const prepared = await parallelMap(serverIds, this.concurrency, async serverId => {
      let admin
      let task
      try {
        onEvent({ type: 'planning', runId: run.id, serverId, message: 'Preparing command plan' })
        admin = await this.adminFor(serverId)
        const previousTaskId = parent?.hosts.find(host => host.serverId === serverId)?.taskId ?? null
        const previousAttempts = previousTaskId && kind === 'ai'
          ? admin.getTaskRetryHistory(serverId, previousTaskId)
          : []
        const consultationContext = kind !== 'ai'
          ? []
          : previousTaskId
            ? admin.getTaskConsultations(serverId, previousTaskId)
            : admin.listPendingConsultations(serverId)
        task = admin.createTask(serverId, request, {
          kind,
          catalogId,
          retryOfTaskId: previousTaskId,
          retryInstructions,
          groupRunId: run.id,
          consultationIds: consultationContext.map(item => item.id),
          consumeConsultations: previousTaskId === null
        })
        const planningHint = planningHints[serverId]
        if (planningHint?.routing) {
          admin.appendTaskProgress(serverId, task.id, {
            at: new Date().toISOString(),
            type: 'task_routing',
            message: `${planningHint.routing.decision}: ${planningHint.routing.rationale}`
          })
        }
        this.runs.updateHost(run.id, serverId, { taskId: task.id, status: 'planning', error: null })
        let catalogPlatform = 'linux'
        let catalogInventory = null
        if (kind === 'catalog') {
          catalogPlatform = (await admin.capabilities({ settings, passphrase, serverId })).platform.os
          if (isApplicationCommonTask(catalogId, catalogPlatform)) {
            catalogInventory = planningHint?.inventory ?? await admin.refreshInventory({ settings, passphrase, serverId })
          }
        }
        const plan = kind === 'catalog'
          ? buildCommonTask(catalogId, task.id, {
            platform: catalogPlatform,
            linuxContext: catalogInventory?.webminaiLinuxContext,
            windowsExecution: catalogInventory?.webminaiExecution,
            freebsdExecution: catalogInventory?.webminaiExecution,
            macosExecution: catalogInventory?.webminaiExecution,
            docker: catalogInventory?.webminaiDocker,
            applicationDefaults
          }).plan
          : await admin.plan({
            settings,
            passphrase,
            serverId,
            request,
            inventory: planningHint?.inventory,
            taskId: task.id,
            previousAttempts,
            retryInstructions,
            consultationContext,
            candidateContext: buildCandidatePlanningContext(planningHint?.routing?.relevantCatalogIds ?? [], task.id, {
              platform: planningHint?.inventory?.webminaiLinuxContext ? 'linux' : planningHint?.inventory?.webminaiExecution?.platform ?? catalogPlatform,
              freebsdExecution: planningHint?.inventory?.webminaiExecution,
              linuxContext: planningHint?.inventory?.webminaiLinuxContext,
              windowsExecution: planningHint?.inventory?.webminaiExecution,
              macosExecution: planningHint?.inventory?.webminaiExecution,
              docker: planningHint?.inventory?.webminaiDocker,
              foundationIds: planningHint?.routing?.foundationIds,
              foundationMode: planningHint?.routing?.foundationMode ?? 'context-only',
              applicationDefaults
            }),
            applicationDefaults,
            onProgress: event => {
              admin.appendTaskProgress(serverId, task.id, event)
              onEvent({ type: 'planner-progress', runId: run.id, serverId, taskId: task.id, event, message: event.message })
            }
          })
        admin.saveTaskPlan(serverId, task.id, plan)
        this.runs.updateHost(run.id, serverId, { status: 'planned' })
        onEvent({ type: 'planned', runId: run.id, serverId, taskId: task.id, plan, message: 'Plan ready' })
        return { serverId, admin, taskId: task.id, plan }
      } catch (error) {
        if (admin && task) admin.saveTaskError(serverId, task.id, error)
        this.runs.updateHost(run.id, serverId, { taskId: task?.id ?? null, status: 'failed', error: errorMessage(error) })
        onEvent({ type: 'failed', runId: run.id, serverId, taskId: task?.id ?? null, error, message: errorMessage(error) })
        return null
      }
    })
    const executable = prepared.filter(Boolean)
    if (executable.length === 0) {
      this.runs.updateRun(run.id, 'failed')
      return this.runs.get(run.id)
    }

    this.runs.updateRun(run.id, 'planned')
    if (!await review({ run: this.runs.get(run.id), hosts: executable })) {
      for (const host of executable) {
        host.admin.cancelTask(host.serverId, host.taskId)
        this.runs.updateHost(run.id, host.serverId, { status: 'cancelled' })
      }
      this.runs.updateRun(run.id, 'cancelled')
      return this.runs.get(run.id)
    }
    // Review hooks may normalize execution metadata (for example, opt a
    // long initialization phase into durable Netdata jobs). Persist the
    // reviewed plan before execution so retries and reverts use the same
    // approved graph.
    for (const host of executable) host.admin.saveTaskPlan(host.serverId, host.taskId, host.plan)

    // A planner may legitimately return an expected no-change compatibility
    // result (for example, a resource-gated Magento host). Treat an empty
    // graph as a completed, auditable child task instead of reporting a
    // controller execution failure or attempting external application checks.
    const noChange = executable.filter(host => host.plan.commands.length === 0 && host.plan.revertCommands.length === 0)
    for (const host of noChange) {
      host.admin.markTaskRunning(host.serverId, host.taskId)
      host.admin.saveTaskResults(host.serverId, host.taskId, [{
        id: 'no-change',
        status: 'completed',
        result: { status: 'completed', exitCode: 0, stdout: '', stderr: '', noChange: true }
      }])
      this.runs.updateHost(run.id, host.serverId, { status: 'completed', error: null, verification: { message: 'No changes required; compatibility gate completed safely.' } })
      onEvent({ type: 'completed', runId: run.id, serverId: host.serverId, taskId: host.taskId, message: 'No changes required' })
    }
    const runnable = executable.filter(host => !noChange.includes(host))

    this.runs.updateRun(run.id, 'running')
    await parallelMap(runnable, this.concurrency, async host => {
      const { admin, serverId, taskId, plan } = host
      try {
        this.runs.updateHost(run.id, serverId, { status: 'running', error: null })
        admin.markTaskRunning(serverId, taskId)
        onEvent({ type: 'running', runId: run.id, serverId, taskId, message: 'Executing approved plan' })
        const results = await admin.execute({
          settings,
          passphrase,
          serverId,
          plan,
          approve: async () => true,
          onResult: result => {
            admin.appendTaskResult(serverId, taskId, result)
            this.recordScorecard({ run, serverId, taskId, plan, result, operation: 'apply' })
            onEvent({ type: 'command-result', runId: run.id, serverId, taskId, result, message: `${result.id}: ${result.status}` })
          }
        })
        const task = admin.saveTaskResults(serverId, taskId, results)
        if (task.status !== 'completed') throw new Error('one or more approved commands did not complete')
        let verification = null
        if (externalVerify) {
          verification = await externalVerify({ serverId, taskId, plan, admin })
          onEvent({ type: 'verified', runId: run.id, serverId, taskId, verification, message: verification.message ?? 'External verification passed' })
        }
        this.runs.updateHost(run.id, serverId, { status: 'completed', error: null, verification })
        onEvent({ type: 'completed', runId: run.id, serverId, taskId, message: 'Task completed' })
      } catch (error) {
        admin.saveTaskError(serverId, taskId, error)
        this.runs.updateHost(run.id, serverId, { status: 'failed', error: errorMessage(error) })
        onEvent({ type: 'failed', runId: run.id, serverId, taskId, error, message: errorMessage(error) })
      }
    })
    return this.finishExecution(run.id)
  }

  async revert ({ settings, passphrase, runId, serverIds, review = async _details => true, externalVerify, onEvent = _event => {} }) {
    let run = this.runs.get(runId)
    const selected = serverIds ?? run.hosts.filter(host => host.taskId && !['reverted', 'cancelled'].includes(host.status)).map(host => host.serverId)
    const hosts = await parallelMap(selected, this.concurrency, async serverId => {
      try {
        const host = run.hosts.find(item => item.serverId === serverId)
        if (!host) throw new Error(`host ${serverId} is not part of multi-host run ${runId}`)
        if (!host.taskId) throw new Error(`host ${serverId} has no saved task to revert`)
        const value = await this.adminFor(serverId)
        const task = value.getTask(serverId, host.taskId)
        if (!task.plan?.revertCommands?.length) throw new Error(`task ${host.taskId} on ${serverId} has no revert plan`)
        return { serverId, taskId: host.taskId, admin: value, task }
      } catch (error) {
        this.runs.updateHost(runId, serverId, { status: 'revert_failed', error: errorMessage(error) })
        onEvent({ type: 'revert-failed', runId, serverId, error, message: errorMessage(error) })
        return null
      }
    })
    const ready = hosts.filter(Boolean)
    if (ready.length === 0) return this.finishRevert(runId)
    run = this.runs.get(runId)
    if (!await review({ run, hosts: ready.map(host => ({ ...host, plan: { ...host.task.plan, commands: host.task.plan.revertCommands, revertCommands: [] } })) })) return this.runs.get(runId)
    this.runs.updateRun(runId, 'reverting')
    await parallelMap(ready, this.concurrency, async host => {
      try {
        this.runs.updateHost(runId, host.serverId, { status: 'reverting', error: null })
        host.admin.markTaskReverting(host.serverId, host.taskId)
        onEvent({ type: 'reverting', runId, serverId: host.serverId, taskId: host.taskId, message: 'Executing saved revert plan' })
        const results = await host.admin.revertTask({
          settings,
          passphrase,
          serverId: host.serverId,
          taskId: host.taskId,
          approve: async () => true,
          onResult: result => {
            host.admin.appendTaskRevertResult(host.serverId, host.taskId, result)
            this.recordScorecard({ run, serverId: host.serverId, taskId: host.taskId, plan: host.task.plan, result, operation: 'revert' })
            onEvent({ type: 'revert-result', runId, serverId: host.serverId, taskId: host.taskId, result, message: `${result.id}: ${result.status}` })
          }
        })
        const task = host.admin.saveTaskRevertResults(host.serverId, host.taskId, results)
        if (task.status !== 'reverted') throw new Error('one or more revert commands did not complete')
        let verification = null
        if (externalVerify) verification = await externalVerify({ serverId: host.serverId, taskId: host.taskId, admin: host.admin })
        this.runs.updateHost(runId, host.serverId, { status: 'reverted', error: null, verification })
        onEvent({ type: 'reverted', runId, serverId: host.serverId, taskId: host.taskId, message: 'Revert completed' })
      } catch (error) {
        host.admin.saveTaskRevertError(host.serverId, host.taskId, error)
        this.runs.updateHost(runId, host.serverId, { status: 'revert_failed', error: errorMessage(error) })
        onEvent({ type: 'revert-failed', runId, serverId: host.serverId, taskId: host.taskId, error, message: errorMessage(error) })
      }
    })
    return this.finishRevert(runId)
  }

  finishExecution (runId) {
    const run = this.runs.get(runId)
    const completed = run.hosts.filter(host => host.status === 'completed').length
    const status = completed === run.hosts.length ? 'completed' : completed > 0 ? 'partial' : 'failed'
    return this.runs.updateRun(runId, status)
  }

  finishRevert (runId) {
    const run = this.runs.get(runId)
    const status = run.hosts.every(host => host.status === 'reverted')
      ? 'reverted'
      : run.hosts.some(host => host.status === 'revert_failed') ? 'revert_failed' : 'partial'
    return this.runs.updateRun(runId, status)
  }

  recordScorecard ({ run, serverId, taskId, plan, result, operation }) {
    const manifest = plan.compatibilityManifest
    this.scorecard.record({
      runId: run.id,
      taskId,
      serverId,
      applicationId: safeDimension(run.catalogId ?? 'ai-task'),
      stackId: safeDimension(manifest?.selectedRoute?.id ?? 'unclassified'),
      distroFamily: safeDimension(manifest?.host?.family ?? 'unknown'),
      phase: result.phase ?? (operation === 'revert' ? 'cleanup' : 'initialize'),
      outcome: result.status,
      durationMs: result.durationMs ?? 0,
      failureCode: result.failure?.code ?? null,
      firstPass: run.retryOfRunId === null,
      operation
    })
  }
}

export async function parallelMap (items, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive integer')
  }
  const results = new Array(items.length)
  let next = 0
  async function worker () {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

function errorMessage (error) {
  return String(error?.message ?? error)
}

function safeDimension (value) {
  const normalized = String(value).toLowerCase().replaceAll(/[^a-z0-9_-]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 63)
  return normalized || 'unknown'
}
