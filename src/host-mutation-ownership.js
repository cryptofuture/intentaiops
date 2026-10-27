import Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { planFingerprint } from './execution-journal.js'

const current = new AsyncLocalStorage()
function privateEntry (file, directory = false) {
  const stat = lstatSync(file)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Unsafe host ownership storage')
}
export async function withHostMutation ({ dataRoot, identity, before }, operation) {
  const directory = path.join(dataRoot, 'host-ownership')
  const file = path.join(directory, createHash('sha256').update(identity).digest('hex') + '.sqlite3')
  if (current.getStore()?.has(file)) { await before?.(); return operation() }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  privateEntry(directory, true)
  try { privateEntry(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const db = new Database(file)
  try {
    chmodSync(file, 0o600)
    db.pragma('busy_timeout = 0')
    try { db.exec('BEGIN IMMEDIATE') } catch { throw new Error('Another operator is modifying this host; wait or pause remaining work') }
    await before?.()
    return await current.run(new Set([...(current.getStore() ?? []), file]), operation)
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close() }
}

export function guardAdminMutations (admin) {
  for (const name of ['execute', 'revertTask', 'executeRemoteCommonTaskRecovery', 'activate', 'deactivate']) {
    const method = admin[name].bind(admin)
    admin[name] = options => withHostMutation({
      dataRoot: admin.dataRoot,
      identity: options.settings?.servers?.[options.serverId]?.historyId ?? options.serverId,
      before: () => assertHostMutationReady({ settingsStore: admin.settings, tasks: admin.tasks, ...options })
    }, () => method(options))
  }
}

export async function assertHostMutationReady ({ settingsStore, tasks, settings, serverId, taskId }) {
  if (settingsStore.snapshots?.has(settings)) {
    const latest = await settingsStore.load()
    if (planFingerprint(latest.servers[serverId]) !== planFingerprint(settings.servers[serverId])) throw new Error('Host settings changed in another session; reconnect before mutation')
  }
  if (tasks.interruptedTasks(serverId).some(task => task.id !== taskId)) throw new Error('Other interrupted host work requires inspection and reconciliation before mutation')
}
