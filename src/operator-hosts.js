import { parseSshCommand } from './ssh-command.js'
import { validateServerId } from './server-id.js'
import { rootExecutionPolicy } from './execution-policy.js'
import { withHostMutation, assertHostMutationReady } from './host-mutation-ownership.js'
import { planFingerprint } from './execution-journal.js'

export class OperatorHosts {
  constructor ({ factory, settingsStore, workspace, settings, tasks, passphrase, credential, notify = () => {} }) {
    Object.assign(this, { factory, settingsStore, workspace, settings, tasks, passphrase, credential, notify })
    this.sessions = new Map(); this.connecting = new Map(); this.states = new Map(); this.prompt = Promise.resolve(); this.closing = false
  }

  terminal (hostId, operation) {
    const promise = this.prompt.catch(() => {}).then(async () => {
      this.notify({ type: 'terminal_input', hostId, state: 'may-require-input', message: 'Check the launch terminal for SSH or elevation prompts' })
      try { return await operation() } finally { this.notify({ type: 'terminal_input', hostId, state: 'finished' }) }
    })
    this.prompt = promise.catch(() => {})
    return promise
  }

  async connect (hostId) {
    if (this.closing) throw new Error('Host sessions are shutting down')
    if (this.connecting.has(hostId)) return this.connecting.get(hostId)
    if (this.sessions.has(hostId)) return this.sessions.get(hostId)
    const promise = this.terminal(hostId, async () => {
      this.states.set(hostId, { connection: 'connecting' })
      try {
        const session = await this.factory.open({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, requireActive: false, onProgress: event => this.notify({ ...event, type: 'host_connection', hostId }) })
        this.sessions.set(hostId, { ...session, references: 0 })
        const capabilities = await session.admin.capabilities({ settings: this.settings, passphrase: this.passphrase, serverId: hostId })
        const observed = await session.stage2.probe(session.server)
        this.states.set(hostId, { connection: 'connected', platform: capabilities.platform, capabilities, stage2: observed.status, observedAt: new Date().toISOString() })
        return this.sessions.get(hostId)
      } catch {
        const opened = this.sessions.get(hostId)
        this.sessions.delete(hostId)
        try { await opened?.session.close() } catch {}
        this.states.set(hostId, { connection: 'error', message: 'Connection failed; inspect launch terminal and configured identity' })
        throw new Error('Host connection failed; inspect the launch terminal')
      }
    }).finally(() => this.connecting.delete(hostId))
    this.connecting.set(hostId, promise)
    return promise
  }

  async lease (hostId) {
    const opened = await this.connect(hostId)
    opened.references++
    let released = false
    return { admin: opened.admin, close: () => { if (!released) { released = true; opened.references--; if ([...this.sessions.values()].every(session => !session.references)) this.drained?.() } } }
  }

