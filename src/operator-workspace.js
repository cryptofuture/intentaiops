import { randomUUID } from 'node:crypto'
import { prepareTask } from './task-preparation.js'
import { planFingerprint } from './execution-journal.js'
import { commonTaskEligibility, listCommonTasks } from './common-tasks.js'
import { parallelMap } from './multi-host-service.js'
import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import { KubernetesClient } from './kubernetes-client.js'
import { KubernetesNetdataClient } from './kubernetes-netdata-client.js'
import { OperatorShells } from './operator-shells.js'

const actions = new Set(['prepare', 'execute', 'host-connect', 'host-disconnect', 'host-add', 'host-edit', 'host-remove', 'stage2-activate', 'stage2-update', 'stage2-deactivate', 'propose', 'refresh-catalog', 'approve', 'resume', 'rollback', 'reconcile', 'resolve', 'analyze', 'pause', 'abort', 'prepare-remote-recovery', 'execute-remote-recovery', 'run-resume', 'run-pause'])
export class OperatorWorkspace {
  constructor ({ controller, hosts, metrics }) {
    this.controller = controller; this.hosts = hosts; this.metrics = metrics; this.pending = new Map(); this.stopping = false
    this.shells = new OperatorShells({ hosts, settings: controller.settings })
    const lock = path.join(path.dirname(controller.databasePath), 'workspace-runtime.sqlite3')
    this.ownership = new Database(lock)
    chmodSync(lock, 0o600)
    try { this.ownership.exec('BEGIN IMMEDIATE') } catch { this.ownership.close(); throw new Error('A web workspace already owns this profile; use its launch URL or a separate --data-root') }
    controller.database(db => {
      db.exec('CREATE TABLE IF NOT EXISTS web_operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, created TEXT NOT NULL)')
      db.prepare("UPDATE web_operations SET status='interrupted',error='Server stopped observing this operation; inspect history before continuing' WHERE status='running'").run()
    })
  }

