import { AdminService } from './admin-service.js'
import { CodexPlanner } from './codex-planner.js'
import { Stage2Service } from './stage2-service.js'

export class HostSessionFactory {
  constructor ({ dataRoot, settingsStore, workspace, baseSsh, debug = false, onWarning = () => {}, onDebug = () => {} }) {
    this.dataRoot = dataRoot
    this.settingsStore = settingsStore
    this.workspace = workspace
    this.baseSsh = baseSsh
    this.debug = debug
    this.onWarning = onWarning
    this.onDebug = onDebug
  }

  async open ({ settings, passphrase, serverId, requireActive = false, onProgress = () => {} }) {
    const server = await this.settingsStore.decryptServer({ settings, passphrase, serverId })
    onProgress({ phase: 'ssh', state: 'started', message: 'Opening an authenticated OpenSSH session...' })
    const session = await this.openSsh(server)
    try {
      onProgress({ phase: 'ssh', state: 'completed', message: 'SSH connected.' })
      onProgress({ phase: 'identity', state: 'started', message: 'Verifying the remote host identity...' })
      const fingerprint = await session.ssh.hostFingerprint(server.connectionUrl)
      const configured = settings.servers[serverId]
      const historyId = await this.settingsStore.registerHostFingerprint({
        settings,
        serverId,
        fingerprint,
        preferredHistoryId: configured.historyId ?? serverId
      })
      this.workspace.setDirectoryAlias(serverId, historyId)
      server.hostFingerprint = fingerprint
      server.historyId = historyId
      onProgress({ phase: 'identity', state: 'completed', message: 'Remote host identity verified and history linked.' })
      const stage2 = new Stage2Service({
        ssh: session.ssh,
        debug: this.debug,
        onDebug: event => this.onDebug(serverId, event)
      })
      if (requireActive) {
        onProgress({ phase: 'stage2', state: 'started', message: 'Checking Stage 2 plugin health...' })
        const observed = await stage2.probe(server)
        if (observed.status !== 'active') throw new Error(`Stage 2 is ${observed.status}`)
        onProgress({ phase: 'stage2', state: 'completed', message: 'Stage 2 plugin health is active.' })
      }
      const admin = new AdminService({
        dataRoot: this.dataRoot,
        ssh: session.ssh,
        settings: this.settingsStore,
        workspace: this.workspace,
        stage2,
        planner: new CodexPlanner()
      })
      return { serverId, server, session, ssh: session.ssh, stage2, admin }
    } catch (error) {
      onProgress({ phase: 'connection', state: 'failed', message: error.message })
      await session.close()
      throw error
    }
  }

  async openSsh (server) {
    if (server.sshCredential) {
      try {
        return await this.baseSsh.openInteractiveSession(server.connectionUrl, {
          authentication: server.authentication ?? 'auto',
          credential: server.sshCredential
        })
      } catch (error) {
        this.onWarning(`The saved SSH credential did not authenticate (${error.message}). Retrying with the normal OpenSSH prompt.`)
      }
    }
    return this.baseSsh.openInteractiveSession(server.connectionUrl, {
      authentication: server.authentication ?? 'auto'
    })
  }
}
