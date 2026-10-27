import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSshConnection, sshTarget } from './connection.js'
import { runInteractiveProcess, runProcess } from './process-runner.js'
import { setTimeout as delay } from 'node:timers/promises'
import { SshSessionManager, normalizeSshTransport } from './ssh-session-manager.js'

const SAFE_UNIX_REMOTE_COPY_PATH = /^\/tmp\/webminai\.[A-Za-z0-9]+\/[A-Za-z0-9._-]+$/
const SAFE_WINDOWS_REMOTE_COPY_PATH = /^C:\/Windows\/Temp\/webminai\.[A-Za-z0-9]+\/[A-Za-z0-9._-]+$/i

export class SshCommandError extends Error {
  constructor (message, result) {
    super(message)
    this.name = 'SshCommandError'
    this.result = result
  }
}

export class SystemSsh {
  constructor ({
    runner = runProcess,
    interactiveRunner = runInteractiveProcess,
    sshBinary = 'ssh',
    scpBinary = 'scp',
    controlPath = null,
    recover = null,
    reconnectDelayMs = 1000,
    transport,
    platform = process.platform,
    onDiagnostic = () => {},
    beforeChannel = async () => {},
    authentication = 'auto',
    credential = null,
    terminalCheck = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)
  } = {}) {
    if (!Number.isInteger(reconnectDelayMs) || reconnectDelayMs < 0 || reconnectDelayMs > 10000) throw new TypeError('invalid SSH reconnect delay')
    this.runner = runner
    this.interactiveRunner = interactiveRunner
    this.sshBinary = sshBinary
    this.scpBinary = scpBinary
    this.controlPath = controlPath
    this.recover = recover
    this.reconnectDelayMs = reconnectDelayMs
    this.terminalCheck = terminalCheck
    this.transport = normalizeSshTransport(transport)
    this.platform = platform
    this.onDiagnostic = onDiagnostic
    this.beforeChannel = beforeChannel
    this.authentication = authentication
    this.credential = credential
  }

  async acquireSession (connectionUrl, options) {
    this.sessions ??= new SshSessionManager({ ssh: this, onDiagnostic: this.onDiagnostic })
    return this.sessions.acquire(connectionUrl, options)
  }

  async closeSessions () { await this.sessions?.close() }

  async connectionIdentity (connectionUrl, { authentication, transport }) {
    const connection = parseSshConnection(connectionUrl)
    const result = await this.runner(this.sshBinary, ['-G', ...baseArguments(connection, null, transport), sshTarget(connection)], { timeoutMs: 10000 })
    if (result.code !== 0 || !/^hostname\s+/mu.test(result.stdout ?? '') || !/^user\s+/mu.test(result.stdout ?? '')) return null
    const files = []
    for (const line of result.stdout.split('\n')) {
      if (!/^(?:identityfile|certificatefile) /u.test(line)) continue
      const file = line.slice(line.indexOf(' ') + 1).replace(/^~(?=\/)/u, os.homedir())
      if (file.includes('%')) return null
      try {
        const info = await stat(file)
        if (!info.isFile() || info.size > 1024 * 1024) return null
        files.push([file, createHash('sha256').update(await readFile(file)).digest('hex')])
      } catch (error) { if (error.code !== 'ENOENT') return null; files.push([file, null]) }
    }
    let agent = null
    const configuredAgent = result.stdout.match(/^identityagent (.+)$/mu)?.[1]
    const agentSocket = configuredAgent === 'none' ? null : !configuredAgent || configuredAgent === 'SSH_AUTH_SOCK' ? process.env.SSH_AUTH_SOCK : configuredAgent.replace(/^~(?=\/)/u, os.homedir())
    if (agentSocket && /[%$]/u.test(agentSocket)) return null
    if (process.env.KRB5CCNAME) return null
    if (agentSocket && authentication !== 'password') {
      const binary = path.isAbsolute(this.sshBinary) ? path.join(path.dirname(this.sshBinary), 'ssh-add') : 'ssh-add'
      const keys = await this.runner(binary, ['-L'], { timeoutMs: 5000, env: { ...process.env, SSH_AUTH_SOCK: agentSocket } }).catch(() => null)
      if (!keys || ![0, 1].includes(keys.code)) return null
      agent = [agentSocket, keys.stdout]
    }
    return [connection, result.stdout, files, agent, this.sshBinary, this.scpBinary, this.platform]
  }

  async execute (connectionUrl, remoteCommand, options = {}) {
    assertFixedRemoteCommand(remoteCommand)
    const connection = parseSshConnection(connectionUrl)
    await this.beforeChannel(options.onRecovery, connectionUrl)
    const prompting = !this.controlPath && (this.credential !== null || this.promptAuthentication)
    const args = baseArguments(connection, this.controlPath, { ...this.transport, batchMode: prompting ? 'no' : 'yes' })
    if (prompting) args.push(...authenticationArguments(this.authentication))
    args.push(sshTarget(connection), remoteCommand)

    const { onRecovery, ...processOptions } = options
    this.onDiagnostic({ type: 'channel', kind: 'ssh' })
    const result = this.credential !== null && !this.controlPath
      ? await this.runWithAskpass(this.sshBinary, args, this.credential, processOptions)
      : await this.runner(this.sshBinary, args, processOptions)
    let reconnected = false
    if ((result.code === 255 || (result.code === null && result.signal)) && this.recover) {
      try { await this.recover(onRecovery); reconnected = true } catch (error) { error.recoveryExhausted = true; throw error }
    }
    if (result.code !== 0) {
      const error = new SshCommandError(`SSH command failed with exit code ${result.code}`, result)
      error.reconnected = reconnected
      throw error
    }
    return result
  }

  async copy (connectionUrl, localPath, remotePath, options = {}) {
    if (!SAFE_UNIX_REMOTE_COPY_PATH.test(remotePath) && !SAFE_WINDOWS_REMOTE_COPY_PATH.test(remotePath)) {
      throw new TypeError('SCP destination must be inside a webminai temporary directory')
    }
    const connection = parseSshConnection(connectionUrl)
    await this.beforeChannel(options.onRecovery, connectionUrl)
    const prompting = !this.controlPath && (this.credential !== null || this.promptAuthentication)
    const transport = { ...this.transport, batchMode: prompting ? 'no' : 'yes' }
    const args = scpArguments(connection, this.controlPath, { transport })
    if (prompting) args.push(...authenticationArguments(this.authentication))
    args.push(localPath, `${sshTarget(connection)}:${remotePath}`)

    this.onDiagnostic({ type: 'channel', kind: 'scp' })
    const run = args => this.credential !== null && !this.controlPath ? this.runWithAskpass(this.scpBinary, args, this.credential, options) : this.runner(this.scpBinary, args, options)
    let result = await run(args)
    if (result.code !== 0) {
      const legacyArgs = scpArguments(connection, this.controlPath, { legacy: true, transport })
      if (prompting) legacyArgs.push(...authenticationArguments(this.authentication))
      legacyArgs.push(localPath, `${sshTarget(connection)}:${remotePath}`)
      result = await run(legacyArgs)
      if (result.code !== 0) {
        throw new SshCommandError(`SCP failed with exit code ${result.code}`, result)
      }
    }
    return result
  }

  async openInteractiveSession (connectionUrl, { authentication = 'auto', credential = null, transport = this.transport, signal, onDiagnostic = this.onDiagnostic } = {}) {
    transport = normalizeSshTransport(transport)
    authenticationArguments(authentication)
    if (credential !== null) validateCredential(credential)
    if (credential === null && !this.terminalCheck()) {
      throw new Error('interactive SSH authentication requires a terminal')
    }
    signal?.throwIfAborted()
    if (!transport.multiplexing || this.platform === 'win32') return this.openDirectSession(connectionUrl, { authentication, credential, transport, signal, onDiagnostic })
    const connection = parseSshConnection(connectionUrl)
    let directory = await mkdtemp(path.join(os.tmpdir(), 'wmai-ssh-'))
    if (Buffer.byteLength(path.join(directory, 'control')) > 100) {
      await rm(directory, { recursive: true, force: true })
      directory = await mkdtemp('/tmp/wmai-ssh-')
    }
    await chmod(directory, 0o700)
    const ownership = await privateDirectory(directory)
    const controlPath = path.join(directory, 'control')
    const args = masterArguments(connection, controlPath, authentication, {
      strictHostKeyChecking: credential === null ? 'ask' : 'yes', transport
    })
    args.push(sshTarget(connection))
    const started = performance.now()

    try {
      const result = credential === null
        ? await this.interactiveRunner(this.sshBinary, args, { signal })
        : await this.runWithAskpass(this.sshBinary, args, credential, { signal })
      if (result.code !== 0) {
        throw new SshCommandError(`SSH authentication failed with exit code ${result.code}`, result)
      }
      const session = new InteractiveSshSession({
        connectionUrl,
        directory,
        controlPath,
        authentication,
        credential,
        parent: this,
        transport,
        ownership,
        onDiagnostic
      })
      const ssh = new SystemSsh({
        runner: this.runner,
        interactiveRunner: this.interactiveRunner,
        sshBinary: this.sshBinary,
        scpBinary: this.scpBinary,
        controlPath,
        recover: onRecovery => session.reconnect(onRecovery),
        terminalCheck: this.terminalCheck,
        transport,
        platform: this.platform,
        onDiagnostic,
        beforeChannel: async (onRecovery, requestedUrl) => {
          if (JSON.stringify(parseSshConnection(requestedUrl)) !== JSON.stringify(connection)) throw new Error('SSH session cannot be used for a different connection')
          await session.ensureReady(onRecovery)
        }
      })
      session.ssh = ssh
      signal?.throwIfAborted()
      onDiagnostic({ type: 'master-established', durationMs: performance.now() - started })
      return session
    } catch (error) {
      await privateDirectory(directory, ownership)
      await this.runner(this.sshBinary, ['-S', controlPath, '-O', 'exit', sshTarget(connection)], { timeoutMs: 10000 }).catch(() => {})
      await rm(directory, { recursive: true, force: true })
      if (/bad configuration option.*control|multiplex.*not supported|unix.*not supported/iu.test(error.result?.stderr ?? '')) return this.openDirectSession(connectionUrl, { authentication, credential, transport, signal, onDiagnostic })
      throw error
    }
  }

  async openDirectSession (connectionUrl, { authentication, credential, transport, signal, onDiagnostic }) {
    if (this.platform === 'win32') {
      if (!this.terminalCheck()) throw new Error('Windows SSH fallback requires a terminal for authentication')
      credential = null
    }
    const connection = parseSshConnection(connectionUrl)
    const args = baseArguments(connection, null, { ...transport, batchMode: 'no' })
    args.push(...authenticationArguments(authentication), sshTarget(connection), 'echo WEBMINAI_SSH_OK')
    const result = credential === null ? await this.interactiveRunner(this.sshBinary, args, { signal }) : await this.runWithAskpass(this.sshBinary, args, credential, { signal })
    if (result.code !== 0) throw new SshCommandError('SSH authentication failed', result)
    let closed = false
    const ssh = new SystemSsh({
      runner: this.runner,
      interactiveRunner: this.interactiveRunner,
      sshBinary: this.sshBinary,
      scpBinary: this.scpBinary,
      transport,
      authentication,
      credential,
      platform: this.platform,
      terminalCheck: this.terminalCheck,
      onDiagnostic,
      beforeChannel: async (_progress, requestedUrl) => {
        if (closed) throw new Error('SSH session is closed')
        if (JSON.stringify(parseSshConnection(requestedUrl)) !== JSON.stringify(connection)) throw new Error('SSH session cannot be used for a different connection')
      }
    })
    if (credential === null) ssh.promptAuthentication = true
    onDiagnostic({ type: 'multiplexing-unavailable' })
    return { ssh, multiplexed: false, get closed () { return closed }, async close () { closed = true; ssh.credential = null } }
  }

  async hostFingerprint (connectionUrl) {
    const posix = "case \"$(uname -s 2>/dev/null)\" in Linux) printf 'linux:'; if [ -r /etc/machine-id ]; then tr -d '[:space:]' < /etc/machine-id; else tr -d '[:space:]' < /var/lib/dbus/machine-id; fi ;; FreeBSD) printf 'freebsd:'; sysctl -n kern.hostuuid 2>/dev/null || hostid ;; Darwin) printf 'macos:'; ioreg -rd1 -c IOPlatformExpertDevice | sed -n 's/.*IOPlatformUUID.*= *\"\\([^\"]*\\)\".*/\\1/p' ;; *) exit 78 ;; esac"
    let identity
    try {
      identity = (await this.execute(connectionUrl, posix)).stdout.trim()
    } catch {
      const windows = String.raw`powershell.exe -NoProfile -NonInteractive -Command "$value=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid;Write-Output ('windows:'+$value)"`
      identity = (await this.execute(connectionUrl, windows)).stdout.trim()
    }
    if (!/^(?:freebsd|linux|macos|windows):[A-Za-z0-9._{}-]{8,256}$/u.test(identity)) {
      throw new Error('SSH host did not expose a stable machine identity for history association')
    }
    return `SHA256:${createHash('sha256').update(identity, 'utf8').digest('hex')}`
  }

  async runWithAskpass (command, args, credential, options = {}) {
    validateCredential(credential)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wmai-askpass-'))
    const credentialPath = path.join(directory, 'credential')
    const askpassPath = path.join(directory, 'askpass.sh')
    try {
      await writeFile(credentialPath, credential, { mode: 0o600, flag: 'wx' })
      await writeFile(askpassPath, '#!/bin/sh\nIFS= read -r value < "$WEBMINAI_ASKPASS_CREDENTIAL"\nprintf \'%s\\n\' "$value"\n', { mode: 0o700, flag: 'wx' })
      await chmod(directory, 0o700)
      return await this.runner(command, args, {
        ...options,
        timeoutMs: options.timeoutMs ?? 30000,
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || 'webminai:0',
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: 'force',
          WEBMINAI_ASKPASS_CREDENTIAL: credentialPath
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async interactiveShell (connectionUrl, { runner = this.interactiveRunner, browser = false } = {}) {
    if (!browser && !this.terminalCheck()) {
      throw new Error('interactive SSH shell requires a terminal')
    }
    const connection = parseSshConnection(connectionUrl)
    await this.beforeChannel(undefined, connectionUrl)
    const args = interactiveArguments(connection, this.controlPath, this.transport)
    if (browser) args.push('-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'EscapeChar=none', '-o', 'PermitLocalCommand=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes')
    args.push(sshTarget(connection))
    this.onDiagnostic({ type: 'channel', kind: 'shell' })
    const result = await runner(this.sshBinary, args)
    if (result.code !== 0) {
      throw new SshCommandError(`interactive SSH exited with code ${result.code}`, result)
    }
    return result
  }
}

class InteractiveSshSession {
  constructor ({ connectionUrl, directory, controlPath, authentication, credential, parent, transport, ownership, onDiagnostic }) {
    this.connectionUrl = connectionUrl
    this.directory = directory
    this.controlPath = controlPath
    this.authentication = authentication
    this.credential = credential
    this.parent = parent
    this.closed = false
    this.reconnecting = null
    this.ssh = null
    this.multiplexed = true
    this.transport = transport
    this.ownership = ownership
    this.onDiagnostic = onDiagnostic
    this.healthCheckedAt = Date.now()
  }

  async ensureReady (onRecovery) {
    const socketExists = await this.assertOwned()
    if (socketExists && Date.now() - this.healthCheckedAt < 30000) return
    this.checking ??= this.check().then(healthy => healthy ? undefined : this.reconnect(onRecovery)).finally(() => { this.checking = null })
    await this.checking
  }

  async assertOwned () {
    if (this.closed) throw new Error('SSH session is closed')
    await privateDirectory(this.directory, this.ownership)
    return privateSocket(this.controlPath)
  }

  async check () {
    if (this.closed) return false
    await this.assertOwned()
    const connection = parseSshConnection(this.connectionUrl)
    const result = await this.parent.runner(this.parent.sshBinary, ['-S', this.controlPath, '-O', 'check', sshTarget(connection)], { timeoutMs: 5000 })
    this.healthCheckedAt = Date.now()
    return result.code === 0
  }

  async reconnect (onRecovery = async () => {}) {
    if (this.closed) throw new Error('SSH session is closed')
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = this.reconnectWithRetry(onRecovery)
    try {
      await this.reconnecting
    } finally {
      this.reconnecting = null
    }
  }

  async reconnectWithRetry (onRecovery) {
    if (await this.check()) { await onRecovery({ state: 'reconnected' }); return }
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.closed) throw new Error('SSH session is closed')
      await onRecovery({ state: 'reconnecting', attempt, attempts: 3 })
      try {
        await this.reconnectMaster()
        await onRecovery({ state: 'reconnected', attempt })
        return
      } catch (error) {
        const fatal = /permission denied|host key verification failed|remote host identification has changed/iu.test(error.result?.stderr ?? '')
        if (attempt === 3 || fatal) {
          await onRecovery({ state: 'operator_review_required' })
          throw error
        }
        await delay(Math.min(this.parent.reconnectDelayMs * attempt, 10000))
      }
    }
  }

  async reconnectMaster () {
    await this.assertOwned()
    const started = performance.now()
    const connection = parseSshConnection(this.connectionUrl)
    await this.parent.runner(this.parent.sshBinary, [
      '-S', this.controlPath,
      '-O', 'exit',
      sshTarget(connection)
    ], { timeoutMs: 10000 }).catch(() => {})
    await rm(this.controlPath, { force: true })
    const args = masterArguments(connection, this.controlPath, this.authentication, { strictHostKeyChecking: 'yes', transport: this.transport })
    args.push(sshTarget(connection))
    const result = this.credential === null
      ? await this.parent.runner(this.parent.sshBinary, [...args.slice(0, -1), '-o', 'BatchMode=yes', args.at(-1)], { timeoutMs: 30000 })
      : await this.parent.runWithAskpass(this.parent.sshBinary, args, this.credential)
    if (result.code !== 0) throw new SshCommandError(`SSH reconnection failed with exit code ${result.code}`, result)
    this.healthCheckedAt = Date.now()
    this.onDiagnostic({ type: 'reconnect' })
    this.onDiagnostic({ type: 'master-established', durationMs: performance.now() - started })
  }

  async close () {
    if (this.closing) return this.closing
    this.closed = true
    this.credential = null
    this.closing = this.closeMaster()
    return this.closing
  }

  async closeMaster () {
    await this.reconnecting?.catch(() => {})
    await privateDirectory(this.directory, this.ownership)
    await privateSocket(this.controlPath)
    const connection = parseSshConnection(this.connectionUrl)
    try {
      if (!this.ssh) throw new Error('SSH session transport is unavailable')
      await this.ssh.runner(this.ssh.sshBinary, [
        '-S', this.ssh.controlPath,
        '-O', 'exit',
        sshTarget(connection)
      ], { timeoutMs: 10000 })
    } finally {
      await privateDirectory(this.directory, this.ownership)
      await rm(this.directory, { recursive: true, force: true })
    }
  }
}

function baseArguments (connection, controlPath, transport = {}) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  args.push(
    '-T',
    '-o', `BatchMode=${transport.batchMode ?? 'yes'}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (controlPath) args.push('-o', `ControlPath=${controlPath}`)
  args.push('-o', `Compression=${transport.compression ? 'yes' : 'no'}`)
  return args
}

function scpArguments (connection, controlPath, { legacy = false, transport = {} } = {}) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  if (legacy) args.push('-O')
  args.push(
    '-q',
    '-o', `BatchMode=${transport.batchMode ?? 'yes'}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-P', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (controlPath) args.push('-o', `ControlPath=${controlPath}`)
  args.push('-o', `Compression=${transport.compression ? 'yes' : 'no'}`)
  return args
}

function masterArguments (connection, controlPath, authentication, { strictHostKeyChecking = 'ask', transport = {} } = {}) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  args.push(
    '-M',
    '-S', controlPath,
    '-fN',
    '-T',
    '-o', 'ControlPersist=10m',
    '-o', `StrictHostKeyChecking=${strictHostKeyChecking}`,
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  args.push('-o', `Compression=${transport.compression ? 'yes' : 'no'}`)
  args.push(...authenticationArguments(authentication))
  return args
}

function authenticationArguments (authentication) {
  const args = []
  if (authentication === 'password') {
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no')
  } else if (authentication === 'key') {
    args.push('-o', 'PreferredAuthentications=publickey')
  } else if (authentication !== 'auto') {
    throw new TypeError('authentication must be auto, key, or password')
  }
  return args
}

function interactiveArguments (connection, controlPath, transport = {}) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  args.push(
    '-tt',
    '-o', 'StrictHostKeyChecking=yes',
    '-p', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (controlPath) args.push('-o', `ControlPath=${controlPath}`)
  args.push('-o', `Compression=${transport.compression ? 'yes' : 'no'}`)
  return args
}

function assertFixedRemoteCommand (command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192) {
    throw new TypeError('remote command must be a non-empty bounded string')
  }
  if (command.includes('\0') || command.includes('\r') || command.includes('\n')) {
    throw new TypeError('remote command must be a single line')
  }
}

function validateCredential (credential) {
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 4096) {
    throw new TypeError('SSH credential must be a non-empty string no longer than 4096 characters')
  }
  if (/[\0\r\n]/u.test(credential)) throw new TypeError('SSH credential contains unsupported control characters')
}

async function privateDirectory (directory, expected) {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid()) || (expected && (info.dev !== expected.dev || info.ino !== expected.ino || info.uid !== expected.uid))) throw new Error('unsafe SSH control directory ownership or permissions')
  return { dev: info.dev, ino: info.ino, uid: info.uid }
}

async function privateSocket (controlPath) {
  try {
    const socket = await lstat(controlPath)
    if (socket.isSymbolicLink() || !socket.isSocket() || (process.getuid && socket.uid !== process.getuid())) throw new Error('unsafe SSH control socket')
    return true
  } catch (error) { if (error.code !== 'ENOENT') throw error; return false }
}
