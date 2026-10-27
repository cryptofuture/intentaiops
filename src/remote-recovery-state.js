import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { planFingerprint } from './execution-journal.js'
import { recoveryKeyFingerprint, verifyRecoveryKeyRotation } from './remote-recovery-record.js'

export class RemoteRecoveryState {
  constructor (dataRoot) {
    this.filename = path.join(dataRoot, 'remote-recovery.sqlite3')
  }

  withDatabase (operation) {
    mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const database = new Database(this.filename)
    try {
      chmodSync(this.filename, 0o600)
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = FULL')
      database.pragma('busy_timeout = 30000')
      database.exec('CREATE TABLE IF NOT EXISTS pins (target TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, public_key TEXT NOT NULL); CREATE TABLE IF NOT EXISTS executions (target TEXT NOT NULL, task_id INTEGER NOT NULL, execution_id TEXT NOT NULL, owner TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, head TEXT, manifest_json TEXT NOT NULL, PRIMARY KEY (target, task_id))')
      database.exec('CREATE TABLE IF NOT EXISTS verification_keys (target TEXT NOT NULL, fingerprint TEXT NOT NULL, public_key TEXT NOT NULL, PRIMARY KEY (target, fingerprint)); CREATE TABLE IF NOT EXISTS key_rotations (target TEXT NOT NULL, fingerprint TEXT NOT NULL, transition_json TEXT NOT NULL, PRIMARY KEY (target, fingerprint))')
      return operation(database)
    } finally { database.close() }
  }

  pin (target, key) {
    if (!/^SHA256:[a-f0-9]{64}$/u.test(target) || recoveryKeyFingerprint(key.publicKey) !== key.fingerprint) throw new Error('Invalid recovery trust anchor')
    return this.withDatabase(database => database.transaction(() => {
      const known = database.prepare('SELECT fingerprint FROM pins WHERE target = ?').get(target)
      if (known && known.fingerprint !== key.fingerprint) throw new Error('Remote recovery key changed; explicit rotation review is required')
      if (!known) database.prepare('INSERT INTO pins VALUES (?, ?, ?)').run(target, key.fingerprint, key.publicKey)
      database.prepare('INSERT OR IGNORE INTO verification_keys VALUES (?, ?, ?)').run(target, key.fingerprint, key.publicKey)
      return { publicKey: key.publicKey, target, pinnedFingerprint: key.fingerprint }
    }).immediate())
  }

  trustedKey (target, fingerprint) {
    return this.withDatabase(database => {
      const row = database.prepare('SELECT public_key FROM verification_keys WHERE target = ? AND fingerprint = ?').get(target, fingerprint)
      return row ? { target, publicKey: row.public_key, pinnedFingerprint: fingerprint } : null
    })
  }

  currentKey (target) {
    return this.withDatabase(database => {
      const row = database.prepare('SELECT fingerprint, public_key FROM pins WHERE target = ?').get(target)
      return row ? { fingerprint: row.fingerprint, publicKey: row.public_key } : null
    })
  }

  rememberHistoricalKey (target, key, activeFingerprint) {
    if (recoveryKeyFingerprint(key.publicKey) !== key.fingerprint) throw new Error('Invalid historical recovery key')
    return this.withDatabase(database => database.transaction(() => {
      const current = database.prepare('SELECT fingerprint FROM pins WHERE target = ?').get(target)
      if (current?.fingerprint !== activeFingerprint) throw new Error('Recovery signing key changed during inspection')
      database.prepare('INSERT OR IGNORE INTO verification_keys VALUES (?, ?, ?)').run(target, key.fingerprint, key.publicKey)
      return { target, publicKey: key.publicKey, pinnedFingerprint: key.fingerprint }
    }).immediate())
  }

