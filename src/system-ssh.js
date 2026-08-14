import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSshConnection, sshTarget } from './connection.js'
import { runInteractiveProcess, runProcess } from './process-runner.js'

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
    terminalCheck = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)
  } = {}) {
    this.runner = runner
    this.interactiveRunner = interactiveRunner
    this.sshBinary = sshBinary
    this.scpBinary = scpBinary
    this.controlPath = controlPath
    this.recover = recover
    this.terminalCheck = terminalCheck
  }

  async execute (connectionUrl, remoteCommand, options = {}) {
    assertFixedRemoteCommand(remoteCommand)
    const connection = parseSshConnection(connectionUrl)
    const args = baseArguments(connection, this.controlPath)
    args.push(sshTarget(connection), remoteCommand)

    const result = await this.runner(this.sshBinary, args, options)
    if (result.code === 255 && this.recover) {
      await this.recover()
    }
    if (result.code !== 0) {
      throw new SshCommandError(`SSH command failed with exit code ${result.code}`, result)
    }
    return result
  }

  async copy (connectionUrl, localPath, remotePath, options = {}) {
    if (!SAFE_UNIX_REMOTE_COPY_PATH.test(remotePath) && !SAFE_WINDOWS_REMOTE_COPY_PATH.test(remotePath)) {
      throw new TypeError('SCP destination must be inside a webminai temporary directory')
    }
    const connection = parseSshConnection(connectionUrl)
    const args = scpArguments(connection, this.controlPath)
    args.push(localPath, `${sshTarget(connection)}:${remotePath}`)

    let result = await this.runner(this.scpBinary, args, options)
    if (result.code !== 0) {
      const legacyArgs = scpArguments(connection, this.controlPath, { legacy: true })
      legacyArgs.push(localPath, `${sshTarget(connection)}:${remotePath}`)
      result = await this.runner(this.scpBinary, legacyArgs, options)
      if (result.code !== 0) {
        throw new SshCommandError(`SCP failed with exit code ${result.code}`, result)
      }
    }
    return result
  }

  async openInteractiveSession (connectionUrl, { authentication = 'auto', credential = null } = {}) {
    if (!this.terminalCheck()) {
      throw new Error('interactive SSH authentication requires a terminal')
    }
    const connection = parseSshConnection(connectionUrl)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wmai-ssh-'))
    const controlPath = path.join(directory, 'control')
    const args = masterArguments(connection, controlPath, authentication, {
      strictHostKeyChecking: credential === null ? 'ask' : 'yes'
    })
    args.push(sshTarget(connection))

    try {
      const result = credential === null
        ? await this.interactiveRunner(this.sshBinary, args)
        : await this.runWithAskpass(this.sshBinary, args, credential)
      if (result.code !== 0) {
        throw new SshCommandError(`SSH authentication failed with exit code ${result.code}`, result)
      }
      const session = new InteractiveSshSession({
        connectionUrl,
        directory,
        controlPath,
        authentication,
        credential,
        parent: this
      })
      const ssh = new SystemSsh({
        runner: this.runner,
        interactiveRunner: this.interactiveRunner,
        sshBinary: this.sshBinary,
        scpBinary: this.scpBinary,
        controlPath,
        recover: () => session.reconnect(),
        terminalCheck: this.terminalCheck
      })
      session.ssh = ssh
      return session
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
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

  async runWithAskpass (command, args, credential) {
    validateCredential(credential)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wmai-askpass-'))
    const credentialPath = path.join(directory, 'credential')
    const askpassPath = path.join(directory, 'askpass.sh')
    try {
      await writeFile(credentialPath, credential, { mode: 0o600, flag: 'wx' })
      await writeFile(askpassPath, '#!/bin/sh\nIFS= read -r value < "$WEBMINAI_ASKPASS_CREDENTIAL"\nprintf \'%s\\n\' "$value"\n', { mode: 0o700, flag: 'wx' })
      await chmod(directory, 0o700)
      return await this.runner(command, args, {
        timeoutMs: 30000,
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

  async interactiveShell (connectionUrl) {
    if (!this.terminalCheck()) {
      throw new Error('interactive SSH shell requires a terminal')
    }
    const connection = parseSshConnection(connectionUrl)
    const args = interactiveArguments(connection, this.controlPath)
    args.push(sshTarget(connection))
    const result = await this.interactiveRunner(this.sshBinary, args)
    if (result.code !== 0) {
      throw new SshCommandError(`interactive SSH exited with code ${result.code}`, result)
    }
    return result
  }
}

class InteractiveSshSession {
  constructor ({ connectionUrl, directory, controlPath, authentication, credential, parent }) {
    this.connectionUrl = connectionUrl
    this.directory = directory
    this.controlPath = controlPath
    this.authentication = authentication
    this.credential = credential
    this.parent = parent
    this.closed = false
    this.reconnecting = null
    this.ssh = null
  }

  async reconnect () {
    if (this.closed) throw new Error('SSH session is closed')
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = this.reconnectMaster()
    try {
      await this.reconnecting
    } finally {
      this.reconnecting = null
    }
  }

  async reconnectMaster () {
    const connection = parseSshConnection(this.connectionUrl)
    await this.parent.runner(this.parent.sshBinary, [
      '-S', this.controlPath,
      '-O', 'exit',
      sshTarget(connection)
    ], { timeoutMs: 10000 }).catch(() => {})
    await rm(this.controlPath, { force: true })
    const args = masterArguments(connection, this.controlPath, this.authentication, { strictHostKeyChecking: 'yes' })
    args.push(sshTarget(connection))
    const result = this.credential === null
      ? await this.parent.runner(this.parent.sshBinary, [...args.slice(0, -1), '-o', 'BatchMode=yes', args.at(-1)], { timeoutMs: 30000 })
      : await this.parent.runWithAskpass(this.parent.sshBinary, args, this.credential)
    if (result.code !== 0) throw new SshCommandError(`SSH reconnection failed with exit code ${result.code}`, result)
  }

  async close () {
    if (this.closed) return
    this.closed = true
    this.credential = null
    const connection = parseSshConnection(this.connectionUrl)
    try {
      if (!this.ssh) throw new Error('SSH session transport is unavailable')
      await this.ssh.runner(this.ssh.sshBinary, [
        '-S', this.ssh.controlPath,
        '-O', 'exit',
        sshTarget(connection)
      ], { timeoutMs: 10000 })
    } finally {
      await rm(this.directory, { recursive: true, force: true })
    }
  }
}

function baseArguments (connection, controlPath) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  args.push(
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (controlPath) args.push('-o', `ControlPath=${controlPath}`)
  return args
}

function scpArguments (connection, controlPath, { legacy = false } = {}) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  if (legacy) args.push('-O')
  args.push(
    '-q',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-P', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (controlPath) args.push('-o', `ControlPath=${controlPath}`)
  return args
}

function masterArguments (connection, controlPath, authentication, { strictHostKeyChecking = 'ask' } = {}) {
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
  if (authentication === 'password') {
    args.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no')
  } else if (authentication === 'key') {
    args.push('-o', 'PreferredAuthentications=publickey')
  } else if (authentication !== 'auto') {
    throw new TypeError('authentication must be auto, key, or password')
  }
  return args
}

function interactiveArguments (connection, controlPath) {
  const args = []
  if (connection.configFile) args.push('-F', connection.configFile)
  args.push(
    '-tt',
    '-o', 'StrictHostKeyChecking=yes',
    '-p', String(connection.port)
  )
  if (connection.identityFile) args.push('-i', connection.identityFile)
  if (controlPath) args.push('-o', `ControlPath=${controlPath}`)
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
