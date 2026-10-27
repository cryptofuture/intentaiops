import { randomUUID, createHash } from 'node:crypto'
import { planFingerprint } from './execution-journal.js'

const limit = 512 * 1024
const environmentKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']

export class OperatorShells {
  constructor ({ hosts, settings, spawn }) {
    Object.assign(this, { hosts, settings, spawn })
    this.entries = new Map(); this.requests = new Map(); this.closing = false
  }

  list () { return [...this.entries.values()].map(entry => this.summary(entry)) }
  summary (entry) { return { id: entry.id, hostId: entry.hostId, status: entry.status, exitCode: entry.exitCode ?? null, signal: entry.signal ?? null, inputSequence: entry.inputSequence, cursor: entry.cursor } }
  get (id) { const entry = this.entries.get(id); if (!entry) throw new Error('Unknown shell'); return entry }
  dimensions ({ cols, rows }) { if (!Number.isInteger(cols) || cols < 2 || cols > 300 || !Number.isInteger(rows) || rows < 2 || rows > 150) throw new Error('Invalid terminal size'); return { cols, rows } }

  async open (body) {
    if (this.closing) throw new Error('Shell service is shutting down')
    if (body.approved !== true || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/u.test(body.requestKey)) throw new Error('Explicit shell approval and request key required')
    if (typeof body.hostId !== 'string' || !Object.hasOwn(this.settings.servers, body.hostId)) throw new Error('Unknown host')
    const dimensions = this.dimensions(body)
    const fingerprint = planFingerprint({ hostId: body.hostId, hostVersion: body.hostVersion, ...dimensions })
    const previous = this.requests.get(body.requestKey)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Shell request key conflict')
      const shell = await previous.ready
      if (!this.entries.has(shell.id)) throw new Error('Shell session expired; approve a new session')
      return this.summary(this.get(shell.id))
    }
    if (this.entries.size >= 8) {
      for (const [id, entry] of this.entries) if (entry.status === 'closed') { this.entries.delete(id); break }
      if (this.entries.size >= 8) throw new Error('Close an existing shell first')
    }
    if ([...this.entries.values()].some(entry => entry.hostId === body.hostId && entry.status !== 'closed')) throw new Error('This host already has an interactive shell')
    if (body.hostVersion !== planFingerprint(this.settings.servers[body.hostId])) throw new Error('Host settings changed; inspect the host before opening a shell')
    const entry = { id: randomUUID(), hostId: body.hostId, status: 'opening', events: [], bytes: 0, cursor: 0, inputSequence: 0 }
    this.entries.set(entry.id, entry)
    let readyResolve, readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    this.requests.set(body.requestKey, { fingerprint, ready })
    while (this.requests.size > 128) this.requests.delete(this.requests.keys().next().value)
    entry.done = this.hosts.configure(body.hostId, async () => {
      const lease = await this.hosts.lease(body.hostId)
      try {
        if (this.closing || entry.cancelled) throw new Error('Shell opening cancelled')
        if (body.hostVersion !== planFingerprint(this.settings.servers[body.hostId])) throw new Error('Host identity/settings were updated; inspect the host and approve again')
        const opened = this.hosts.sessions.get(body.hostId)
        const spawn = this.spawn ?? (await import('node-pty')).spawn
        let channel
        await this.hosts.terminal(body.hostId, async () => {
          channel = opened.ssh.interactiveShell(opened.server.connectionUrl, {
            browser: true,
            runner: (binary, args) => new Promise(resolve => {
              const env = Object.fromEntries(environmentKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
              const terminal = spawn(binary, args, { ...dimensions, name: 'xterm-256color', env })
              let exited = false
              entry.terminal = terminal; entry.status = 'running'
              terminal.onData(data => this.append(entry, { type: 'output', data }))
              terminal.onExit(result => {
                if (exited) return
                exited = true
                entry.exitCode = result.exitCode; entry.signal = result.signal ?? null
                // ConPTY retains its pipe worker after natural process exit.
                if (process.platform === 'win32') { try { terminal.kill() } catch {} }
                resolve({ code: result.exitCode })
              })
              readyResolve(this.summary(entry))
            })
          })
          channel.catch(() => readyReject(new Error('SSH shell startup failed; inspect the launch terminal and PTY availability')))
          await ready
        })
        return await channel
      } finally { await lease.close() }
    }).catch(() => {
      readyReject(new Error('Shell could not start or SSH disconnected. Check launch-terminal authentication, PTY availability and host ownership. Password-only connections require SSH multiplexing.'))
    }).finally(() => {
      entry.status = 'closed'; this.append(entry, { type: 'closed', exitCode: entry.exitCode ?? null, signal: entry.signal ?? null })
    })
    return ready
  }

  append (entry, event) {
    const size = Buffer.byteLength(JSON.stringify(event))
    if (size > 16384 && event.type === 'output') {
      for (let i = 0; i < event.data.length; i += 2048) this.append(entry, { ...event, data: event.data.slice(i, i + 2048) })
      return
    }
    entry.events.push({ ...event, id: ++entry.cursor, size }); entry.bytes += size
    while (entry.bytes > limit) entry.bytes -= entry.events.shift().size
  }

  events (id, cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid shell cursor')
    const entry = this.get(id)
    const first = entry.events[0]?.id ?? 1
    return { gap: cursor < first - 1, events: entry.events.filter(event => event.id > cursor).slice(0, 32).map(({ size, ...event }) => event), shell: this.summary(entry) }
  }

  input (body) {
    const entry = this.get(body.id)
    if (typeof body.data !== 'string' || !body.data.length || Buffer.byteLength(body.data) > 16384 || !Number.isSafeInteger(body.sequence) || body.sequence < 1) throw new Error('Invalid shell input')
    const digest = createHash('sha256').update(body.data).digest('hex')
    if (body.sequence === entry.inputSequence && digest === entry.lastInputDigest) return this.summary(entry)
    if (body.sequence !== entry.inputSequence + 1) throw new Error('Shell input conflict; reconnect this view')
    if (entry.status !== 'running') throw new Error('Shell is not running')
    entry.terminal.write(body.data)
    entry.inputSequence = body.sequence; entry.lastInputDigest = digest
    return this.summary(entry)
  }

  resize (body) { const entry = this.get(body.id); const size = this.dimensions(body); if (entry.status === 'running') entry.terminal.resize(size.cols, size.rows); return this.summary(entry) }
  async end (id) {
    const entry = this.get(id)
    entry.cancelled = true
    if (!entry.terminal) { await entry.done; return this.summary(entry) }
    if (entry.status !== 'closed') {
      try { entry.terminal.kill() } catch {}
      let timer
      await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, 5000) })]); clearTimeout(timer)
      if (entry.status !== 'closed') { try { entry.terminal.kill('SIGKILL') } catch {}; await entry.done }
    }
    return this.summary(entry)
  }

  async close () { this.closing = true; await Promise.allSettled([...this.entries.keys()].map(id => this.end(id))); this.entries.clear(); this.requests.clear() }
}
