import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { TaskStore } from './task-store.js'
import { SettingsStore } from './settings-store.js'
import { KubernetesClient } from './kubernetes-client.js'
import { KubernetesNetdataClient } from './kubernetes-netdata-client.js'
import { buildKubernetesApplicationPlan, inspectKubernetesApplicationReadiness, inspectKubernetesValidationJob } from './kubernetes-application-validation.js'
import { listKubernetesCommonTasks } from './kubernetes-common-task-catalog.js'
import { createKubernetesApiCommand, parseKubernetesApiCommand } from './netdata-client.js'
import { executeApprovedPlan, validateCommandPlan } from './plan-validator.js'
import { planFingerprint } from './execution-journal.js'
import { RemoteRecoveryState } from './remote-recovery-state.js'
import { RemoteRecoveryTransport } from './remote-recovery-transport.js'
import { RemoteCommonTaskJournal, retrieveRecoveryExecution } from './remote-common-task-recovery.js'
import { withHostMutation } from './host-mutation-ownership.js'
import { startExecutionHeartbeat } from './execution-heartbeat.js'
import { recordApplicationSecurity } from './software-security.js'

const policy = { maxCommands: 64, maxTimeoutMs: 1260000 }

export class KubernetesTaskService {
  constructor ({ dataRoot, settings, passphrase, settingsStore, onEvent = () => {}, openCluster }) {
    this.dataRoot = dataRoot
    this.settings = settings
    this.passphrase = passphrase
    this.settingsStore = settingsStore ?? new SettingsStore(dataRoot)
    this.tasks = new TaskStore(path.join(dataRoot, 'kubernetes-tasks'))
    this.remote = new RemoteRecoveryState(path.join(dataRoot, 'kubernetes-tasks'))
    this.onEvent = onEvent
    this.openCluster = openCluster
  }

  async connect (clusterId) {
    if (!Object.hasOwn(this.settings.clusters ?? {}, clusterId)) throw new Error('Unknown configured cluster')
    let connection
    if (this.openCluster) connection = await this.openCluster(clusterId)
    else {
      const cluster = await this.settingsStore.decryptKubernetesCluster({ settings: this.settings, passphrase: this.passphrase, clusterId })
      const kubernetes = KubernetesClient.fromKubeconfigSource(cluster.kubeconfig)
      const identity = await kubernetes.request('/api/v1/namespaces/kube-system')
      connection = { netdata: new KubernetesNetdataClient({ kubernetes, actionKey: cluster.actionKey }), uid: identity.metadata?.uid }
    }
    if (typeof connection.uid !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(connection.uid)) throw new Error('Verified cluster identity unavailable')
    const digest = createHash('sha256').update(connection.uid).digest('hex')
    return { ...connection, target: 'SHA256:' + digest, historyId: digest.slice(0, 63), transport: new RemoteRecoveryTransport({ client: connection.netdata, platform: 'kubernetes' }) }
  }