  async action (body) {
    const { hostId } = body
    validateServerId(hostId)
    if (body.action === 'host-add' || body.action === 'host-edit') {
      if (typeof body.connection !== 'string' || body.connection.length > 2048 || !['auto', 'key', 'password'].includes(body.authentication ?? 'auto')) throw new Error('Invalid SSH connection')
      const connectionUrl = parseSshCommand(body.connection)
      if (body.action === 'host-add' && this.settings.servers[hostId]) throw new Error('Host already exists')
      if (this.sessions.get(hostId)?.references || this.connecting.has(hostId)) throw new Error('Host is busy')
      return this.terminal(hostId, async () => {
        if (body.action === 'host-edit') this.checkVersion(body)
        const old = this.settings.servers[hostId]
        if (body.action === 'host-add' && old) throw new Error('Host already exists')
        if (body.action === 'host-edit' && !old) throw new Error('Unknown host')
        const session = await this.factory.openSsh({ connectionUrl, authentication: body.authentication ?? 'auto' })
        try {
          const hostFingerprint = await session.ssh.hostFingerprint(connectionUrl)
          const admin = this.sessions.get(hostId)?.admin
          if (old && admin?.tasks.interruptedTasks(hostId).length) throw new Error('Inspect interrupted work before editing its connection')
          return await this.configure(hostId, async () => {
            await this.disconnect(hostId)
            if (old) delete this.settings.servers[hostId]
            try {
              const method = body.temporary ? 'addTemporaryServer' : 'addServer'
              await this.settingsStore[method]({ settings: this.settings, passphrase: this.passphrase, serverId: hostId, connectionUrl, authentication: body.authentication ?? 'auto', hostFingerprint })
            } catch (error) { if (old) this.settings.servers[hostId] = old; throw error }
            const historyId = this.settings.servers[hostId].historyId
            this.workspace.setDirectoryAlias(hostId, historyId)
            await this.workspace.ensureInitialized(hostId, rootExecutionPolicy())
            return { hostId, verified: true, historyRetained: true, stage2: 'inactive', message: 'Identity verified; Stage 2 authorization must be activated for this connection' }
          })
        } finally { await session.close() }
      })
    }
    if (!Object.hasOwn(this.settings.servers, hostId)) throw new Error('Unknown host')
    if (body.action === 'host-connect') { await this.connect(hostId); return this.states.get(hostId) }
    if (body.action === 'host-disconnect') return this.disconnect(hostId)
    if (body.action === 'host-remove') {
      return this.configure(hostId, async () => {
        this.checkVersion(body)
        await this.disconnect(hostId)
        await this.settingsStore.removeServer({ settings: this.settings, serverId: hostId })
        return { hostId, removed: true, remoteSoftwareRemoved: false, historyRetained: true }
      })
    }
    if (['stage2-activate', 'stage2-update', 'stage2-deactivate'].includes(body.action)) {
      const lease = await this.lease(hostId)
      try {
        return await this.terminal(hostId, async () => {
          const args = { settings: this.settings, passphrase: this.passphrase, serverId: hostId }
          const capabilities = await lease.admin.capabilities(args)
          const elevation = await this.credential(capabilities)
          if (!elevation) throw new Error('Operator cancelled elevation')
          this.checkVersion(body)
          const result = body.action === 'stage2-deactivate' ? await lease.admin.deactivate({ ...args, ...elevation }) : await lease.admin.activate({ ...args, ...elevation, installNetdata: body.action === 'stage2-activate' })
          this.states.set(hostId, { ...this.states.get(hostId), stage2: body.action === 'stage2-deactivate' ? 'inactive' : 'active' })
          return result
        })
      } finally { await lease.close() }
    }
    throw new Error('Unsupported host action')
  }

  async disconnect (hostId) {
    if (this.connecting.has(hostId) || this.sessions.get(hostId)?.references) throw new Error('Host has active work; pause remaining work and wait for the current command before disconnecting')
    const opened = this.sessions.get(hostId)
    await opened?.session.close()
    this.sessions.delete(hostId)
    this.states.set(hostId, { connection: 'disconnected' })
    return { hostId, connection: 'disconnected' }
  }

  configure (hostId, operation) {
    return withHostMutation({ dataRoot: this.settingsStore.dataRoot, identity: this.settings.servers[hostId]?.historyId ?? hostId, before: this.tasks && this.settings.servers[hostId] ? () => assertHostMutationReady({ settingsStore: this.settingsStore, tasks: this.tasks, settings: this.settings, serverId: hostId }) : undefined }, operation)
  }

  checkVersion (body) {
    if (body.hostVersion !== planFingerprint(this.settings.servers[body.hostId])) throw new Error('Host settings changed; review the current host before approval')
  }

  async close () {
    this.closing = true
    await Promise.allSettled([...this.connecting.values()])
    if ([...this.sessions.values()].some(session => session.references)) {
      let timer
      await Promise.race([new Promise(resolve => { this.drained = resolve }), new Promise(resolve => { timer = setTimeout(resolve, 35000) })])
      clearTimeout(timer)
    }
    for (const [id, opened] of this.sessions) { await opened.session.close(); this.sessions.delete(id) }
    for (const id of [...this.settingsStore.temporaryServerIds]) await this.settingsStore.removeServer({ settings: this.settings, serverId: id })
  }
}
