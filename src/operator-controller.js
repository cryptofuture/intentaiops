import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import { TaskStore } from './task-store.js'
import { MultiHostRunStore } from './multi-host-run-store.js'
import { planFingerprint } from './execution-journal.js'
import { sanitizePlannerData } from './codex-planner.js'
import { validateCommandPlan } from './plan-validator.js'
import { detectOperationLoop } from './operation-loop-detector.js'
import { buildCommonTask, commonTaskEligibility, listCommonTasks } from './common-tasks.js'
import { regenerateCatalogRevision } from './catalog-plan-revision.js'
import { completeTaskReport } from './task-completion-report.js'
import { withHostMutation } from './host-mutation-ownership.js'
import { isSystemUpdateTask } from './system-update-task.js'

export class OperatorController {
  constructor ({ dataRoot, settings, passphrase, adminFor, tasks, runs }) {
    this.settings = settings
    this.passphrase = passphrase
    this.adminFor = adminFor
    this.tasks = tasks ?? new TaskStore(dataRoot, { directoryAliases: new Map(Object.entries(settings.servers ?? {}).map(([id, host]) => [id, host.historyId ?? id])) })
    this.runs = runs ?? new MultiHostRunStore(dataRoot)
    this.databasePath = path.join(dataRoot, 'operator-events.sqlite3')
    this.database(database => database.exec(`
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (host_id TEXT PRIMARY KEY, event_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, host_id TEXT NOT NULL, task_id INTEGER NOT NULL, state_version TEXT NOT NULL, fingerprint TEXT NOT NULL, reviewed_at TEXT NOT NULL);
    `))
  }

  database (callback) {
    const database = new Database(this.databasePath)
    try {
      chmodSync(this.databasePath, 0o600)
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = FULL')
      database.pragma('busy_timeout = 5000')
      return callback(database)
    } finally { database.close() }
  }

  snapshot () {
    const runs = this.runs.list({ limit: 100 }).map(run => {
      const stage = this.database(database => database.prepare("SELECT payload FROM events WHERE json_extract(payload, '$.runId') = ? AND json_extract(payload, '$.type') IN ('rollout-stage', 'rollout-halted') ORDER BY id DESC LIMIT 1").get(run.id))
      const reviews = this.database(db => db.prepare('SELECT host_id AS hostId, task_id AS taskId, reviewed_at AS reviewedAt FROM run_reviews WHERE run_id=? ORDER BY id DESC LIMIT 128').all(run.id).map(review => ({ ...review, decision: 'explicitly approved selected continuation; not reusable authorization' })))
      return { ...run, reviews, rollout: stage ? JSON.parse(stage.payload) : null, pendingHosts: run.hosts.filter(host => !['completed', 'reverted'].includes(host.status)).length }
    })
    const snapshot = this.sanitize({ version: 1, hosts: Object.keys(this.settings.servers ?? {}).map(id => ({ id, tasks: this.tasks.list(id, { limit: 100 }) })), clusters: Object.keys(this.settings.clusters ?? {}).map(id => ({ id, desiredStage2: this.settings.clusters[id].desiredStage2 })), runs })
    for (const host of snapshot.hosts) host.hostVersion = planFingerprint(this.settings.servers[host.id])
    return snapshot
  }

