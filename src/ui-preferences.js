import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import { appearance } from '../web/themes/index.js'

export class UiPreferences {
  constructor (dataRoot) {
    this.file = path.join(dataRoot, 'ui-preferences.sqlite3')
  }

  access (operation) {
    const db = new Database(this.file)
    try {
      chmodSync(this.file, 0o600)
      db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 5000')
      db.exec('CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, data TEXT NOT NULL)')
      return operation(db)
    } finally { db.close() }
  }

  get () {
    return this.access(db => { const row = db.prepare('SELECT version,data FROM preferences WHERE id=1').get(); return { version: row?.version ?? 0, value: row ? JSON.parse(row.data) : { appearance: appearance(), favorites: [], sidebar: 256, panes: [] } } })
  }

  save (expectedVersion, patch) {
    if (!Number.isSafeInteger(expectedVersion) || !patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['appearance', 'favorites', 'sidebar', 'panes', 'split'].includes(key))) throw new Error('Invalid UI preferences')
    if (patch.appearance) patch.appearance = appearance(patch.appearance)
    if (patch.sidebar !== undefined && (!Number.isInteger(patch.sidebar) || patch.sidebar < 220 || patch.sidebar > 420)) throw new Error('Invalid sidebar width')
    if (patch.favorites && (!Array.isArray(patch.favorites) || patch.favorites.length > 256 || patch.favorites.some(id => typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/u.test(id)))) throw new Error('Invalid favorites')
    if (patch.panes && (!Array.isArray(patch.panes) || patch.panes.length > 8 || patch.panes.some(p => !p || Object.keys(p).some(k => !['hostId', 'taskId', 'width', 'height'].includes(k)) || typeof p.hostId !== 'string' || !/^[a-z0-9_-]{1,128}$/u.test(p.hostId) || !Number.isSafeInteger(p.taskId) || p.taskId < 1 || ['width', 'height'].some(k => p[k] !== undefined && (!Number.isInteger(p[k]) || p[k] < 200 || p[k] > 4000))))) throw new Error('Invalid panes')
    if (patch.split !== undefined && !['horizontal', 'vertical'].includes(patch.split)) throw new Error('Invalid split')
    return this.access(db => db.transaction(() => {
      const row = db.prepare('SELECT version,data FROM preferences WHERE id=1').get()
      if ((row?.version ?? 0) !== expectedVersion) throw new Error('Stale UI preferences; reload before saving')
      const value = { ...(row ? JSON.parse(row.data) : { appearance: appearance(), favorites: [], sidebar: 256, panes: [] }), ...patch }
      db.prepare('INSERT INTO preferences VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data').run(expectedVersion + 1, JSON.stringify(value))
      return { version: expectedVersion + 1, value }
    }).immediate())
  }
}
