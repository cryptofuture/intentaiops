import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
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

  savePlan (serverId, taskId, plan) {
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
    const completed = Array.isArray(results) && results.length > 0 && results.every(result => result.status === 'completed')
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
    return this.withDatabase(serverId, database => {
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
    })
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

function compactRow (row) {
  return {
    ...row,
    consultationIds: parseJson(row.consultationIdsJson) ?? [],
    modifiedFiles: parseJson(row.modifiedFilesJson) ?? []
  }
}
