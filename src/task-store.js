import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EXECUTION_EVENTS, journalMetadata, planFingerprint } from './execution-journal.js'
import { resolveServerDirectory } from './server-id.js'

const DATABASE_FILE = 'tasks.sqlite3'
const KINDS = new Set(['ai', 'catalog', 'consultation'])
const STATUSES = new Set([
  'planning',
  'consulted',
  'planned',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'reverting',
  'reverted',
  'revert_failed'
])

export class TaskStore {
  constructor (dataRoot, { directoryAliases = new Map() } = {}) {
    this.dataRoot = path.resolve(dataRoot)
    this.directoryAliases = directoryAliases
  }

  create (serverId, request, {
    kind = 'ai',
    catalogId = null,
    retryOfTaskId = null,
    retryInstructions = null,
    groupRunId = null,
    consultationIds = [],
    consumeConsultations = true
  } = {}) {
    if (typeof request !== 'string' || !request.trim() || request.length > 128 * 1024) {
      throw new TypeError('task request must be non-empty and no larger than 128 KiB')
    }
    if (!KINDS.has(kind)) throw new TypeError('task kind must be ai, catalog, or consultation')
    if (catalogId !== null && (typeof catalogId !== 'string' || !/^[a-z0-9-]+$/.test(catalogId))) {
      throw new TypeError('invalid task catalog id')
    }
    if (kind === 'catalog' && catalogId === null) throw new TypeError('catalog tasks require a catalog id')
    if (kind !== 'catalog' && catalogId !== null) throw new TypeError('only catalog tasks may specify a catalog id')
    if (retryOfTaskId !== null && (!Number.isInteger(retryOfTaskId) || retryOfTaskId < 1)) {
      throw new TypeError('invalid retry task id')
    }
    if (retryInstructions !== null && (typeof retryInstructions !== 'string' || retryInstructions.length > 128 * 1024)) {
      throw new TypeError('retry instructions must be no larger than 128 KiB')
    }
    if (groupRunId !== null && (!Number.isInteger(groupRunId) || groupRunId < 1)) {
      throw new TypeError('invalid group run id')
    }
    if (!Array.isArray(consultationIds) || consultationIds.length > 12 || consultationIds.some(id => !Number.isInteger(id) || id < 1)) {
      throw new TypeError('consultation ids must contain at most 12 positive task ids')
    }
    if (new Set(consultationIds).size !== consultationIds.length) throw new TypeError('consultation ids must be unique')
    if (typeof consumeConsultations !== 'boolean') throw new TypeError('consume consultations must be a boolean')
    if (kind === 'catalog' && consultationIds.length > 0) throw new TypeError('catalog tasks may not use consultation context')
    return this.withDatabase(serverId, database => {
      const create = database.transaction(() => {
        if (retryOfTaskId !== null && !database.prepare('SELECT 1 FROM tasks WHERE id = ?').get(retryOfTaskId)) {
          throw new Error(`unknown retry task: ${retryOfTaskId}`)
        }
        for (const consultationId of consultationIds) {
          const consultation = database.prepare(`
            SELECT kind, status, consumed_by_task_id AS consumedByTaskId
            FROM tasks WHERE id = ?
          `).get(consultationId)
          if (!consultation || consultation.kind !== 'consultation' || consultation.status !== 'consulted') {
            throw new Error(`invalid consultation task: ${consultationId}`)
          }
          if (consumeConsultations && consultation.consumedByTaskId !== null) {
            throw new Error(`consultation task ${consultationId} was already used`)
          }
        }
        const result = database.prepare(`
          INSERT INTO tasks (
            request, status, kind, catalog_id, retry_of_task_id, retry_instructions, group_run_id,
            consultation_ids_json, created_at, updated_at
          )
          VALUES (?, 'planning', ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(
          request.trim(),
          kind,
          catalogId,
          retryOfTaskId,
          retryInstructions?.trim() || null,
          groupRunId,
          JSON.stringify(consultationIds)
        )
        const taskId = Number(result.lastInsertRowid)
        if (consumeConsultations) {
          const consume = database.prepare(`
            UPDATE tasks SET consumed_by_task_id = ?, updated_at = unixepoch()
            WHERE id = ? AND consumed_by_task_id IS NULL
          `)
          for (const consultationId of consultationIds) consume.run(taskId, consultationId)
        }
        return taskId
      })
      return this.getFromDatabase(database, create())
    })
  }

  list (serverId, { limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('task history limit must be between 1 and 100')
    return this.withDatabase(serverId, database => database.prepare(`
      SELECT id, request, status, kind, catalog_id AS catalogId,
             retry_of_task_id AS retryOfTaskId, retry_instructions AS retryInstructions,
             group_run_id AS groupRunId, consultation_ids_json AS consultationIdsJson,
             consultation_answer AS consultationAnswer,
             consultation_summary AS consultationSummary,
             consumed_by_task_id AS consumedByTaskId,
             change_overview AS changeOverview, modified_files_json AS modifiedFilesJson,
             created_at AS createdAt, updated_at AS updatedAt, reverted_at AS revertedAt
      FROM tasks
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).map(compactRow))
  }

  get (serverId, taskId) {
    return this.withDatabase(serverId, database => this.getFromDatabase(database, taskId))
  }

  control (serverId, taskId) {
    return this.withDatabase(serverId, database => {
      this.getFromDatabase(database, taskId)
      return database.prepare('SELECT version, action FROM task_controls WHERE task_id = ?').get(taskId) ?? { version: 0, action: 'run' }
    })
  }

  setControl (serverId, taskId, action, expectedVersion) {
    if (!['run', 'pause', 'abort'].includes(action)) throw new TypeError('invalid execution control')
    return this.withDatabase(serverId, database => database.transaction(() => {
      this.getFromDatabase(database, taskId)
      const current = database.prepare('SELECT version FROM task_controls WHERE task_id = ?').get(taskId)?.version ?? 0
      if (current !== expectedVersion) throw new Error('stale operator decision')
      database.prepare('INSERT INTO task_controls (task_id, version, action) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET version = excluded.version, action = excluded.action').run(taskId, current + 1, action)
      return { version: current + 1, action }
    }).immediate())
  }

  stateVersion (serverId, taskId) {
    return this.withDatabase(serverId, database => {
      const task = this.getFromDatabase(database, taskId)
      const event = database.prepare('SELECT max(id) AS id FROM execution_events WHERE task_id = ?').get(taskId).id ?? 0
      const control = database.prepare('SELECT version FROM task_controls WHERE task_id = ?').get(taskId)?.version ?? 0
      return `${planFingerprint({ hostId: serverId, taskId, plan: task.plan })}:${event}:${control}`
    })
  }

  revisions (serverId, taskId) {
    return this.withDatabase(serverId, database => database.prepare('SELECT id, parent_id AS parentId, state_version AS stateVersion, approved, plan_json AS planJson FROM plan_revisions WHERE task_id = ? ORDER BY id')
      .all(taskId).map(row => ({ ...row, plan: JSON.parse(row.planJson) })))
  }

  proposeRevision (serverId, taskId, plan, expectedVersion) {
    return this.withDatabase(serverId, database => database.transaction(() => {
      const task = this.getFromDatabase(database, taskId)
      if (this.stateVersion(serverId, taskId) !== expectedVersion) throw new Error('stale host execution state')
      for (const command of plan.operatorRollback ? [] : this.executionState(serverId, taskId)) {
        if (command.status !== 'completed') continue
        const original = task.plan.commands.find(item => item.id === command.commandId)
        const replacement = plan.commands.find(item => item.id === command.commandId)
        if (!replacement || planFingerprint(original) !== planFingerprint(replacement)) throw new Error('completed command history is immutable')
      }
      if (database.prepare('SELECT 1 FROM execution_leases WHERE task_id = ? AND expires_at > ?').get(taskId, Date.now())) throw new Error('pause execution before revising')
      if (!database.prepare('SELECT 1 FROM plan_revisions WHERE task_id = ?').get(taskId)) {
        database.prepare('INSERT INTO plan_revisions (task_id, parent_id, state_version, approved, plan_json) VALUES (?, NULL, ?, 1, ?)').run(taskId, expectedVersion, JSON.stringify(task.plan))
      }
      const parent = database.prepare("SELECT id FROM plan_revisions WHERE task_id = ? AND approved = 1 AND coalesce(json_extract(plan_json, '$.operatorRollback'), 0) = 0 ORDER BY id DESC LIMIT 1").get(taskId).id
      const result = database.prepare('INSERT INTO plan_revisions (task_id, parent_id, state_version, approved, plan_json) VALUES (?, ?, ?, 0, ?)').run(taskId, parent, expectedVersion, JSON.stringify(plan))
      return Number(result.lastInsertRowid)
    }).immediate())
  }

  approveRevision (serverId, taskId, revisionId, expectedVersion, fingerprint) {
    return this.withDatabase(serverId, database => database.transaction(() => {
      if (this.stateVersion(serverId, taskId) !== expectedVersion) throw new Error('stale operator decision')
      if (database.prepare('SELECT 1 FROM execution_leases WHERE task_id = ? AND expires_at > ?').get(taskId, Date.now())) throw new Error('task is executing')
      const revision = database.prepare('SELECT * FROM plan_revisions WHERE id = ? AND task_id = ? AND approved = 0').get(revisionId, taskId)
      if (!revision || revision.state_version !== expectedVersion || planFingerprint(JSON.parse(revision.plan_json)) !== fingerprint) throw new Error('revision approval does not match proposal')
      database.prepare('UPDATE plan_revisions SET approved = 1 WHERE id = ?').run(revisionId)
      const plan = JSON.parse(revision.plan_json)
      if (!plan.operatorRollback) database.prepare("UPDATE tasks SET plan_json = ?, status = 'planned', updated_at = unixepoch() WHERE id = ?").run(revision.plan_json, taskId)
      if (!plan.operatorRollback) database.prepare("INSERT INTO task_controls (task_id, version, action) VALUES (?, 1, 'pause') ON CONFLICT(task_id) DO UPDATE SET version = version + 1, action = 'pause'").run(taskId)
      const task = this.getFromDatabase(database, taskId)
      database.prepare('INSERT INTO execution_events (task_id, run_id, revision, timestamp, type, metadata_json) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, task.groupRunId, planFingerprint(task.plan), new Date().toISOString(), 'plan_revised', JSON.stringify({ revisionId, parentRevision: revision.parent_id, operation: plan.operatorRollback ? 'rollback' : 'apply' }))
      return task
    }).immediate())
  }

  interruptedTasks (serverId) {
    return this.withDatabase(serverId, database => database.prepare("SELECT id FROM tasks WHERE status IN ('running', 'reverting') ORDER BY id")
      .all().map(row => ({ ...this.getFromDatabase(database, row.id), execution: this.executionState(serverId, row.id) })))
  }

  executionEvents (serverId, taskId, { after = 0, limit = 1000 } = {}) {
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('invalid execution event range')
    return this.withDatabase(serverId, database => {
      this.getFromDatabase(database, taskId)
      return database.prepare('SELECT * FROM execution_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(taskId, after, limit).map(row => executionEvent(serverId, row))
    })
  }

  hostExecutionEvents (serverId, { after = 0, limit = 1000 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('invalid execution event range')
    return this.withDatabase(serverId, database => database.prepare('SELECT * FROM execution_events WHERE id > ? ORDER BY id LIMIT ?')
      .all(after, limit).map(row => executionEvent(serverId, row)))
  }

  allExecutionEvents (serverId, taskId) {
    const events = []
    let after = 0
    for (;;) {
      const page = this.executionEvents(serverId, taskId, { after })
      events.push(...page)
      if (page.length < 1000) return events
      after = page.at(-1).id
    }
  }

  acquireExecution (serverId, taskId, plan) {
    const owner = randomUUID()
    const fingerprint = planFingerprint(plan)
    return this.withDatabase(serverId, database => database.transaction(() => {
      const task = this.getFromDatabase(database, taskId)
      if (!task.plan || planFingerprint(task.plan) !== fingerprint) throw new Error('execution plan differs from saved plan')
      const ancestors = new Set([taskId])
      let ancestor = task
      while (ancestor.retryOfTaskId) {
        if (ancestors.has(ancestor.retryOfTaskId) || ancestors.size >= 100) throw new Error('retry history is cyclic or exceeds the execution inspection limit')
        ancestor = this.getFromDatabase(database, ancestor.retryOfTaskId)
        ancestors.add(ancestor.id)
        const uncertain = [...this.executionState(serverId, ancestor.id), ...this.rollbackState(serverId, ancestor.id)].some(command => command.status === 'uncertain')
        const legacy = ancestor.plan?.commands?.length && ['running', 'reverting', 'partial', 'failed', 'revert_failed'].includes(ancestor.status) && !database.prepare('SELECT 1 FROM execution_events WHERE task_id = ? LIMIT 1').get(ancestor.id)
        if (uncertain || legacy) throw new Error('retry ancestor requires operator reconciliation before execution; no commands were dispatched')
      }
      const related = database.prepare(`WITH RECURSIVE related(id) AS (
        SELECT ? UNION SELECT tasks.id FROM tasks JOIN related ON tasks.retry_of_task_id = related.id LIMIT 1001
      ) SELECT related.id, execution_leases.expires_at AS expiresAt FROM related LEFT JOIN execution_leases ON execution_leases.task_id = related.id`).all(ancestor.id)
      if (related.length > 1000) throw new Error('retry family exceeds the execution inspection limit')
      if (related.some(lease => lease.expiresAt > Date.now())) throw new Error('task or related retry execution is owned by another operator')
      database.prepare('INSERT OR REPLACE INTO execution_leases (task_id, owner, fingerprint, expires_at) VALUES (?, ?, ?, ?)')
        .run(taskId, owner, fingerprint, Date.now() + 30000)
      return { owner, fingerprint }
    }).immediate())
  }

  renewExecution (serverId, taskId, owner) {
    return this.withDatabase(serverId, database => {
      const updated = database.prepare('UPDATE execution_leases SET expires_at = ? WHERE task_id = ? AND owner = ? AND expires_at > ?')
        .run(Date.now() + 30000, taskId, owner, Date.now())
      if (!updated.changes) {
        const lease = database.prepare('SELECT owner, expires_at FROM execution_leases WHERE task_id = ?').get(taskId)
        const error = new Error('execution ownership expired or changed')
        error.code = !lease ? 'EXECUTION_LEASE_MISSING' : lease.owner !== owner ? 'EXECUTION_LEASE_REPLACED' : 'EXECUTION_LEASE_EXPIRED'
        throw error
      }
    })
  }

  releaseExecution (serverId, taskId, owner) {
    return this.withDatabase(serverId, database => database.prepare('DELETE FROM execution_leases WHERE task_id = ? AND owner = ?').run(taskId, owner))
  }

  appendExecutionEvent (serverId, taskId, owner, { type, commandId = null, attemptId = null, metadata = {} }) {
    if (!EXECUTION_EVENTS.has(type)) throw new TypeError('invalid execution event type')
    if (commandId !== null && !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(commandId)) throw new TypeError('invalid journal command id')
    if (attemptId !== null && !/^[a-z0-9-]{1,80}$/u.test(attemptId)) throw new TypeError('invalid execution attempt id')
    return this.withDatabase(serverId, database => database.transaction(() => {
      const task = this.getFromDatabase(database, taskId)
      const lease = database.prepare('SELECT * FROM execution_leases WHERE task_id = ?').get(taskId)
      if (!lease || lease.owner !== owner || lease.expires_at <= Date.now()) throw new Error('execution ownership expired or changed')
      if (planFingerprint(task.plan) !== lease.fingerprint) throw new Error('approved execution plan changed')
      const result = database.prepare('INSERT INTO execution_events (task_id, run_id, revision, command_id, attempt_id, timestamp, type, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(taskId, task.groupRunId, lease.fingerprint, commandId, attemptId, new Date().toISOString(), type, JSON.stringify(journalMetadata(metadata)))
      return Number(result.lastInsertRowid)
    }).immediate())
  }

  executionState (serverId, taskId) {
    const task = this.get(serverId, taskId)
    const events = this.allExecutionEvents(serverId, taskId)
    const fingerprint = task.plan ? planFingerprint(task.plan) : null
    const latest = new Map()
    const jobs = new Map()
    for (const event of events) {
      if (!event.commandId || ['plan_approved', 'execution_recovery'].includes(event.type) || event.metadata.operation === 'rollback') continue
      if (event.revision !== fingerprint && event.type !== 'command_completed') continue
      latest.set(event.commandId, event)
      if (event.metadata.jobId) jobs.set(event.commandId, event.metadata.jobId)
    }
    return (task.plan?.commands ?? []).map(item => {
      const event = latest.get(item.id)
      const status = !event || event.type === 'command_prepared'
        ? 'pending'
        : event.type === 'command_completed'
          ? 'completed'
          : event.type === 'command_failed' ? 'failed' : 'uncertain'
      return { commandId: item.id, status, attemptId: event?.attemptId ?? null, jobId: jobs.get(item.id) ?? null }
    })
  }

  rollbackState (serverId, taskId) {
    const latest = new Map()
    const jobs = new Map()
    for (const event of this.allExecutionEvents(serverId, taskId)) {
      if (event.metadata.operation !== 'rollback' || !event.commandId || ['plan_approved', 'execution_recovery'].includes(event.type)) continue
      const key = `${event.metadata.rollbackRevision}:${event.commandId}`
      latest.set(key, event)
      if (event.metadata.jobId) jobs.set(key, event.metadata.jobId)
    }
    return [...latest.entries()].map(([key, event]) => ({ commandId: event.commandId, attemptId: event.attemptId, rollbackRevision: event.metadata.rollbackRevision, jobId: jobs.get(key) ?? null, status: event.type === 'command_completed' ? 'completed' : event.type === 'command_failed' ? 'failed' : event.type === 'command_prepared' ? 'pending' : 'uncertain' }))
  }

  savePlan (serverId, taskId, plan) {
    if (this.executionEvents(serverId, taskId).length > 0) throw new Error('executed task plans are immutable; create a reviewed replacement task')
    return this.update(serverId, taskId, 'planned', {
      plan,
      changeOverview: plan.changeOverview,
      modifiedFiles: plan.modifiedFiles
    })
  }

  saveConsultation (serverId, taskId, consultation) {
    if (!consultation || typeof consultation.answer !== 'string' || typeof consultation.contextSummary !== 'string') {
      throw new TypeError('invalid consultation response')
    }
    if (!consultation.answer.trim() || consultation.answer.length > 32 * 1024) {
      throw new TypeError('consultation answer must be non-empty and no larger than 32 KiB')
    }
    if (!consultation.contextSummary.trim() || consultation.contextSummary.length > 4096) {
      throw new TypeError('consultation summary must be non-empty and no larger than 4 KiB')
    }
    return this.withDatabase(serverId, database => {
      const save = database.transaction(() => {
        const existing = this.getFromDatabase(database, taskId)
        if (existing.kind !== 'consultation') throw new Error(`task ${taskId} is not a consultation`)
        database.prepare(`
          UPDATE tasks
          SET status = 'consulted', consultation_answer = ?, consultation_summary = ?,
              error = NULL, updated_at = unixepoch()
          WHERE id = ?
        `).run(consultation.answer.trim(), consultation.contextSummary.trim(), taskId)
        const consume = database.prepare(`
          UPDATE tasks SET consumed_by_task_id = ?, updated_at = unixepoch()
          WHERE id = ? AND consumed_by_task_id IS NULL
        `)
        for (const consultationId of existing.consultationIds) consume.run(taskId, consultationId)
      })
      save()
      return this.getFromDatabase(database, taskId)
    })
  }

  listPendingConsultations (serverId, { limit = 12 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new TypeError('consultation limit must be between 1 and 12')
    return this.withDatabase(serverId, database => database.prepare(`
      SELECT id FROM tasks
      WHERE kind = 'consultation' AND status = 'consulted' AND consumed_by_task_id IS NULL
      ORDER BY id DESC LIMIT ?
    `).all(limit).reverse().map(row => this.getFromDatabase(database, row.id)))
  }

  consultationsForTask (serverId, taskId) {
    return this.withDatabase(serverId, database => {
      const task = this.getFromDatabase(database, taskId)
      return task.consultationIds.map(id => {
        const consultation = this.getFromDatabase(database, id)
        if (consultation.kind !== 'consultation' || consultation.status !== 'consulted') {
          throw new Error(`task ${taskId} references invalid consultation ${id}`)
        }
        return consultation
      })
    })
  }

  markRunning (serverId, taskId) {
    return this.update(serverId, taskId, 'running')
  }

  saveResults (serverId, taskId, results) {
    const task = this.get(serverId, taskId)
    const completed = Array.isArray(results) && results.length > 0 && results.every(result => result.status === 'completed') && (task.plan?.commands ?? []).every(command => results.some(result => result.id === command.id && result.status === 'completed'))
    return this.update(serverId, taskId, completed ? 'completed' : 'partial', { results })
  }

  appendProgress (serverId, taskId, event) {
    return this.withDatabase(serverId, database => {
      const existing = this.getFromDatabase(database, taskId)
      const progress = [...existing.progress, event].slice(-1000)
      database.prepare(`
        UPDATE tasks SET progress_json = ?, updated_at = unixepoch() WHERE id = ?
      `).run(JSON.stringify(progress), taskId)
      return this.getFromDatabase(database, taskId)
    })
  }

  appendResult (serverId, taskId, result) {
    return this.withDatabase(serverId, database => {
      const existing = this.getFromDatabase(database, taskId)
      const results = [...(existing.results ?? []), result]
      database.prepare(`
        UPDATE tasks SET results_json = ?, updated_at = unixepoch() WHERE id = ?
      `).run(JSON.stringify(results), taskId)
      return this.getFromDatabase(database, taskId)
    })
  }

  markReverting (serverId, taskId) {
    return this.update(serverId, taskId, 'reverting', { revertError: null })
  }

  appendRevertResult (serverId, taskId, result) {
    return this.withDatabase(serverId, database => {
      const existing = this.getFromDatabase(database, taskId)
      const results = [...(existing.revertResults ?? []), result]
      database.prepare(`
        UPDATE tasks SET revert_results_json = ?, updated_at = unixepoch() WHERE id = ?
      `).run(JSON.stringify(results), taskId)
      return this.getFromDatabase(database, taskId)
    })
  }

  saveRevertResults (serverId, taskId, results) {
    const completed = Array.isArray(results) && results.length > 0 && results.every(result => result.status === 'completed')
    return this.update(serverId, taskId, completed ? 'reverted' : 'revert_failed', {
      revertResults: results,
      revertedAt: completed ? Math.floor(Date.now() / 1000) : null
    })
  }

  saveRevertError (serverId, taskId, error) {
    return this.update(serverId, taskId, 'revert_failed', {
      revertError: String(error?.message ?? error)
    })
  }

  saveError (serverId, taskId, error) {
    return this.update(serverId, taskId, 'failed', { error: String(error?.message ?? error) })
  }

  cancel (serverId, taskId) {
    return this.update(serverId, taskId, 'cancelled')
  }

  /** @param {string} serverId @param {number} taskId @param {string} status @param {Record<string, any>} [changes] */
  update (serverId, taskId, status, {
    plan,
    results,
    error,
    changeOverview,
    modifiedFiles,
    consultationAnswer,
    consultationSummary,
    revertResults,
    revertError,
    revertedAt
  } = {}) {
    if (!STATUSES.has(status)) throw new TypeError('invalid task status')
    return this.withDatabase(serverId, database => database.transaction(() => {
      if (plan !== undefined && database.prepare('SELECT 1 FROM execution_events WHERE task_id = ? LIMIT 1').get(taskId)) throw new Error('executed task plans are immutable')
      const existing = this.getFromDatabase(database, taskId)
      database.prepare(`
        UPDATE tasks
        SET status = ?, plan_json = ?, results_json = ?, error = ?,
            change_overview = ?, modified_files_json = ?, revert_results_json = ?,
            consultation_answer = ?, consultation_summary = ?,
            revert_error = ?, reverted_at = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(
        status,
        plan === undefined ? jsonOrNull(existing.plan) : JSON.stringify(plan),
        results === undefined ? jsonOrNull(existing.results) : JSON.stringify(results),
        error === undefined ? existing.error : error,
        changeOverview === undefined ? existing.changeOverview : changeOverview,
        modifiedFiles === undefined ? JSON.stringify(existing.modifiedFiles) : JSON.stringify(modifiedFiles),
        revertResults === undefined ? jsonOrNull(existing.revertResults) : JSON.stringify(revertResults),
        consultationAnswer === undefined ? existing.consultationAnswer : consultationAnswer,
        consultationSummary === undefined ? existing.consultationSummary : consultationSummary,
        revertError === undefined ? existing.revertError : revertError,
        revertedAt === undefined ? existing.revertedAt : revertedAt,
        taskId
      )
      return this.getFromDatabase(database, taskId)
    }).immediate())
  }

  getFromDatabase (database, taskId) {
    if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('invalid task id')
    const row = database.prepare(`
      SELECT id, request, status, kind, catalog_id AS catalogId,
             retry_of_task_id AS retryOfTaskId, retry_instructions AS retryInstructions,
             group_run_id AS groupRunId, consultation_ids_json AS consultationIdsJson,
             consultation_answer AS consultationAnswer,
             consultation_summary AS consultationSummary,
             consumed_by_task_id AS consumedByTaskId,
             plan_json AS planJson, results_json AS resultsJson, progress_json AS progressJson,
             change_overview AS changeOverview, modified_files_json AS modifiedFilesJson,
             revert_results_json AS revertResultsJson, revert_error AS revertError,
             reverted_at AS revertedAt, error, created_at AS createdAt, updated_at AS updatedAt
      FROM tasks WHERE id = ?
    `).get(taskId)
    if (!row) throw new Error(`unknown task: ${taskId}`)
    return {
      id: row.id,
      request: row.request,
      status: row.status,
      kind: row.kind,
      catalogId: row.catalogId,
      retryOfTaskId: row.retryOfTaskId,
      retryInstructions: row.retryInstructions,
      groupRunId: row.groupRunId,
      consultationIds: parseJson(row.consultationIdsJson) ?? [],
      consultationAnswer: row.consultationAnswer,
      consultationSummary: row.consultationSummary,
      consumedByTaskId: row.consumedByTaskId,
      plan: parseJson(row.planJson),
      results: parseJson(row.resultsJson),
      progress: parseJson(row.progressJson) ?? [],
      changeOverview: row.changeOverview,
      modifiedFiles: parseJson(row.modifiedFilesJson) ?? [],
      revertResults: parseJson(row.revertResultsJson),
      revertError: row.revertError,
      revertedAt: row.revertedAt,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  withDatabase (serverId, callback) {
    const directory = resolveServerDirectory(this.dataRoot, this.directoryAliases.get(serverId) ?? serverId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const databasePath = path.join(directory, DATABASE_FILE)
    const database = new Database(databasePath)
    try {
      chmodSync(databasePath, 0o600)
      database.pragma('journal_mode = DELETE')
      database.pragma('synchronous = FULL')
      database.exec(`
        CREATE TABLE IF NOT EXISTS task_controls (task_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, action TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS plan_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, parent_id INTEGER, state_version TEXT NOT NULL, approved INTEGER NOT NULL, plan_json TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS revisions_no_plan_update BEFORE UPDATE OF plan_json, parent_id, state_version ON plan_revisions BEGIN SELECT RAISE(ABORT, 'revision history is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'revision history is immutable'); END;
        CREATE TABLE IF NOT EXISTS execution_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
          run_id INTEGER, revision TEXT NOT NULL, command_id TEXT, attempt_id TEXT,
          timestamp TEXT NOT NULL, type TEXT NOT NULL, metadata_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS execution_events_task ON execution_events(task_id, id);
        CREATE TRIGGER IF NOT EXISTS execution_events_no_update BEFORE UPDATE ON execution_events BEGIN SELECT RAISE(ABORT, 'execution journal is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS execution_events_no_delete BEFORE DELETE ON execution_events BEGIN SELECT RAISE(ABORT, 'execution journal is append-only'); END;
        CREATE TABLE IF NOT EXISTS execution_leases (
          task_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY,
          request TEXT NOT NULL,
          status TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'ai',
          catalog_id TEXT,
          retry_of_task_id INTEGER,
          retry_instructions TEXT,
          group_run_id INTEGER,
          consultation_ids_json TEXT NOT NULL DEFAULT '[]',
          consultation_answer TEXT,
          consultation_summary TEXT,
          consumed_by_task_id INTEGER,
          plan_json TEXT,
          results_json TEXT,
          progress_json TEXT NOT NULL DEFAULT '[]',
          change_overview TEXT,
          modified_files_json TEXT NOT NULL DEFAULT '[]',
          revert_results_json TEXT,
          revert_error TEXT,
          reverted_at INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at DESC);
      `)
      ensureColumn(database, 'kind', "TEXT NOT NULL DEFAULT 'ai'")
      ensureColumn(database, 'catalog_id', 'TEXT')
      ensureColumn(database, 'retry_of_task_id', 'INTEGER')
      database.exec('CREATE INDEX IF NOT EXISTS tasks_retry_parent ON tasks(retry_of_task_id)')
      ensureColumn(database, 'retry_instructions', 'TEXT')
      ensureColumn(database, 'group_run_id', 'INTEGER')
      ensureColumn(database, 'consultation_ids_json', "TEXT NOT NULL DEFAULT '[]'")
      ensureColumn(database, 'consultation_answer', 'TEXT')
      ensureColumn(database, 'consultation_summary', 'TEXT')
      ensureColumn(database, 'consumed_by_task_id', 'INTEGER')
      ensureColumn(database, 'progress_json', "TEXT NOT NULL DEFAULT '[]'")
      ensureColumn(database, 'change_overview', 'TEXT')
      ensureColumn(database, 'modified_files_json', "TEXT NOT NULL DEFAULT '[]'")
      ensureColumn(database, 'revert_results_json', 'TEXT')
      ensureColumn(database, 'revert_error', 'TEXT')
      ensureColumn(database, 'reverted_at', 'INTEGER')
      return callback(database)
    } finally {
      database.close()
    }
  }
}

function parseJson (value) {
  return value === null ? null : JSON.parse(value)
}

function jsonOrNull (value) {
  return value === null ? null : JSON.stringify(value)
}

function ensureColumn (database, name, definition) {
  const columns = database.pragma('table_info(tasks)')
  if (!columns.some(column => column.name === name)) {
    database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`)
  }
}

function executionEvent (serverId, row) {
  return { version: 1, id: row.id, hostId: serverId, runId: row.run_id, taskId: row.task_id, revision: row.revision, commandId: row.command_id, attemptId: row.attempt_id, timestamp: row.timestamp, type: row.type, metadata: JSON.parse(row.metadata_json) }
}

function compactRow (row) {
  return {
    ...row,
    consultationIds: parseJson(row.consultationIdsJson) ?? [],
    modifiedFiles: parseJson(row.modifiedFilesJson) ?? []
  }
}
