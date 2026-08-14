import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { isDeploymentPhase } from './deployment-phases.js'
import { isFailureCode } from './failure-signature.js'
import { validateServerId } from './server-id.js'

const DATABASE_FILE = 'deployment-scorecards.sqlite3'
const OUTCOMES = new Set(['completed', 'failed', 'blocked', 'rejected'])

export class DeploymentScorecard {
  constructor (dataRoot) {
    this.dataRoot = path.resolve(dataRoot)
    mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 })
    this.databasePath = path.join(this.dataRoot, DATABASE_FILE)
    this.initialize()
  }

  record ({ runId = null, taskId = null, serverId, applicationId, stackId = 'unclassified', distroFamily = 'unknown', phase = 'initialize', outcome, durationMs = 0, failureCode = null, firstPass = true, operation = 'apply' }) {
    validateEvent({ runId, taskId, serverId, applicationId, stackId, distroFamily, phase, outcome, durationMs, failureCode, firstPass, operation })
    return this.withDatabase(database => database.prepare(`
      INSERT INTO phase_events (
        run_id, task_id, server_id, application_id, stack_id, distro_family,
        phase, outcome, duration_ms, failure_code, first_pass, operation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(runId, taskId, serverId, applicationId, stackId, distroFamily, phase, outcome, durationMs, failureCode, firstPass ? 1 : 0, operation).lastInsertRowid)
  }

  summary ({ applicationId = null } = {}) {
    if (applicationId !== null && !safeId(applicationId)) throw new TypeError('invalid scorecard application id')
    return this.withDatabase(database => {
      const where = applicationId === null ? '' : 'WHERE application_id = ?'
      const values = applicationId === null ? [] : [applicationId]
      return database.prepare(`
        SELECT application_id AS applicationId, stack_id AS stackId,
               distro_family AS distroFamily, phase,
               COUNT(*) AS attempts,
               SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS successes,
               SUM(CASE WHEN first_pass = 1 AND outcome = 'completed' THEN 1 ELSE 0 END) AS firstPassSuccesses,
               SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failures,
               ROUND(AVG(duration_ms)) AS averageDurationMs
        FROM phase_events ${where}
        GROUP BY application_id, stack_id, distro_family, phase
        ORDER BY application_id, stack_id, distro_family, phase
      `).all(...values)
    })
  }

  informationByHost ({ applicationId }) {
    if (!safeId(applicationId)) throw new TypeError('invalid scorecard application id')
    return this.withDatabase(database => database.prepare(`
      SELECT server_id AS serverId,
             COUNT(*) AS observations,
             SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failures,
             COUNT(DISTINCT failure_code) AS distinctFailures,
             MAX(created_at) AS lastObservedAt
      FROM phase_events WHERE application_id = ?
      GROUP BY server_id
    `).all(applicationId))
  }

  initialize () {
    this.withDatabase(database => database.exec(`
      CREATE TABLE IF NOT EXISTS phase_events (
        id INTEGER PRIMARY KEY,
        run_id INTEGER,
        task_id INTEGER,
        server_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        stack_id TEXT NOT NULL,
        distro_family TEXT NOT NULL,
        phase TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        failure_code TEXT,
        first_pass INTEGER NOT NULL,
        operation TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS phase_events_dimensions
      ON phase_events(application_id, stack_id, distro_family, phase, created_at DESC);
      CREATE INDEX IF NOT EXISTS phase_events_host
      ON phase_events(application_id, server_id, created_at DESC);
    `))
  }

  withDatabase (callback) {
    const database = new Database(this.databasePath)
    try {
      chmodSync(this.databasePath, 0o600)
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = FULL')
      database.pragma('busy_timeout = 5000')
      return callback(database)
    } finally {
      database.close()
    }
  }
}

function validateEvent (event) {
  validateServerId(event.serverId)
  for (const key of ['applicationId', 'stackId', 'distroFamily']) if (!safeId(event[key])) throw new TypeError(`invalid scorecard ${key}`)
  if (!isDeploymentPhase(event.phase) || !OUTCOMES.has(event.outcome)) throw new TypeError('invalid scorecard phase or outcome')
  if (!Number.isInteger(event.durationMs) || event.durationMs < 0) throw new TypeError('invalid scorecard duration')
  if (event.failureCode !== null && !isFailureCode(event.failureCode)) throw new TypeError('invalid scorecard failure code')
  if (typeof event.firstPass !== 'boolean' || !['apply', 'revert'].includes(event.operation)) throw new TypeError('invalid scorecard execution metadata')
  for (const key of ['runId', 'taskId']) if (event[key] !== null && (!Number.isInteger(event[key]) || event[key] < 1)) throw new TypeError(`invalid scorecard ${key}`)
}

function safeId (value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)
}