  async nodes (connection) {
    const value = await connection.netdata.kubernetesJson({ method: 'GET', path: '/api/v1/nodes' })
    const nodes = value.items?.filter(node => node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')).map(node => ({ name: node.metadata?.name, uid: node.metadata?.uid })).sort((a, b) => a.name.localeCompare(b.name))
    if (!nodes?.length || nodes.length > 16 || nodes.some(node => typeof node.uid !== 'string' || node.uid.length > 128)) throw new Error('A bounded verified set of ready nodes is required')
    return nodes
  }

  async assertPersistent (c) {
    if (this.openCluster) {
      if (c.persistent !== true) throw new Error('Persistent recovery volume is not verified')
      return
    }
    const kubernetes = c.netdata.kubernetes
    const [gateway, claim] = await Promise.all([
      kubernetes.request('/apis/apps/v1/namespaces/webminai-system/deployments/webminai-stage2'),
      kubernetes.request('/api/v1/namespaces/webminai-system/persistentvolumeclaims/webminai-recovery')
    ])
    const container = gateway.spec?.template?.spec?.containers?.find(container => container.name === 'netdata')
    const mount = container?.volumeMounts?.find(mount => mount.mountPath === '/var/lib/intentaiops' && !mount.subPath && !mount.readOnly)
    const volume = gateway.spec?.template?.spec?.volumes?.find(volume => volume.name === mount?.name)
    if (gateway.spec?.replicas !== 1 || gateway.spec?.strategy?.type !== 'Recreate' || volume?.persistentVolumeClaim?.claimName !== 'webminai-recovery' || volume.persistentVolumeClaim.readOnly || !container?.env?.some(value => value.name === 'WEBMINAI_RECOVERY_TARGET' && value.value === c.target) || claim.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'webminai' || claim.metadata?.annotations?.['webminai.io/recovery-target'] !== c.target || claim.metadata?.deletionTimestamp || claim.status?.phase !== 'Bound' || !claim.spec?.volumeName || !claim.metadata?.uid) throw new Error('Persistent recovery volume, target binding or single-writer deployment cannot be verified')
  }

  async persistentAvailable (clusterId) {
    try { await this.assertPersistent(await this.connect(clusterId)); return true } catch { return false }
  }

  build (catalogId, executionId, nodes, target) {
    const plan = buildKubernetesApplicationPlan({ catalogId, executionId, nodes: nodes.map(node => node.name) })
    plan.kubernetes.nodeIdentities = nodes
    plan.kubernetes.target = target
    return validateCommandPlan(plan, policy)
  }

  async resource (connection, resourcePath) {
    const result = await connection.netdata.runApiRequest({ method: 'GET', path: resourcePath, timeoutSeconds: 15 })
    let object
    try { object = JSON.parse(result.stdout) } catch { throw new Error('Resource observation unavailable; no mutation authorized') }
    if (result.exitCode !== 0 && object.kind === 'Status' && object.code === 404) return null
    if (result.exitCode !== 0 || result.recoveryRequired || typeof object.metadata?.uid !== 'string') throw new Error('Resource identity unavailable; no mutation authorized')
    return object
  }

  async prepare (clusterId, catalogId) {
    const c = await this.connect(clusterId)
    await this.assertPersistent(c)
    const health = await c.netdata.health()
    if (!health.recoveryConfigured || health.recoveryProtocolVersion !== 1 || !health.recoveryOpenSslAvailable) throw new Error('Persistent gateway recovery must be enabled before preparing recoverable cluster tasks')
    const nodes = await this.nodes(c)
    const executionId = randomBytes(16).toString('hex')
    const plan = this.build(catalogId, executionId, nodes, c.target)
    for (const command of plan.commands) {
      const request = parseKubernetesApiCommand(command.command)
      if (request.method === 'POST' && await this.resource(c, request.path + '/' + JSON.parse(request.body).metadata.name)) throw new Error('Existing resources require inspection; catalog tasks never adopt an existing installation')
    }
    const task = this.tasks.create(c.historyId, plan.summary, { kind: 'catalog', catalogId })
    this.tasks.savePlan(c.historyId, task.id, plan)
    this.remote.register({ executionId, target: c.target, identityMethod: 'kubernetes-cluster-uid-v1', platform: 'kubernetes', catalogId, taskId: task.id, catalogDigest: planFingerprint(plan), planDigest: planFingerprint(plan), rollbackDigest: planFingerprint(plan.revertCommands), revision: planFingerprint(plan) })
    this.onEvent({ type: 'cluster_task_prepared', clusterId, taskId: task.id })
    return this.view(c, clusterId, task.id)
  }

  view (c, clusterId, taskId) {
    const task = this.tasks.get(c.historyId, taskId)
    const commands = task.plan.commands.map(command => {
      const request = parseKubernetesApiCommand(command.command)
      const body = request.body ? JSON.parse(request.body) : null
      return { id: command.id, purpose: command.purpose, risk: command.risk, dependsOn: command.dependsOn ?? [], timeoutMs: command.timeoutMs, source: command.source, method: request.method, path: request.path, kind: body?.kind, name: body?.metadata?.name, images: body?.spec?.template?.spec?.containers?.map(container => container.image) ?? [], resourceUid: body?.preconditions?.uid }
    })
    return { clusterId, taskId, request: task.request, status: task.status, catalogId: task.catalogId, summary: task.plan.summary, warnings: task.plan.warnings, securityReport: task.progress?.findLast(event => event.type === 'security_report')?.report ?? null, commands, execution: this.tasks.executionState(c.historyId, taskId), control: this.tasks.control(c.historyId, taskId), expectedVersion: this.tasks.stateVersion(c.historyId, taskId), fingerprint: planFingerprint(task.plan), executionId: task.plan.kubernetes?.executionId, recovery: Boolean(task.plan.kubernetes?.recovery), takeoverRequired: Boolean(task.plan.kubernetes?.recovery?.ownerFingerprint), takeoverFingerprint: task.plan.kubernetes?.recovery?.ownerFingerprint ?? null }
  }

  async inspect (clusterId, taskId) { const c = await this.connect(clusterId); return this.view(c, clusterId, taskId) }
  async history (clusterId) { const c = await this.connect(clusterId); return this.tasks.list(c.historyId, { limit: 100 }).map(task => ({ id: task.id, request: task.request, status: task.status, catalogId: task.catalogId })) }
  catalog () { return listKubernetesCommonTasks().map(({ id, label }) => ({ id, label })) }

  assertReview (c, taskId, expectedVersion, fingerprint) {
    if (this.tasks.stateVersion(c.historyId, taskId) !== expectedVersion) throw new Error('Stale cluster review; refresh before approval')
    const task = this.tasks.get(c.historyId, taskId)
    if (task.plan.kubernetes?.target !== c.target || planFingerprint(task.plan) !== fingerprint) throw new Error('Approval does not match this cluster and saved plan')
    return task
  }

  async control (clusterId, taskId, expectedVersion, action) {
    if (!['pause', 'abort'].includes(action)) throw new Error('Unsupported cluster control')
    const c = await this.connect(clusterId)
    if (this.tasks.stateVersion(c.historyId, taskId) !== expectedVersion) throw new Error('Stale cluster decision')
    const current = this.tasks.control(c.historyId, taskId)
    this.tasks.setControl(c.historyId, taskId, action, current.version)
    this.onEvent({ type: 'cluster_' + action, clusterId, taskId })
    return this.view(c, clusterId, taskId)
  }

  receipts (c, taskId) {
    const receipts = new Map()
    for (const event of this.tasks.allExecutionEvents(c.historyId, taskId)) if (event.type === 'command_acknowledged' && event.metadata.resource) receipts.set(event.metadata.resource.path, event.metadata.resource)
    return receipts
  }

  async execute (clusterId, taskId, { expectedVersion, fingerprint, approved = false, takeoverApproved = false, takeoverFingerprint } = {}) {
    if (!approved) throw new Error('Explicit cluster plan approval is required')
    const c = await this.connect(clusterId)
    this.assertReview(c, taskId, expectedVersion, fingerprint)
    return withHostMutation({ dataRoot: this.dataRoot, identity: `kubernetes:${c.uid}` }, async () => {
      await this.assertPersistent(c)
      const task = this.assertReview(c, taskId, expectedVersion, fingerprint)
      if (task.status === 'completed') throw new Error('This cluster plan already completed; its approval is consumed')
      if (task.plan.kubernetes.recovery) return this.executeRecovery(c, clusterId, task, { takeoverApproved, takeoverFingerprint })
      const trusted = this.build(task.catalogId, task.plan.kubernetes.executionId, await this.nodes(c), c.target)
      if (planFingerprint(trusted) !== fingerprint) throw new Error('Catalog or node identities changed; prepare a new review')
      const state = this.tasks.executionState(c.historyId, taskId)
      if (state.some(command => command.status === 'uncertain')) throw new Error('Unknown mutation outcome requires operator reconciliation; no replay authorized')
      const lease = this.tasks.acquireExecution(c.historyId, taskId, task.plan)
      const heartbeat = startExecutionHeartbeat(this.tasks, c.historyId, taskId, lease.owner)
      const journal = new RemoteCommonTaskJournal({ transport: c.transport, state: this.remote, target: c.target, taskId, plan: task.plan })
      let unsafe = false
      const attempts = new Map()
      const event = async value => {
        if (value.commandId && value.attemptId) attempts.set(value.commandId, value.attemptId)
        this.tasks.appendExecutionEvent(c.historyId, taskId, lease.owner, value)
        if (value.type === 'command_prepared') this.tasks.markRunning(c.historyId, taskId)
        await journal.append(value)
        if (value.type === 'command_outcome_unknown') unsafe = true
        this.onEvent({ type: 'cluster_execution', clusterId, taskId, event: value.type, commandId: value.commandId })
      }
      try {
        const control = this.tasks.control(c.historyId, taskId)
        if (control.action === 'abort') throw new Error('Remaining cluster work was aborted; review recovery instead')
        this.tasks.setControl(c.historyId, taskId, 'run', control.version)
        const receipts = this.receipts(c, taskId)
        const results = await executeApprovedPlan({
          plan: task.plan,
          policy,
          approve: async () => true,
          completedCommandIds: state.filter(command => command.status === 'completed').map(command => command.commandId),
          beforeCommand: async item => {
            heartbeat.check()
            if (this.tasks.control(c.historyId, taskId).action !== 'run') return false
            const request = parseKubernetesApiCommand(item.command)
            if (request.method === 'POST' && await this.resource(c, request.path + '/' + JSON.parse(request.body).metadata.name)) throw new Error('Resource now exists; creation blocked before dispatch')
            return true
          },
          onExecutionEvent: event,
          onResult: result => this.tasks.appendResult(c.historyId, taskId, result),
          netdata: {
            runCommand: async command => {
              const request = parseKubernetesApiCommand(command)
              const item = task.plan.commands.find(item => item.command === command)
              if (request.method === 'POST') {
                const body = JSON.parse(request.body)
                const resourcePath = request.path + '/' + body.metadata.name
                const result = await c.netdata.runApiRequest({ ...request, timeoutSeconds: 30 })
                if (result.exitCode !== 0 || result.recoveryRequired) return { ...result, stdout: '', stderr: 'Kubernetes mutation was not confirmed; inspect recorded state' }
                const object = JSON.parse(result.stdout)
                if (!object.metadata?.uid || object.metadata.name !== body.metadata.name || object.metadata.namespace !== 'webminai-tasks') throw new Error('Creation identity was not confirmed')
                const resource = { path: resourcePath, uid: object.metadata.uid, definitionDigest: body.metadata.annotations['webminai.io/definition-sha256'] }
                await event({ type: 'command_acknowledged', commandId: item.id, attemptId: attempts.get(item.id), metadata: { resource } })
                receipts.set(resourcePath, resource)
                return { ...result, stdout: JSON.stringify({ kind: object.kind, metadata: { name: object.metadata.name, uid: object.metadata.uid } }), stderr: '' }
              }
              const receipt = receipts.get(request.path)
              if (!receipt) throw new Error('Confirmed resource UID is required before inspection')
              try {
                const shouldContinue = () => this.tasks.control(c.historyId, taskId).action === 'run'
                if (item.id === 'workload-ready') await inspectKubernetesApplicationReadiness(c.netdata, task.catalogId, receipt.uid, shouldContinue)
                else {
                  const source = task.plan.commands.map(item => parseKubernetesApiCommand(item.command)).find(request => request.method === 'POST' && request.path + '/' + JSON.parse(request.body).metadata.name === receipt.path)
                  await inspectKubernetesValidationJob(c.netdata, JSON.parse(source.body), receipt.uid, shouldContinue)
                }
                return { exitCode: 0, stdout: 'Confirmed expected resource UID and readiness', stderr: '' }
              } catch { return { exitCode: 1, stdout: '', stderr: 'Workload verification incomplete; resources remain and no mutation is replayed' } }
            }
          }
        })
        const all = [...(task.results ?? []), ...results]
        const saved = this.tasks.saveResults(c.historyId, taskId, all)
        if (saved.status === 'completed') {
          try { recordApplicationSecurity({ admin: { appendTaskProgress: (_host, id, event) => this.tasks.appendProgress(c.historyId, id, event) }, serverId: c.historyId, task: saved, results: all }) } catch {}
        }
        const controlAfter = this.tasks.control(c.historyId, taskId)
        if (controlAfter.action !== 'run') await event({ type: 'execution_paused', metadata: { action: controlAfter.action } })
      } catch (error) { unsafe = true; throw error } finally {
        heartbeat.stop()
        try { if (!unsafe) await journal.release() } finally { this.tasks.releaseExecution(c.historyId, taskId, lease.owner) }
      }
      return this.view(c, clusterId, taskId)
    })
  }

  async remoteHistory (clusterId) {
    const c = await this.connect(clusterId)
    await this.assertPersistent(c)
    const key = await c.transport.key()
    if (!key) return { available: false, executions: [] }
    this.remote.pin(c.target, key)
    return c.transport.list()
  }

  async recoveryEvidence (c, executionId) {
    await this.assertPersistent(c)
    const verified = await retrieveRecoveryExecution({ transport: c.transport, state: this.remote, target: c.target, executionId, timeoutMs: 60000 })
    const original = verified.records[0]
    if (original.platform !== 'kubernetes' || verified.records.some(record => record.version !== 2)) throw new Error('Only resource-bound signed Kubernetes records support verified recovery')
    const trusted = this.build(original.catalogId, executionId, await this.nodes(c), c.target)
    if (planFingerprint(trusted) !== original.catalogDigest || planFingerprint(trusted) !== original.planDigest || planFingerprint(trusted.revertCommands) !== original.rollbackDigest) throw new Error('Installed catalog or node identities cannot reproduce the original definition')
    const definitions = new Map(trusted.commands.map(command => {
      const request = parseKubernetesApiCommand(command.command)
      return [command.id, { command, request, body: request.body ? JSON.parse(request.body) : null }]
    }))
    const receipts = new Map()
    const preparedWrites = new Set()
    const currentAttempt = new Map()
    const acknowledged = new Set()
    const recoveryAttempts = new Set()
    for (const record of verified.records) {
      if (record.operation === 'recovery' && record.commandId) {
        const attempt = record.commandId + ':' + (record.attemptId ?? record.recordId)
        if (record.event === 'command_dispatched') recoveryAttempts.add(attempt)
        if (record.event === 'command_completed') recoveryAttempts.delete(attempt)
      }
      if (record.operation !== 'deployment' || !record.commandId) continue
      const definition = definitions.get(record.commandId)
      if (!definition || planFingerprint(definition.command) !== record.commandDigest || record.revision !== original.planDigest) throw new Error('Signed history does not match the trusted common task')
      if (definition.request.method !== 'POST') continue
      if (record.event === 'command_dispatched') currentAttempt.set(record.commandId, record.attemptId ?? record.recordId)
      const attempt = record.commandId + ':' + (record.attemptId ?? currentAttempt.get(record.commandId) ?? record.recordId)
      if (['command_dispatched', 'command_outcome_unknown'].includes(record.event) && !acknowledged.has(attempt)) preparedWrites.add(attempt)
      if (record.resource) {
        const resourcePath = definition.request.path + '/' + definition.body.metadata.name
        if (record.resource.path !== resourcePath || record.resource.definitionDigest !== definition.body.metadata.annotations['webminai.io/definition-sha256']) throw new Error('Signed resource binding does not match the catalog')
        receipts.set(resourcePath, { ...record.resource, body: definition.body })
        acknowledged.add(attempt)
        preparedWrites.delete(attempt)
      }
    }
    if (preparedWrites.size) throw new Error('A dispatched creation lacks authoritative resource identity; destructive recovery is blocked')
    const present = []
    for (const receipt of receipts.values()) {
      const object = await this.resource(c, receipt.path)
      if (!object) continue
      if (object.metadata.deletionTimestamp) throw new Error('An original deletion is still pending; observe it without another DELETE')
      if (object.metadata.uid !== receipt.uid || object.metadata.labels?.['webminai.io/execution-id'] !== executionId || object.metadata.annotations?.['webminai.io/definition-sha256'] !== receipt.definitionDigest || object.metadata.ownerReferences?.length || !matchesDesired(object.spec, receipt.body.spec)) throw new Error('Resource identity, ownership or configuration changed; destructive recovery is blocked')
      present.push(receipt)
    }
    if (present.length && recoveryAttempts.size) throw new Error('Interrupted recovery has an unresolved deletion attempt; inspect existing state without replay')
    return { ...verified, original, present }
  }

  async prepareRecovery (clusterId, executionId) {
    const c = await this.connect(clusterId)
    const evidence = await this.recoveryEvidence(c, executionId)
    if (!evidence.present.length) return { clusterId, alreadyAbsent: true, message: 'No signed original resources remain; no recovery mutation is needed' }
    const ownership = await c.transport.ownership({ executionId, sequence: evidence.sequence, head: evidence.head })
    const resources = evidence.present.sort((a, b) => removalOrder(a.path) - removalOrder(b.path) || a.path.localeCompare(b.path))
    const commands = resources.map((resource, index) => ({ id: 'recover-' + index, purpose: `Delete only original resource UID ${resource.uid} at ${resource.path}`, command: createKubernetesApiCommand({ method: 'DELETE', path: resource.path, body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', preconditions: { uid: resource.uid } } }), risk: 'destructive', timeoutMs: 300000, requiresSudo: false, dependsOn: index ? ['recover-' + (index - 1)] : [], source: { type: 'verified-application', id: evidence.original.catalogId, version: 1 } }))
    const plan = { summary: 'Recover ' + evidence.original.catalogId, changeOverview: 'Remove only signed original task-owned resource UIDs after fresh configuration and ownership checks', modifiedFiles: [], assumptions: ['No remote rollback script is executed'], warnings: ['Deleting the original PVC permanently removes task-created application data', 'Missing resources are excluded; uncertain creations and replacements block recovery'], requiresConfirmation: true, commands, revertCommands: [], kubernetes: { catalogId: evidence.original.catalogId, executionId, target: c.target, recovery: { sourceHead: evidence.head, sourceSequence: evidence.sequence, ownerFingerprint: ownership.ownerFingerprint, resources: resources.map(({ body, ...resource }) => resource) } } }
    validateCommandPlan(plan, policy, { requireRevert: false })
    const task = this.tasks.create(c.historyId, plan.summary, { kind: 'catalog', catalogId: evidence.original.catalogId })
    this.tasks.savePlan(c.historyId, task.id, plan)
    this.remote.registerRecovery(task.id, { ...evidence.original, executionId }, { sequence: evidence.sequence, head: evidence.head, recoveryId: executionId, recoveryPlanDigest: planFingerprint(plan), baselineDigest: planFingerprint(plan.kubernetes.recovery.resources) })
    this.onEvent({ type: 'cluster_recovery_prepared', clusterId, taskId: task.id })
    return { ...this.view(c, clusterId, task.id), takeoverRequired: ownership.owned, takeoverFingerprint: ownership.ownerFingerprint }
  }

  async executeRecovery (c, clusterId, task, { takeoverApproved = false, takeoverFingerprint } = {}) {
    const recovery = task.plan.kubernetes.recovery
    const evidence = await this.recoveryEvidence(c, task.plan.kubernetes.executionId)
    if (evidence.head !== recovery.sourceHead || evidence.sequence !== recovery.sourceSequence || planFingerprint(evidence.present.map(({ body, ...resource }) => resource).sort((a, b) => removalOrder(a.path) - removalOrder(b.path) || a.path.localeCompare(b.path))) !== planFingerprint(recovery.resources)) throw new Error('Remote record head or resources changed; prepare a fresh recovery review')
    const saved = this.remote.get(c.target, task.id)
    const ownership = await c.transport.ownership({ executionId: saved.manifest.executionId, sequence: saved.sequence, head: saved.head })
    if (ownership.owned) {
      if (!takeoverApproved || takeoverFingerprint !== recovery.ownerFingerprint || ownership.ownerFingerprint !== takeoverFingerprint) throw new Error('Explicit reviewed ownership takeover is required; no expired lease authorizes replay')
      await c.transport.takeover({ executionId: saved.manifest.executionId, sequence: saved.sequence, head: saved.head, owner: saved.owner, ownerFingerprint: takeoverFingerprint })
    }
    const lease = this.tasks.acquireExecution(c.historyId, task.id, task.plan)
    const heartbeat = startExecutionHeartbeat(this.tasks, c.historyId, task.id, lease.owner)
    const journal = new RemoteCommonTaskJournal({ transport: c.transport, state: this.remote, target: c.target, taskId: task.id, plan: task.plan })
    let unsafe = false
    const event = async value => {
      this.tasks.appendExecutionEvent(c.historyId, task.id, lease.owner, value)
      if (value.type === 'command_prepared') this.tasks.markRunning(c.historyId, task.id)
      await journal.append(value, { operation: 'recovery' })
      if (value.type === 'command_outcome_unknown') unsafe = true
      this.onEvent({ type: 'cluster_execution', clusterId, taskId: task.id, event: value.type, commandId: value.commandId })
    }
    try {
      const control = this.tasks.control(c.historyId, task.id)
      if (control.action === 'abort') throw new Error('Recovery was aborted; prepare a fresh remaining-work review')
      this.tasks.setControl(c.historyId, task.id, 'run', control.version)
      await event({ type: 'recovery_approved' })
      const results = await executeApprovedPlan({
        plan: task.plan,
        policy,
        requireRevert: false,
        approve: async () => true,
        beforeCommand: async () => { heartbeat.check(); return this.tasks.control(c.historyId, task.id).action === 'run' },
        onExecutionEvent: event,
        onResult: result => this.tasks.appendResult(c.historyId, task.id, result),
        netdata: {
          runCommand: async command => {
            const request = parseKubernetesApiCommand(command)
            const expected = recovery.resources.find(resource => resource.path === request.path)
            const object = await this.resource(c, request.path)
            if (!expected || !object || object.metadata.uid !== expected.uid || object.metadata.labels?.['webminai.io/execution-id'] !== task.plan.kubernetes.executionId) throw new Error('Recovery preconditions changed; original resource preserved')
            const result = await c.netdata.runApiRequest({ ...request, timeoutSeconds: 30 })
            if (result.recoveryRequired || result.exitCode !== 0) return { ...result, stdout: '', stderr: 'Deletion not confirmed; no replay authorized' }
            for (let attempt = 0; attempt < 240; attempt++) {
              const current = await this.resource(c, request.path)
              if (!current) return { exitCode: 0, stdout: 'Original resource UID is absent', stderr: '' }
              if (current.metadata.uid !== expected.uid) return { exitCode: 1, stdout: '', stderr: 'Replacement preserved; inspect current resource' }
              await new Promise(resolve => setTimeout(resolve, 500))
            }
            return { exitCode: 1, stdout: '', stderr: 'Deletion observation deadline exceeded; inspect existing deletion, never force-delete' }
          }
        }
      })
      this.tasks.saveResults(c.historyId, task.id, results)
    } catch (error) { unsafe = true; throw error } finally {
      heartbeat.stop()
      try { if (!unsafe) await journal.release() } finally { this.tasks.releaseExecution(c.historyId, task.id, lease.owner) }
    }
    return this.view(c, clusterId, task.id)
  }
}

function matchesDesired (actual, desired) {
  if (desired === null || typeof desired !== 'object') return actual === desired
  if (Array.isArray(desired)) return Array.isArray(actual) && actual.length === desired.length && desired.every((value, index) => matchesDesired(actual[index], value))
  return actual && typeof actual === 'object' && Object.entries(desired).every(([key, value]) => matchesDesired(actual[key], value))
}

function removalOrder (path) { return path.includes('/jobs/') ? 0 : path.includes('/deployments/') ? 1 : path.includes('/services/') ? 2 : 3 }
