import { createHmac, randomBytes, randomUUID } from 'node:crypto'

export function normalizeSshTransport (value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid SSH transport settings')
  const settings = { multiplexing: value.multiplexing ?? true, idleTimeoutSeconds: value.idleTimeoutSeconds ?? 600, compression: value.compression ?? false }
  if (typeof settings.multiplexing !== 'boolean' || typeof settings.compression !== 'boolean' || !Number.isInteger(settings.idleTimeoutSeconds) || settings.idleTimeoutSeconds < 0 || settings.idleTimeoutSeconds > 86400) throw new TypeError('invalid SSH transport settings')
  return settings
}

export class SshSessionManager {
  constructor ({ ssh, onDiagnostic = () => {} }) {
    this.ssh = ssh
    this.onDiagnostic = onDiagnostic
    this.entries = new Map()
    this.identityKey = randomBytes(32)
    this.closed = false
    this.counters = { mastersEstablished: 0, reuseHits: 0, channels: 0, reconnects: 0, cleanupFailures: 0, establishmentDurationMs: 0 }
  }

  diagnostics () {
    const entries = [...this.entries.values()].filter(entry => entry.session?.multiplexed !== false)
    return { ...this.counters, activeMasters: entries.filter(entry => entry.session && (entry.references || entry.operations)).length, idleMasters: entries.filter(entry => entry.session && !entry.references && !entry.operations).length }
  }

  diagnostic (event) {
    if (event.type === 'master-established') { this.counters.mastersEstablished++; this.counters.establishmentDurationMs += event.durationMs }
    if (event.type === 'channel') this.counters.channels++
    if (event.type === 'reconnect') this.counters.reconnects++
    if (event.type === 'cleanup-failed') this.counters.cleanupFailures++
    try { this.onDiagnostic({ ...event, counters: this.diagnostics() }) } catch {}
  }

  async acquire (connectionUrl, { authentication = 'auto', credential = null, transport = this.ssh.transport, signal } = {}) {
    if (this.closed) throw new Error('SSH session manager is closed')
    signal?.throwIfAborted()
    const settings = normalizeSshTransport(transport)
    const context = this.ssh.connectionIdentity ? await this.ssh.connectionIdentity(connectionUrl, { authentication, transport: settings }) : connectionUrl
    if (context === null) settings.idleTimeoutSeconds = 0
    signal?.throwIfAborted()
    if (this.closed) throw new Error('SSH session manager is closed')
    const key = context === null ? randomUUID() : createHmac('sha256', this.identityKey).update(JSON.stringify([context, authentication, credential, settings, process.env])).digest('hex')
    let entry = this.entries.get(key)
    if (entry?.session?.closed) { await this.remove(entry); entry = this.entries.get(key) }
    if (!entry) {
      entry = { key, references: 0, operations: 0, drain: [], timer: null, session: null, abort: new AbortController(), checking: null }
      this.entries.set(key, entry)
      entry.opening = this.ssh.openInteractiveSession(connectionUrl, { authentication, credential, transport: settings, signal: entry.abort.signal, onDiagnostic: event => this.diagnostic(event) }).then(session => {
        entry.session = session
        entry.checkedAt = Date.now()
        return session
      }).catch(error => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw error
      })
    } else { this.counters.reuseHits++; this.diagnostic({ type: 'reuse' }) }
    clearTimeout(entry.timer)
    entry.references++
    let cancelled
    const cancellation = signal && new Promise((resolve, reject) => {
      cancelled = () => reject(signal.reason ?? new Error('SSH acquisition cancelled'))
      signal.addEventListener('abort', cancelled, { once: true })
    })
    try {
      const session = await (cancellation ? Promise.race([entry.opening, cancellation]) : entry.opening)
      if (this.closed) throw new Error('SSH session manager is closed')
      if (session.closed) throw new Error('SSH session is closed')
      if (session.multiplexed !== false && session.check && !entry.checkedAt) {
        entry.checking ??= session.check().then(healthy => healthy ? undefined : session.reconnect()).finally(() => { entry.checking = null })
        await entry.checking
        entry.checkedAt = Date.now()
      }
      signal?.throwIfAborted()
      return this.lease(entry, settings)
    } catch (error) {
      await this.release(entry, settings, !entry.session)
      throw error
    } finally { if (cancelled) signal.removeEventListener('abort', cancelled) }
  }

  lease (entry, settings) {
    let released = false
    let operations = 0
    const drain = []
    const ssh = new Proxy(entry.session.ssh, {
      get: (target, property) => {
        const value = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        return async (...args) => {
          if (released || this.closed) throw new Error('SSH session lease is closed')
          operations++; entry.operations++
          try { return await value.apply(target, args) } finally {
            operations--; entry.operations--
            if (!operations) for (const resolve of drain.splice(0)) resolve()
            if (!entry.operations) for (const resolve of entry.drain.splice(0)) resolve()
          }
        }
      }
    })
    let closing
    return {
      ssh,
      get closed () { return released },
      close: () => {
        if (closing) return closing
        released = true
        closing = (async () => {
          if (operations) await new Promise(resolve => drain.push(resolve))
          await this.release(entry, settings)
        })()
        return closing
      }
    }
  }

  async release (entry, settings, discard = false) {
    entry.references--
    if (entry.references || entry.operations || this.closed) return
    entry.checkedAt = null
    if (discard || entry.session?.multiplexed === false || settings.idleTimeoutSeconds === 0) return this.remove(entry)
    entry.timer = setTimeout(() => { this.remove(entry).catch(() => {}) }, settings.idleTimeoutSeconds * 1000)
    entry.timer.unref()
  }

  async remove (entry) {
    if (entry.removing) return entry.removing
    entry.removing = this.removeOwned(entry)
    return entry.removing
  }

  async removeOwned (entry) {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    clearTimeout(entry.timer)
    entry.abort.abort(new Error('SSH connection no longer needed'))
    try {
      const session = await entry.opening
      if (entry.operations) await new Promise(resolve => entry.drain.push(resolve))
      await session.close()
    } catch (error) {
      if (entry.session) { this.diagnostic({ type: 'cleanup-failed' }); throw error }
    }
  }

  async close () {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = Promise.allSettled([...this.entries.values()].map(entry => this.remove(entry))).then(results => {
      this.identityKey.fill(0)
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'SSH cleanup failed')
    })
    return this.closing
  }
}