  operations () {
    return this.controller.database(db => db.prepare("SELECT id,status,result,error,created FROM web_operations ORDER BY (status='running') DESC,created DESC LIMIT 100").all().map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : null })))
  }

  operation (id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid operation identifier')
    const row = this.controller.database(db => db.prepare('SELECT id,status,result,error,created FROM web_operations WHERE id=?').get(id))
    if (!row) throw new Error('Unknown operation')
    return { ...row, result: row.result ? JSON.parse(row.result) : null }
  }

  submit (body) {
    if (this.stopping) throw new Error('Workspace is shutting down')
    if (!body || typeof body !== 'object' || Array.isArray(body) || !actions.has(body.action) || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/u.test(body.requestKey)) throw new Error('Invalid workspace operation')
    const allowed = ['action', 'requestKey', 'hostId', 'hostVersion', 'taskId', 'expectedVersion', 'fingerprint', 'approved', 'commandIds', 'commandId', 'status', 'evidence', 'rollbackRevision', 'serverIds', 'request', 'catalogId', 'consultation', 'retryOfTaskId', 'retryOfRunId', 'retryInstructions', 'instructions', 'revisionId', 'rollback', 'question', 'executionId', 'takeoverApproved', 'takeoverFingerprint', 'runId', 'decisions', 'concurrency', 'rollout', 'connection', 'temporary', 'authentication']
    if (Object.keys(body).some(key => !allowed.includes(key)) || Buffer.byteLength(JSON.stringify(body)) > 32768) throw new Error('Unsupported operation fields')
    for (const field of ['approved', 'consultation', 'rollback', 'takeoverApproved', 'temporary']) if (body[field] !== undefined && typeof body[field] !== 'boolean') throw new Error(`Invalid ${field}`)
    for (const field of ['request', 'instructions', 'question', 'retryInstructions', 'evidence']) if (body[field] !== undefined && body[field] !== null && (typeof body[field] !== 'string' || body[field].length > (field === 'evidence' ? 4096 : 8192))) throw new Error(`Invalid ${field}`)
    if (body.action === 'prepare' && (typeof body.request !== 'string' || !body.request.trim() || (!body.hostId && !body.serverIds))) throw new Error('Select hosts and provide a request')
    for (const field of ['fingerprint', 'hostVersion', 'takeoverFingerprint']) if (body[field] !== undefined && (typeof body[field] !== 'string' || !/^[a-f0-9]{64}$/u.test(body[field]))) throw new Error(`Invalid ${field}`)
    if (body.expectedVersion !== undefined && (typeof body.expectedVersion !== 'string' || body.expectedVersion.length > 256)) throw new Error('Invalid review version')
    if (body.commandIds !== undefined && (!Array.isArray(body.commandIds) || body.commandIds.length > 1024 || body.commandIds.some(id => typeof id !== 'string' || id.length > 128))) throw new Error('Invalid command selection')
    if (body.rollout !== undefined && (!body.rollout || typeof body.rollout !== 'object' || Array.isArray(body.rollout) || Object.keys(body.rollout).some(key => !['batchSize', 'canaryHost'].includes(key)))) throw new Error('Invalid rollout options')
    for (const key of ['hostId', 'catalogId']) if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== 'string' || !/^[a-z0-9_-]{1,128}$/u.test(body[key]))) throw new Error(`Invalid ${key}`)
    for (const key of ['taskId', 'runId', 'revisionId', 'retryOfTaskId', 'retryOfRunId']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) throw new Error(`Invalid ${key}`)
    if (body.serverIds !== undefined && (!Array.isArray(body.serverIds) || !body.serverIds.length || body.serverIds.length > 32 || new Set(body.serverIds).size !== body.serverIds.length || body.serverIds.some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/u.test(id)))) throw new Error('Select distinct configured hosts')
    if (['execute', 'resume', 'rollback', 'approve', 'resolve', 'execute-remote-recovery', 'run-resume', 'stage2-activate', 'stage2-update', 'stage2-deactivate', 'host-remove', 'host-edit'].includes(body.action) && body.approved !== true) throw new Error('Explicit approval required')
    const digest = planFingerprint(body)
    const result = this.controller.database(db => db.transaction(() => {
      const existing = db.prepare('SELECT id,digest,status FROM web_operations WHERE request_key=?').get(body.requestKey)
      if (existing) { if (existing.digest !== digest) throw new Error('Request key already used for different work'); return { id: existing.id, status: existing.status, existing: true } }
      if (this.pending.size >= 8 && !['pause', 'abort', 'run-pause'].includes(body.action)) throw new Error('Too many accepted operations; wait for active work to finish')
      const id = randomUUID()
      db.prepare("INSERT INTO web_operations VALUES(?,?,?,'running',NULL,NULL,?)").run(id, body.requestKey, digest, new Date().toISOString())
      return { id, status: 'running' }
    }).immediate())
    if (!result.existing) {
      const promise = Promise.resolve().then(() => this.perform(body)).then(value => this.finish(result.id, 'completed', value), error => this.finish(result.id, 'failed', null, error)).catch(() => {
        this.stopping = true
        this.notice = 'Local operation persistence failed. New work is blocked; inspect durable task/remote job state before continuation.'
        for (const { body } of this.pending.values()) {
          try { if (body.hostId && body.taskId) this.controller.control(body.hostId, body.taskId, 'pause', this.controller.tasks.stateVersion(body.hostId, body.taskId)); if (body.runId) this.controller.pauseRun(body.runId) } catch {}
        }
      }).finally(() => this.pending.delete(result.id))
      this.pending.set(result.id, { promise, body })
    }
    return result
  }

  finish (id, status, result, error) {
    const safe = this.controller.sanitize(result ?? null)
    if (safe && typeof safe === 'object') {
      for (const field of ['fingerprint', 'rollbackFingerprint', 'reviewedRollbackFingerprint']) if (/^[a-f0-9]{64}$/u.test(result[field] ?? '')) safe[field] = result[field]
      for (const field of ['stateVersion', 'expectedVersion']) if (/^[a-f0-9]{64}:\d+:\d+$/u.test(result[field] ?? '')) safe[field] = result[field]
      if (result.ownership && /^[a-f0-9]{64}$/u.test(result.ownership.ownerFingerprint ?? '')) safe.ownership.ownerFingerprint = result.ownership.ownerFingerprint
    }
    const message = error ? this.controller.sanitize(String(error.message)).slice(0, 4096) : null
    let payload = JSON.stringify(safe)
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) payload = JSON.stringify({ truncated: true, hostId: result?.hostId, taskId: result?.taskId ?? result?.task?.id, revisionId: result?.revisionId, message: 'Inspect persisted task/revision history; operation projection exceeds 2 MiB' })
    this.controller.database(db => db.prepare('UPDATE web_operations SET status=?,result=?,error=? WHERE id=?').run(status, payload, message, id))
    this.controller.record({ type: 'workspace_operation', operationId: id, status, message })
  }

  async prepare (body) {
    const c = this.controller
    const ids = body.serverIds ?? [body.hostId]
    ids.forEach(id => c.assertHost(id))
    const parent = body.retryOfRunId ? c.runs.get(body.retryOfRunId) : null
    if (parent && ids.some(id => !parent.hosts.some(host => host.serverId === id && host.status !== 'completed'))) throw new Error('Retry must select unfinished hosts from the original run')
    if (body.consultation && ids.length !== 1) throw new Error('Consultation requires one explicit host')
    const run = ids.length > 1 || parent ? c.runs.create({ request: body.request, kind: body.catalogId ? 'catalog' : 'ai', catalogId: body.catalogId ?? null, serverIds: ids, retryOfRunId: parent?.id ?? null, retryInstructions: body.retryInstructions }) : null
    const results = await parallelMap(ids, 4, async hostId => {
      try {
        const result = await c.withAdmin(hostId, admin => prepareTask({ admin, settings: c.settings, passphrase: c.passphrase, serverId: hostId, request: body.request, catalogId: body.catalogId, consultation: body.consultation, retryOfTaskId: parent?.hosts.find(h => h.serverId === hostId)?.taskId ?? body.retryOfTaskId, retryInstructions: body.retryInstructions, groupRunId: run?.id ?? null, onProgress: event => c.record({ ...event, hostId, runId: run?.id }) }))
        if (run) c.runs.updateHost(run.id, hostId, { taskId: result.taskId, status: 'planned' })
        return { hostId, taskId: result.taskId, awaitingReview: result.awaitingReview, consultation: result.consultation }
      } catch (error) { if (!run) throw error; c.runs.updateHost(run.id, hostId, { status: 'failed', error: 'Planning failed; inspect host history' }); return { hostId, error: 'Planning failed' } }
    })
    if (run) c.runs.updateRun(run.id, results.every(r => r.taskId) ? 'planned' : 'partial')
    return { runId: run?.id, results }
  }

  async perform (b) {
    const c = this.controller
    const args = [b.hostId, b.taskId, b.expectedVersion]
    if (b.action === 'prepare') return this.prepare(b)
    if (b.action === 'execute' || b.action === 'resume') return c.resume(...args, b.fingerprint, undefined, b.commandIds)
    if (b.action === 'pause' || b.action === 'abort') return c.control(b.hostId, b.taskId, b.action, b.expectedVersion)
    if (b.action === 'approve') return c.approve(b.hostId, b.taskId, b.revisionId, b.expectedVersion, b.fingerprint)
    if (b.action === 'propose') return c.propose(b.hostId, b.taskId, b.instructions, b.expectedVersion, b.rollback === true)
    if (b.action === 'refresh-catalog') return c.proposeCatalogRefresh(...args)
    if (b.action === 'rollback') return c.rollback(...args, b.fingerprint, b.revisionId)
    if (b.action === 'reconcile') return c.reconcile(...args)
    if (b.action === 'resolve') return c.resolve(...args, b.commandId, b.status, b.evidence, b.rollbackRevision)
    if (b.action === 'analyze') return c.analyze(b.hostId, b.taskId, b.question)
    if (b.action === 'prepare-remote-recovery') return { hostId: b.hostId, ...await c.prepareRemoteRecovery(b.hostId, b.executionId) }
    if (b.action === 'execute-remote-recovery') return c.executeRemoteRecovery(...args, b.fingerprint, b)
    if (b.action === 'run-pause') return c.pauseRun(b.runId, b.serverIds)
    if (b.action === 'run-resume') return this.resumeRun(b)
    if (['host-edit', 'host-remove', 'stage2-activate', 'stage2-update', 'stage2-deactivate'].includes(b.action)) {
      c.assertHost(b.hostId)
      if (b.hostVersion !== planFingerprint(c.settings.servers[b.hostId])) throw new Error('Host settings changed; review the current host before approval')
    }
    return this.hosts.action(b)
  }

  async resumeRun (body) {
    return this.controller.resumeRun(body.runId, body.decisions, { concurrency: body.concurrency ?? 4, rollout: body.rollout })
  }

  async catalog (hostId) {
    return this.controller.withAdmin(hostId, async admin => {
      const connection = { settings: this.controller.settings, passphrase: this.controller.passphrase, serverId: hostId }
      const capabilities = await admin.capabilities(connection)
      const inventory = await admin.refreshInventory(connection)
      const options = { platform: capabilities.platform.os, linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker, windowsExecution: inventory.webminaiExecution, freebsdExecution: inventory.webminaiExecution, macosExecution: inventory.webminaiExecution }
      return listCommonTasks(options).filter(task => task.category !== 'system').map(task => ({ id: task.id, label: task.label ?? task.title ?? task.id, ...commonTaskEligibility(task.id, options) }))
    })
  }

  async cluster (clusterId) {
    if (!Object.hasOwn(this.controller.settings.clusters ?? {}, clusterId)) throw new Error('Unknown cluster')
    const cluster = await this.hosts.settingsStore.decryptKubernetesCluster({ settings: this.controller.settings, passphrase: this.controller.passphrase, clusterId })
    const kubernetes = KubernetesClient.fromKubeconfigSource(cluster.kubeconfig)
    const [version, nodes] = await Promise.all([kubernetes.version(), kubernetes.nodes()])
    let health
    try { health = await new KubernetesNetdataClient({ kubernetes, actionKey: cluster.actionKey }).health() } catch {}
    return { clusterId, observedAt: new Date().toISOString(), source: 'Kubernetes API and signed gateway transport', version: version.gitVersion, nodeCount: nodes.items?.length ?? 0, nodes: (nodes.items ?? []).slice(0, 128).map(node => ({ uid: node.metadata?.uid, name: node.metadata?.name, ready: node.status?.conditions?.find(condition => condition.type === 'Ready')?.status ?? 'Unknown' })), stage2: health?.platform === 'kubernetes' ? 'active' : 'unavailable', pluginVersion: health?.version ?? null, metrics: 'Host CPU, memory and filesystem gauges do not describe cluster workloads' }
  }

  async close () {
    this.stopping = true
    await this.shells.close()
    for (const { body } of this.pending.values()) {
      if (body.hostId && body.taskId) {
        try { this.controller.control(body.hostId, body.taskId, 'pause', this.controller.tasks.stateVersion(body.hostId, body.taskId)) } catch {}
      }
      if (body.runId) { try { this.controller.pauseRun(body.runId) } catch {} }
    }
    await Promise.allSettled([...this.pending.values()].map(item => item.promise))
    await this.hosts?.close()
    this.metrics?.close()
    if (this.ownership.open) this.ownership.close()
  }
}
