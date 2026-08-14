import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { validateServerId } from './server-id.js'

const DATABASE_FILE = 'multi-host-runs.sqlite3'
const KINDS = new Set(['ai', 'catalog'])
const RUN_STATUSES = new Set(['planning', 'planned', 'running', 'completed', 'partial', 'failed', 'cancelled', 'reverting', 'reverted', 'revert_failed'])
const HOST_STATUSES = new Set(['queued', ...RUN_STATUSES])

export class MultiHostRunStore {
  constructor (dataRoot) {
    this.dataRoot = path.resolve(dataRoot)
    mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 })
    this.databasePath = path.join(this.dataRoot, DATABASE_FILE)
    this.initialize()
  }

  /**
   * @param {import('./public-api-contracts.js').MultiHostRunInput} input
   * @returns {import('./public-api-contracts.js').MultiHostRun}
   */
  create ({ request, kind = 'ai', catalogId = null, serverIds, retryOfRunId = null, retryInstructions = null }) {
    validateRunInput({ request, kind, catalogId, serverIds, retryOfRunId, retryInstructions })
    return this.withDatabase(database => {
      if (retryOfRunId !== null && !database.prepare('SELECT 1 FROM runs WHERE id = ?').get(retryOfRunId)) {
        throw new Error(`unknown multi-host run: ${retryOfRunId}`)
      }
      const create = database.transaction(() => {
        const result = database.prepare(`
          INSERT INTO runs (
            request, kind, catalog_id, status, retry_of_run_id, retry_instructions,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'planning', ?, ?, unixepoch(), unixepoch())
        `).run(request.trim(), kind, catalogId, retryOfRunId, retryInstructions?.trim() || null)
        const runId = Number(result.lastInsertRowid)
        const addHost = database.prepare(`
          INSERT INTO run_hosts (run_id, server_id, status, updated_at)
          VALUES (?, ?, 'queued', unixepoch())
        `)
        for (const serverId of serverIds) addHost.run(runId, serverId)
        return runId
      })
      return this.getFromDatabase(database, create())
    })
  }

  /** @returns {import('./public-api-contracts.js').MultiHostRun[]} */
  list ({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('run history limit must be between 1 and 100')
    return this.withDatabase(database => database.prepare(`
      SELECT id FROM runs ORDER BY id DESC LIMIT ?
    `).all(limit).map(row => this.getFromDatabase(database, row.id)))
  }

  /** @returns {import('./public-api-contracts.js').MultiHostRun} */
  get (runId) {
    return this.withDatabase(database => this.getFromDatabase(database, runId))
  }

  updateRun (runId, status) {
    if (!RUN_STATUSES.has(status)) throw new TypeError('invalid multi-host run status')
    return this.withDatabase(database => {
      assertRun(database, runId)
      database.prepare('UPDATE runs SET status = ?, updated_at = unixepoch() WHERE id = ?').run(status, runId)
      return this.getFromDatabase(database, runId)
    })
  }

  /**
   * @param {number} runId
   * @param {string} serverId
   * @param {{ taskId?: number | null, status?: import('./public-api-contracts.js').MultiHostStatus, error?: string | null, verification?: object | null }} [updates]
   */
  updateHost (runId, serverId, { taskId, status, error, verification } = {}) {
    validateServerId(serverId)
    if (taskId !== undefined && taskId !== null && (!Number.isInteger(taskId) || taskId < 1)) throw new TypeError('invalid task id')
    if (status !== undefined && !HOST_STATUSES.has(status)) throw new TypeError('invalid multi-host host status')
    return this.withDatabase(database => {
      const existing = database.prepare(`
        SELECT task_id AS taskId, status, error, verification_json AS verificationJson
        FROM run_hosts WHERE run_id = ? AND server_id = ?
      `).get(runId, serverId)
      if (!existing) throw new Error(`host ${serverId} is not part of multi-host run ${runId}`)
      database.prepare(`
        UPDATE run_hosts
        SET task_id = ?, status = ?, error = ?, verification_json = ?, updated_at = unixepoch()
        WHERE run_id = ? AND server_id = ?
      `).run(
        taskId === undefined ? existing.taskId : taskId,
        status === undefined ? existing.status : status,
        error === undefined ? existing.error : error,
        verification === undefined ? existing.verificationJson : JSON.stringify(verification),
        runId,
        serverId
      )
      database.prepare('UPDATE runs SET updated_at = unixepoch() WHERE id = ?').run(runId)
      return this.getFromDatabase(database, runId)
    })
  }

  getFromDatabase (database, runId) {
    if (!Number.isInteger(runId) || runId < 1) throw new TypeError('invalid multi-host run id')
    const run = database.prepare(`
      SELECT id, request, kind, catalog_id AS catalogId, status,
             retry_of_run_id AS retryOfRunId, retry_instructions AS retryInstructions,
             created_at AS createdAt, updated_at AS updatedAt
      FROM runs WHERE id = ?
    `).get(runId)
    if (!run) throw new Error(`unknown multi-host run: ${runId}`)
    const hosts = database.prepare(`
      SELECT server_id AS serverId, task_id AS taskId, status, error,
             verification_json AS verificationJson, updated_at AS updatedAt
      FROM run_hosts WHERE run_id = ? ORDER BY server_id
    `).all(runId).map(host => ({
      ...host,
      verification: host.verificationJson === null ? null : JSON.parse(host.verificationJson)
    }))
    return { ...run, hosts }
  }

  initialize () {
    this.withDatabase(database => database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY,
        request TEXT NOT NULL,
        kind TEXT NOT NULL,
        catalog_id TEXT,
        status TEXT NOT NULL,
        retry_of_run_id INTEGER,
        retry_instructions TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_hosts (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        server_id TEXT NOT NULL,
        task_id INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        verification_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, server_id)
      );
      CREATE INDEX IF NOT EXISTS runs_updated_at ON runs(updated_at DESC);
    `))
  }

  withDatabase (callback) {
    const database = new Database(this.databasePath)
    try {
      chmodSync(this.databasePath, 0o600)
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = FULL')
      database.pragma('busy_timeout = 5000')
      database.pragma('foreign_keys = ON')
      return callback(database)
    } finally {
      database.close()
    }
  }
}

function assertRun (database, runId) {
  if (!Number.isInteger(runId) || runId < 1) throw new TypeError('invalid multi-host run id')
  if (!database.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) throw new Error(`unknown multi-host run: ${runId}`)
}

function validateRunInput ({ request, kind, catalogId, serverIds, retryOfRunId, retryInstructions }) {
  if (typeof request !== 'string' || !request.trim() || request.length > 128 * 1024) {
    throw new TypeError('run request must be non-empty and no larger than 128 KiB')
  }
  if (!KINDS.has(kind)) throw new TypeError('run kind must be ai or catalog')
  if (catalogId !== null && (typeof catalogId !== 'string' || !/^[a-z0-9-]+$/.test(catalogId))) throw new TypeError('invalid run catalog id')
  if (kind === 'catalog' && catalogId === null) throw new TypeError('catalog runs require a catalog id')
  if (kind !== 'catalog' && catalogId !== null) throw new TypeError('only catalog runs may specify a catalog id')
  if (!Array.isArray(serverIds) || serverIds.length === 0) throw new TypeError('at least one host is required')
  if (new Set(serverIds).size !== serverIds.length) throw new TypeError('multi-host run hosts must be unique')
  serverIds.forEach(validateServerId)
  if (retryOfRunId !== null && (!Number.isInteger(retryOfRunId) || retryOfRunId < 1)) throw new TypeError('invalid retry run id')
  if (retryInstructions !== null && (typeof retryInstructions !== 'string' || retryInstructions.length > 128 * 1024)) {
    throw new TypeError('retry instructions must be no larger than 128 KiB')
  }
}