  sanitize (value) {
    const cleaned = sanitizePlannerData(value)
    const visit = item => {
      if (Array.isArray(item)) return item.map(visit)
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !key.endsWith('Json')).map(([key, entry]) => [key, /^(?:stdout|stderr)$/iu.test(key) ? '[remote output withheld from public diagnostics]' : visit(entry)]))
      return typeof item === 'string' && this.passphrase ? item.split(this.passphrase).join('[redacted]') : item
    }
    return visit(cleaned)
  }

  inspect (hostId, taskId) {
    this.assertHost(hostId)
    const task = this.tasks.get(hostId, taskId)
    const revisions = this.tasks.revisions(hostId, taskId)
    task.executionDiagnostics = this.tasks.allExecutionEvents(hostId, taskId).filter(event => event.metadata.diagnostics?.length).map(event => ({ commandId: event.commandId, attemptId: event.attemptId, revision: event.revision, timestamp: event.timestamp, diagnostics: event.metadata.diagnostics }))
    const rollback = [...revisions].reverse().find(item => item.approved && item.plan.operatorRollback)
    const rollbackCommands = this.tasks.rollbackState(hostId, taskId).map(command => ({ ...this.sanitize(command), rollbackRevision: command.rollbackRevision }))
    const publicRevisions = revisions.map(revision => ({ ...this.sanitize(revision), fingerprint: planFingerprint(revision.plan), differences: planDifferences(task.plan, revision.plan) }))
    return { ...this.sanitize({ version: 1, hostId, task, control: this.tasks.control(hostId, taskId), commands: this.tasks.executionState(hostId, taskId), rollbackAvailable: Boolean(task.plan?.revertCommands?.length || rollback) }), revisions: publicRevisions, rollbackCommands, stateVersion: this.tasks.stateVersion(hostId, taskId), fingerprint: planFingerprint(task.plan), rollbackFingerprint: planFingerprint(task.plan?.revertCommands), reviewedRollbackFingerprint: rollback ? planFingerprint(rollback.plan) : null }
  }

  assertHost (hostId) {
    if (!Object.hasOwn(this.settings.servers ?? {}, hostId)) throw new Error('unknown configured host')
  }

  checkVersion (hostId, taskId, expectedVersion) {
    this.assertHost(hostId)
    if (typeof expectedVersion !== 'string' || expectedVersion !== this.tasks.stateVersion(hostId, taskId)) throw new Error('stale operator decision')
  }

  control (hostId, taskId, action, expectedVersion) {
    this.checkVersion(hostId, taskId, expectedVersion)
    const current = this.tasks.control(hostId, taskId)
    const result = this.tasks.setControl(hostId, taskId, action, current.version)
    this.record({ type: `operator_${action}`, hostId, taskId })
    return result
  }

  pauseRun (runId, serverIds) {
    const run = this.runs.get(runId)
    const selected = serverIds ?? run.hosts.map(host => host.serverId)
    if (selected.some(id => !run.hosts.some(host => host.serverId === id))) throw new Error('host is not in this run')
    if (!serverIds) this.runs.setControl(runId, 'pause', this.runs.control(runId).version)
    for (const host of run.hosts) if (host.taskId && selected.includes(host.serverId) && host.status !== 'completed') this.control(host.serverId, host.taskId, 'pause', this.tasks.stateVersion(host.serverId, host.taskId))
    return this.runs.get(runId)
  }

  async withAdmin (hostId, operation) {
    this.assertHost(hostId)
    if (!this.adminFor) throw new Error('operator actions are disabled')
    const opened = await this.adminFor(hostId)
    try { return await operation(opened.admin ?? opened) } finally { await opened.close?.() }
  }

  async withMutationAdmin (hostId, taskId, operation) {
    return this.withAdmin(hostId, admin => withHostMutation({ dataRoot: this.runs.dataRoot, identity: this.settings.servers[hostId].historyId ?? hostId }, () => operation(admin)))
  }

  async analyze (hostId, taskId, question) {
    if (typeof question !== 'string' || !question.trim() || question.length > 8192) throw new TypeError('question must contain 1-8192 characters')
    const evidence = this.inspect(hostId, taskId)
    return this.withAdmin(hostId, async admin => this.sanitize(await admin.consult({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, question: `${this.sanitize(question)}\nRecorded execution evidence:\n${JSON.stringify(evidence).slice(0, 64000)}` })))
  }

  async remoteCommonTasks (hostId, after = '') {
    return this.withAdmin(hostId, async admin => this.sanitize(await admin.listRemoteCommonTasks({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, after })))
  }

  async inspectRemoteCommonTask (hostId, executionId) {
    return this.withAdmin(hostId, async admin => this.sanitize(await admin.inspectRemoteCommonTask({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, executionId })))
  }

  async remoteRecoveryOptions (admin, hostId) {
    const connection = { settings: this.settings, passphrase: this.passphrase, serverId: hostId }
    const inventory = await admin.refreshInventory(connection)
    return { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker, applicationDefaults: await admin.settings.decryptApplicationDefaults(connection) }
  }

  async prepareRemoteRecovery (hostId, executionId) {
    return this.withAdmin(hostId, async admin => {
      const options = await this.remoteRecoveryOptions(admin, hostId)
      const proposal = await admin.prepareRemoteCommonTaskRecovery({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, executionId, options })
      this.record({ type: 'remote_recovery_proposed', hostId, taskId: proposal.taskId })
      return { ...this.sanitize(proposal), plan: proposal.plan, ownership: proposal.ownership, stateVersion: this.tasks.stateVersion(hostId, proposal.taskId), fingerprint: planFingerprint(proposal.plan) }
    })
  }

  async executeRemoteRecovery (hostId, taskId, expectedVersion, fingerprint, { approved = false, takeoverApproved = false, takeoverFingerprint } = {}) {
    if (approved !== true) throw new Error('Explicit recovery plan approval is required')
    this.checkVersion(hostId, taskId, expectedVersion)
    const task = this.tasks.get(hostId, taskId)
    if (planFingerprint(task.plan) !== fingerprint) throw new Error('Recovery approval fingerprint does not match the reviewed plan')
    return this.withMutationAdmin(hostId, taskId, async admin => {
      const options = await this.remoteRecoveryOptions(admin, hostId)
      this.checkVersion(hostId, taskId, expectedVersion)
      const results = await admin.executeRemoteCommonTaskRecovery({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, taskId, options, approve: async () => true, takeoverApproved, takeoverFingerprint, onResult: result => this.tasks.appendResult(hostId, taskId, result) })
      const saved = this.tasks.saveResults(hostId, taskId, results)
      this.record({ type: 'remote_recovery_finished', hostId, taskId, status: saved.status })
      return this.inspect(hostId, taskId)
    })
  }

  async propose (hostId, taskId, instructions, expectedVersion, rollback = false) {
    this.checkVersion(hostId, taskId, expectedVersion)
    if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 8192) throw new TypeError('revision instructions must contain 1-8192 characters')
    const evidence = this.inspect(hostId, taskId)
    if ([...evidence.commands, ...evidence.rollbackCommands].some(command => command.status === 'uncertain')) throw new Error('reconcile uncertain commands before replanning')
    return this.withAdmin(hostId, async admin => {
      const task = this.tasks.get(hostId, taskId)
      const completedIds = evidence.commands.filter(command => command.status === 'completed').map(command => command.commandId)
      const executedIds = new Set(evidence.commands.filter(command => command.status !== 'pending').map(command => command.commandId))
      this.record({ type: 'revision_planning', hostId, taskId })
      const replacement = await admin.plan({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, request: this.sanitize(task.request), taskId, catalogId: task.catalogId, requireRevert: !rollback, previousAttempts: [this.sanitize({ ...task, executionEvidence: evidence })], retryInstructions: `${this.sanitize(instructions)}\n${rollback ? 'Propose ONLY rollback commands as the forward commands, in rollback order. Revert only confirmed completed changes. Never include rollback for uncertain or failed commands without separately verified evidence.' : 'Generate only replacement UNEXECUTED work. Use new command IDs. Do not repeat completed changes. Preserve cumulative rollback coverage for original completed changes and replacement work.'} Completed IDs: ${completedIds.join(', ')}. Return self-contained dependencies.`, onProgress: event => this.record({ type: 'planner_progress', hostId, taskId, event }) })
      if (!replacement.commands.length) throw new Error('No executable replacement commands were proposed; original plan is unchanged')
      if (replacement.commands.some(command => executedIds.has(command.id))) throw new Error('replacement reuses an executed command ID')
      const completed = task.plan.commands.filter(command => completedIds.includes(command.id))
      const plan = { ...replacement, commands: rollback ? replacement.commands : [...completed, ...replacement.commands], operatorRollback: rollback }
      const rules = await admin.workspace.loadRules(hostId)
      validateCommandPlan(plan, rules.policy, { requireRevert: !rollback })
      this.checkVersion(hostId, taskId, expectedVersion)
      const revisionId = this.tasks.proposeRevision(hostId, taskId, plan, expectedVersion)
      this.record({ type: 'revision_proposed', hostId, taskId, revisionId })
      return { version: 1, revisionId, expectedVersion, fingerprint: planFingerprint(plan), original: this.sanitize(task.plan), proposed: this.sanitize(plan), differences: planDifferences(task.plan, plan) }
    })
  }

  async proposeCatalogRefresh (hostId, taskId, expectedVersion) {
    this.checkVersion(hostId, taskId, expectedVersion)
    const task = this.tasks.get(hostId, taskId)
    const definition = listCommonTasks({ category: 'application' }).find(definition => definition.id === task.catalogId && (!definition.prerequisite || definition.id === 'podman-freebsd') && ['linux', 'freebsd'].includes(definition.platform))
    if (task.kind !== 'catalog' || !definition) throw new Error('Catalog refresh requires a native Linux or FreeBSD application task')
    if (!this.tasks.executionEvents(hostId, taskId).length && (task.results?.length || task.status !== 'planned')) throw new Error('Legacy execution has no journal; operator investigation required')
    if (task.revertResults?.length || this.tasks.rollbackState(hostId, taskId).some(command => command.status !== 'pending')) throw new Error('Rollback has started; do not refresh deployment work')
    const execution = this.tasks.executionState(hostId, taskId)
    if (execution.some(command => command.status === 'uncertain')) throw new Error('Reconcile uncertain commands before refreshing catalog work')
    return this.withAdmin(hostId, async admin => {
      const inventory = await admin.refreshInventory({ settings: this.settings, passphrase: this.passphrase, serverId: hostId })
      this.checkVersion(hostId, taskId, expectedVersion)
      if (definition.platform === 'linux' && (!inventory.webminaiLinuxContext || inventory.webminaiDocker?.preferred)) throw new Error('Catalog refresh currently requires a native Linux route')
      if (definition.platform === 'freebsd' && inventory.webminaiExecution?.platform !== 'freebsd') throw new Error('Catalog refresh requires a verified FreeBSD execution target')
      const applicationDefaults = await admin.settings.decryptApplicationDefaults({ settings: this.settings, passphrase: this.passphrase })
      const options = { platform: definition.platform, linuxContext: inventory.webminaiLinuxContext, freebsdExecution: inventory.webminaiExecution, docker: inventory.webminaiDocker, applicationDefaults }
      const eligibility = commonTaskEligibility(task.catalogId, options)
      if (!eligibility.eligible) throw new Error(`Catalog task is no longer eligible: ${eligibility.reason}`)
      const plan = regenerateCatalogRevision(task, execution, buildCommonTask(task.catalogId, task.id, options).plan)
      const rules = await admin.workspace.loadRules(hostId)
      validateCommandPlan(plan, rules.policy)
      this.checkVersion(hostId, taskId, expectedVersion)
      const revisionId = this.tasks.proposeRevision(hostId, taskId, plan, expectedVersion)
      this.record({ type: 'catalog_revision_proposed', hostId, taskId, revisionId })
      return { version: 1, revisionId, expectedVersion, fingerprint: planFingerprint(plan), differences: planDifferences(task.plan, plan) }
    })
  }

  approve (hostId, taskId, revisionId, expectedVersion, fingerprint) {
    this.checkVersion(hostId, taskId, expectedVersion)
    const revision = this.tasks.revisions(hostId, taskId).find(item => item.id === revisionId)
    if (revision && !revision.plan.commands.length) throw new Error('No executable replacement commands were proposed; original plan is unchanged')
    const result = this.tasks.approveRevision(hostId, taskId, revisionId, expectedVersion, fingerprint)
    this.record({ type: 'revision_approved', hostId, taskId, revisionId })
    return this.sanitize(result)
  }

  async resume (hostId, taskId, expectedVersion, fingerprint, onProgress, commandIds) {
    this.checkVersion(hostId, taskId, expectedVersion)
    const task = this.tasks.get(hostId, taskId)
    if (task.status === 'completed') throw new Error('This plan already completed; its execution approval is consumed')
    if (task.status === 'reverted') throw new Error('rollback has started or completed; prepare a new task instead of reusing this execution approval')
    if (!task.plan || planFingerprint(task.plan) !== fingerprint) throw new Error('explicit plan approval fingerprint required')
    if (commandIds !== undefined && (!Array.isArray(commandIds) || !commandIds.length || new Set(commandIds).size !== commandIds.length || commandIds.some(id => !task.plan.commands.some(command => command.id === id)))) throw new Error('Invalid per-command review')
    if (['running', 'reverting', 'partial', 'failed'].includes(task.status) && !this.tasks.executionEvents(hostId, taskId).length) throw new Error('legacy interrupted execution has no journal; operator investigation required')
    const originalControl = this.tasks.control(hostId, taskId)
    return this.withMutationAdmin(hostId, taskId, async admin => {
      this.checkVersion(hostId, taskId, expectedVersion)
      await admin.reconcileTask({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, taskId, onProgress })
      const state = this.tasks.executionState(hostId, taskId)
      if (state.some(command => ['uncertain', 'failed'].includes(command.status))) throw new Error('reconciliation or reviewed revision required')
      const completedIds = new Set(state.filter(command => command.status === 'completed').map(command => command.commandId))
      const remainingChanges = task.plan.commands.some(command => !completedIds.has(command.id) && command.risk !== 'read')
      const oneWayMaintenance = task.kind === 'catalog' && isSystemUpdateTask(task.catalogId)
      const control = this.tasks.control(hostId, taskId)
      if (control.action === 'abort') throw new Error('execution was aborted; request a reviewed revision')
      this.tasks.setControl(hostId, taskId, 'run', originalControl.version)
      const results = await admin.execute({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, taskId, plan: task.plan, requireRevert: remainingChanges && !oneWayMaintenance, approve: async command => !commandIds || commandIds.includes(command.id), onProgress, executionObserver: event => { if (event.type === 'command_prepared') this.tasks.markRunning(hostId, taskId) }, onResult: result => this.tasks.appendResult(hostId, taskId, result) })
      const saved = this.tasks.saveResults(hostId, taskId, results)
      if (saved.status === 'completed') {
        try { await completeTaskReport({ admin, settings: this.settings, passphrase: this.passphrase, serverId: hostId, task: this.tasks.get(hostId, taskId), onProgress }) } catch { this.record({ type: 'report_unavailable', hostId, taskId, message: 'Assessment unavailable; authoritative command outcomes remain recorded' }) }
      }
      if (task.groupRunId) this.runs.updateHost(task.groupRunId, hostId, { status: saved.status })
      if (task.groupRunId) {
        const run = this.runs.get(task.groupRunId)
        this.runs.updateRun(run.id, run.hosts.every(host => host.status === 'completed') ? 'completed' : 'partial')
      }
      this.record({ type: 'execution_finished', hostId, taskId, status: saved.status })
      return this.inspect(hostId, taskId)
    })
  }

  async run (options) {
    const { MultiHostService } = await import('./multi-host-service.js')
    const service = new MultiHostService({ dataRoot: this.runs.dataRoot, runs: this.runs, adminFor: this.adminFor, concurrency: options.concurrency ?? 4 })
    return service.run({ ...options, settings: this.settings, passphrase: this.passphrase })
  }

  async resumeRun (runId, decisions, options = {}) {
    const body = { ...options, runId, decisions }
    return withHostMutation({ dataRoot: this.runs.dataRoot, identity: `run:${runId}` }, async () => {
      const c = this
      const { parallelMap } = await import('./multi-host-service.js')
      const run = c.runs.get(body.runId)
      if (!Array.isArray(body.decisions) || !body.decisions.length || body.decisions.length > 32 || new Set(body.decisions.map(d => d.hostId)).size !== body.decisions.length) throw new Error('Explicit per-host decisions required')
      for (const d of body.decisions) {
        const host = run.hosts.find(h => h.serverId === d.hostId && h.taskId === d.taskId)
        if (!host) throw new Error('Wrong run or host')
        if (host.status !== 'completed') { c.checkVersion(d.hostId, d.taskId, d.expectedVersion); if (c.inspect(d.hostId, d.taskId).fingerprint !== d.fingerprint) throw new Error('Wrong plan fingerprint') }
      }
      const concurrency = body.concurrency ?? 1
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid concurrency')
      const batchSize = body.rollout?.batchSize ?? concurrency
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new Error('Invalid rollout batch')
      const pending = body.decisions.filter(d => run.hosts.find(h => h.serverId === d.hostId).status !== 'completed')
      if (body.rollout?.canaryHost) {
        const index = pending.findIndex(decision => decision.hostId === body.rollout.canaryHost)
        if (index < 0) throw new Error('Canary must be an explicitly reviewed selected host')
        pending.unshift(...pending.splice(index, 1))
      }
      c.database(db => db.transaction(() => {
        const insert = db.prepare('INSERT INTO run_reviews(run_id,host_id,task_id,state_version,fingerprint,reviewed_at) VALUES(?,?,?,?,?,?)')
        for (const decision of pending) insert.run(run.id, decision.hostId, decision.taskId, decision.expectedVersion, decision.fingerprint, new Date().toISOString())
      }).immediate())
      const control = c.runs.control(run.id)
      c.runs.setControl(run.id, 'run', control.version)
      const stages = body.rollout ? [pending.slice(0, 1), ...Array.from({ length: Math.ceil(Math.max(0, pending.length - 1) / batchSize) }, (_, i) => pending.slice(1 + i * batchSize, 1 + (i + 1) * batchSize))] : [pending]
      for (const [index, stage] of stages.entries()) {
        if (c.runs.control(run.id).action === 'pause') break
        c.record({ type: 'rollout-stage', runId: run.id, stage: index + 1, pendingHosts: pending.length })
        const result = await parallelMap(stage, concurrency, async d => {
          try { await c.resume(d.hostId, d.taskId, d.expectedVersion, d.fingerprint); return c.inspect(d.hostId, d.taskId).task.status === 'completed' } catch {
            c.record({ type: 'host-continuation-blocked', runId: run.id, hostId: d.hostId, taskId: d.taskId, message: 'Continuation blocked; inspect task state and review again' })
            return false
          }
        })
        const verified = !body.rollout || stage.every(d => {
          const task = c.tasks.get(d.hostId, d.taskId)
          const checks = task.plan.commands.filter(command => command.phase === 'verify')
          return checks.length && checks.every(check => task.results?.some(result => result.id === check.id && result.status === 'completed' && result.result?.exitCode === 0))
        })
        if (result.some(ok => !ok) || !verified) { c.record({ type: 'rollout-halted', runId: run.id, stage: index + 1, message: 'Failure, incomplete work or missing approved verification; remaining hosts require review' }); break }
      }
      return c.runs.get(run.id)
    })
  }

  async rollback (hostId, taskId, expectedVersion, fingerprint, revisionId) {
    this.checkVersion(hostId, taskId, expectedVersion)
    const task = this.tasks.get(hostId, taskId)
    const revision = revisionId ? this.tasks.revisions(hostId, taskId).find(revision => revision.id === revisionId && revision.approved && revision.plan.operatorRollback) : null
    if (planFingerprint(revision ? revision.plan : task.plan?.revertCommands) !== fingerprint) throw new Error('explicit rollback approval fingerprint required')
    return this.withMutationAdmin(hostId, taskId, async admin => {
      this.checkVersion(hostId, taskId, expectedVersion)
      const results = await admin.revertTask({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, taskId, reviewedPlan: revision?.plan, approve: async () => true, onResult: result => this.tasks.appendRevertResult(hostId, taskId, result) })
      const saved = this.tasks.saveRevertResults(hostId, taskId, results)
      if (task.groupRunId) {
        this.runs.updateHost(task.groupRunId, hostId, { status: saved.status, error: saved.status === 'reverted' ? null : 'One or more rollback commands did not complete' })
        const run = this.runs.get(task.groupRunId)
        this.runs.updateRun(run.id, run.hosts.every(host => host.status === 'reverted') ? 'reverted' : run.hosts.some(host => host.status === 'revert_failed') ? 'revert_failed' : 'partial')
      }
      this.record({ type: 'rollback_finished', hostId, taskId })
      return this.inspect(hostId, taskId)
    })
  }

  async reconcile (hostId, taskId, expectedVersion, onProgress) {
    this.checkVersion(hostId, taskId, expectedVersion)
    return this.withAdmin(hostId, async admin => {
      this.checkVersion(hostId, taskId, expectedVersion)
      await admin.reconcileTask({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, taskId, onProgress })
      return this.inspect(hostId, taskId)
    })
  }

  resolve (hostId, taskId, expectedVersion, commandId, status, evidence, rollbackRevision) {
    this.checkVersion(hostId, taskId, expectedVersion)
    if (!['completed', 'failed'].includes(status) || typeof evidence !== 'string' || evidence.trim().length < 10 || evidence.length > 4096) throw new Error('reviewed remote evidence and completed/failed outcome required')
    const states = rollbackRevision ? this.tasks.rollbackState(hostId, taskId) : this.tasks.executionState(hostId, taskId)
    const command = states.find(item => item.commandId === commandId && (!rollbackRevision || item.rollbackRevision === rollbackRevision))
    if (!command || command.status !== 'uncertain') throw new Error('only uncertain outcomes can be reconciled by the operator')
    const task = this.tasks.get(hostId, taskId)
    const lease = this.tasks.acquireExecution(hostId, taskId, task.plan)
    try {
      this.checkVersion(hostId, taskId, expectedVersion)
      this.tasks.appendExecutionEvent(hostId, taskId, lease.owner, { type: status === 'completed' ? 'command_completed' : 'command_failed', commandId, attemptId: command.attemptId, metadata: { reconciled: true, operatorReviewed: true, evidence: '[operator attestation recorded; raw evidence withheld]', evidenceFingerprint: planFingerprint(this.sanitize(evidence)), ...(rollbackRevision ? { operation: 'rollback', rollbackRevision } : {}) } })
      if (!rollbackRevision && task.status === 'running' && !this.tasks.executionState(hostId, taskId).some(command => command.status === 'uncertain')) this.tasks.saveResults(hostId, taskId, task.results ?? [])
    } finally { this.tasks.releaseExecution(hostId, taskId, lease.owner) }
    return this.inspect(hostId, taskId)
  }

  record (event, source = null, database = null) {
    const hostId = event.hostId ?? event.serverId
    const runId = event.runId !== undefined ? event.runId : (hostId && event.taskId ? this.tasks.get(hostId, event.taskId).groupRunId : null)
    const payload = JSON.stringify(this.sanitize({ version: 1, timestamp: new Date().toISOString(), ...event, hostId, runId }))
    if (Buffer.byteLength(payload) >= 128 * 1024) throw new Error('event exceeds size limit')
    const write = database => database.prepare('INSERT OR IGNORE INTO events (source, payload) VALUES (?, ?)').run(source, payload)
    if (database) write(database)
    else this.database(write)
  }

  events (after = 0, limit = 500) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('invalid event range')
    for (const hostId of Object.keys(this.settings.servers ?? {})) {
      const cursor = this.database(database => database.prepare('SELECT event_id FROM cursors WHERE host_id = ?').get(hostId)?.event_id ?? 0)
      const rows = this.tasks.hostExecutionEvents(hostId, { after: cursor })
      if (rows.length) {
        this.database(database => database.transaction(() => {
          for (const event of rows) this.record(event, `${hostId}:${event.id}`, database)
          database.prepare('INSERT INTO cursors VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET event_id = max(cursors.event_id, excluded.event_id)').run(hostId, rows.at(-1).id)
        }).immediate())
      }
    }
    return this.database(database => database.prepare('SELECT id, payload FROM events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit).map(row => ({ ...JSON.parse(row.payload), id: row.id })))
  }

  exportRun (runId) {
    const run = this.runs.get(runId)
    const hosts = run.hosts.filter(host => host.taskId).map(host => this.inspect(host.serverId, host.taskId))
    const events = run.hosts.filter(host => host.taskId).flatMap(host => this.tasks.allExecutionEvents(host.serverId, host.taskId)).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id - b.id)
    const operatorEvents = this.database(database => database.prepare("SELECT id, payload FROM events WHERE source IS NULL AND json_extract(payload, '$.runId') = ? ORDER BY id").all(runId).map(row => ({ ...JSON.parse(row.payload), id: row.id, source: 'operator' })))
    events.push(...operatorEvents)
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id - b.id)
    const bundle = this.sanitize({ format: 'intentaiops-diagnostics', version: 1, replayOnly: true, run, hosts, events })
    if (Buffer.byteLength(JSON.stringify(bundle)) > 2 * 1024 * 1024) throw new Error('diagnostic bundle exceeds 2 MiB; narrow the run')
    return bundle
  }

  loop (hostId, taskId, options) {
    return this.withAdmin(hostId, admin => detectOperationLoop(admin.getTaskRetryHistory(hostId, taskId), options))
  }
}

export function planDifferences (before, after) {
  const previous = new Map(before.commands.map(command => [command.id, command]))
  const next = new Map(after.commands.map(command => [command.id, command]))
  return { added: [...next.keys()].filter(id => !previous.has(id)), removed: [...previous.keys()].filter(id => !next.has(id)), changed: [...next.keys()].filter(id => previous.has(id) && planFingerprint(previous.get(id)) !== planFingerprint(next.get(id))) }
}
