import { existsSync } from 'node:fs'
import path from 'node:path'

const TEMP_DIRECTORY = /^\/tmp\/webminai\.[A-Za-z0-9]+$/
const WINDOWS_TEMP_DIRECTORY = /^C:\/Windows\/Temp\/webminai\.[A-Za-z0-9]+$/i
const CREATE_TEMP = 'umask 077; mktemp -d /tmp/webminai.XXXXXXXX'
const PLATFORM_CHECK = "printf 'system=%s\\nmachine=%s\\n' \"$(uname -s)\" \"$(uname -m)\""
const WINDOWS_PLATFORM_CHECK = powershellCommand("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Write-Output 'system=Windows_NT';Write-Output ('machine=' + $env:PROCESSOR_ARCHITECTURE)")

export async function createRemoteTemporaryDirectory ({ ssh, connectionUrl, platform = 'unix' }) {
  const command = platform === 'windows'
    ? powershellCommand("$p=Join-Path $env:WINDIR ('Temp\\webminai.'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $p | Out-Null;Write-Output ($p.Replace('\\','/'))")
    : CREATE_TEMP
  const result = await ssh.execute(connectionUrl, command)
  const directory = result.stdout.trim()
  const safe = platform === 'windows' ? WINDOWS_TEMP_DIRECTORY.test(directory) : TEMP_DIRECTORY.test(directory)
  if (!safe) throw new Error('remote host returned an unsafe temporary path')
  return directory
}

export async function removeRemoteTemporaryDirectory ({ ssh, connectionUrl, directory, trace = (_phase, _message) => {} }) {
  const windows = WINDOWS_TEMP_DIRECTORY.test(directory)
  if (!TEMP_DIRECTORY.test(directory) && !windows) throw new Error('refusing to remove an unsafe remote path')
  try {
    const command = windows
      ? powershellCommand(`Remove-Item -LiteralPath '${directory}' -Recurse -Force -ErrorAction SilentlyContinue`)
      : `rm -rf -- '${directory}'`
    await ssh.execute(connectionUrl, command)
  } catch (error) {
    trace('cleanup', `Temporary directory cleanup failed: ${error.message}`)
  }
}

export async function detectPlatform ({ ssh, connectionUrl }) {
  let result
  try {
    result = await ssh.execute(connectionUrl, PLATFORM_CHECK)
  } catch {
    result = await ssh.execute(connectionUrl, WINDOWS_PLATFORM_CHECK)
  }
  return normalizeRemotePlatform(parseKeyValues(result.stdout))
}

export async function selectPluginArtifact ({ ssh, connectionUrl, pluginPath, pluginPaths }) {
  if (pluginPath) return { path: pluginPath, key: 'explicit', platform: null }
  const platform = await detectPlatform({ ssh, connectionUrl })
  const key = `${platform.os}-${platform.architecture}`
  const artifact = pluginPaths[key]
  if (!artifact) throw new Error(`no Intent AI Ops plugin artifact is configured for ${platform.system} ${platform.machine} (${key})`)
  if (!existsSync(artifact)) {
    const hint = platform.os === 'freebsd'
      ? 'build it on the matching FreeBSD architecture with npm run build:plugin:freebsd'
      : platform.os === 'windows'
        ? 'run npm run build:plugin:windows'
        : platform.os === 'macos'
          ? 'build it on the matching macOS architecture with npm run build:plugin:macos'
          : 'run npm run build:plugin on this architecture'
    throw new Error(`Intent AI Ops plugin artifact is missing for ${platform.system} ${platform.machine}: ${artifact}; ${hint}`)
  }
  return { path: path.resolve(artifact), key, platform }
}

export function parseKeyValues (stdout) {
  return Object.fromEntries(stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const separator = line.indexOf('=')
    if (separator < 1) return [line.trim(), '']
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }))
}

/** @param {Record<string, string>} values @param {{rejectUnsupported?: boolean}} [options] */
export function normalizeRemotePlatform ({ system, machine }, { rejectUnsupported = true } = {}) {
  const os = { Linux: 'linux', FreeBSD: 'freebsd', Darwin: 'macos', Windows_NT: 'windows' }[system]
  const architecture = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64', AMD64: 'amd64' }[machine]
  if (rejectUnsupported && !os) throw new Error(`unsupported Stage 2 operating system: ${system || 'unknown'}`)
  if (rejectUnsupported && !architecture) throw new Error(`unsupported Stage 2 architecture: ${machine || 'unknown'}`)
  return { os: os ?? 'unsupported', architecture: architecture ?? 'unsupported', system: system ?? 'unknown', machine: machine ?? 'unknown', supported: Boolean(os && architecture) }
}

export function powershellCommand (script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}