  acceptKeyRotation (target, key, expectedFingerprint) {
    return this.withDatabase(database => database.transaction(() => {
      const known = database.prepare('SELECT fingerprint, public_key FROM pins WHERE target = ?').get(target)
      if (!known || known.fingerprint !== expectedFingerprint) throw new Error('Stale recovery key rotation approval')
      const next = verifyRecoveryKeyRotation(key.rotation, { target, publicKey: known.public_key, pinnedFingerprint: expectedFingerprint })
      if (next.fingerprint !== key.fingerprint || recoveryKeyFingerprint(key.publicKey) !== next.fingerprint) throw new Error('Published recovery key differs from the reviewed transition')
      for (const value of [{ fingerprint: known.fingerprint, publicKey: known.public_key }, next]) database.prepare('INSERT OR IGNORE INTO verification_keys VALUES (?, ?, ?)').run(target, value.fingerprint, value.publicKey)
      database.prepare('INSERT INTO key_rotations VALUES (?, ?, ?)').run(target, next.fingerprint, JSON.stringify(key.rotation))
      database.prepare('UPDATE pins SET fingerprint = ?, public_key = ? WHERE target = ?').run(next.fingerprint, next.publicKey, target)
      return { target, publicKey: next.publicKey, pinnedFingerprint: next.fingerprint }
    }).immediate())
  }

  register (manifest) {
    return this.withDatabase(database => database.transaction(() => {
      const previous = database.prepare('SELECT manifest_json FROM executions WHERE target = ? AND task_id = ?').get(manifest.target, manifest.taskId)
      if (previous) {
        const known = JSON.parse(previous.manifest_json)
        if (known.planDigest !== manifest.planDigest) throw new Error('Registered common-task recovery definition cannot be overwritten')
        return known
      }
      if (manifest.executionId !== undefined && !/^[a-f0-9]{32}$/u.test(manifest.executionId)) throw new Error('Invalid remote execution identity')
      const value = { ...manifest, executionId: manifest.executionId ?? randomBytes(16).toString('hex') }
      database.prepare('INSERT INTO executions (target, task_id, execution_id, owner, manifest_json) VALUES (?, ?, ?, ?, ?)').run(value.target, value.taskId, value.executionId, randomBytes(16).toString('hex'), JSON.stringify(value))
      return value
    }).immediate())
  }

  get (target, taskId) {
    if (typeof target !== 'string' || !existsSync(this.filename)) return null
    return this.withDatabase(database => {
      const row = database.prepare('SELECT * FROM executions WHERE target = ? AND task_id = ?').get(target, taskId)
      return row ? { manifest: JSON.parse(row.manifest_json), owner: row.owner, sequence: row.sequence, head: row.head } : null
    })
  }

  checkpoint (target, executionId) {
    if (!existsSync(this.filename)) return null
    return this.withDatabase(database => database.prepare('SELECT sequence, head FROM executions WHERE target = ? AND execution_id = ? AND sequence > 0 ORDER BY sequence DESC LIMIT 1').get(target, executionId) ?? null)
  }

  registerRecovery (taskId, manifest, { sequence, head, recoveryId, recoveryPlanDigest, baselineDigest }) {
    return this.withDatabase(database => {
      const value = { ...manifest, recoveryId, recoveryPlanDigest, baselineDigest, sourceHead: head, sourceSequence: sequence }
      database.prepare('INSERT INTO executions (target, task_id, execution_id, owner, sequence, head, manifest_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(manifest.target, taskId, manifest.executionId, randomBytes(16).toString('hex'), sequence, head, JSON.stringify(value))
      return value
    })
  }

  advance (target, taskId, expectedSequence, expectedHead, envelope) {
    return this.withDatabase(database => {
      const result = database.prepare('UPDATE executions SET sequence = ?, head = ? WHERE target = ? AND task_id = ? AND sequence = ? AND head IS ?').run(expectedSequence + 1, planFingerprint(envelope), target, taskId, expectedSequence, expectedHead)
      if (result.changes !== 1) throw new Error('Stale local recovery record head; inspect remote history before continuing')
    })
  }
}
