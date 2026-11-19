import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSshConnection } from './connection.js'

export async function promptSshKey (ui, connectionUrl, authentication) {
  const identity = parseSshConnection(connectionUrl).identityFile
  let missing = false
  if (identity && authentication !== 'password') {
    try { await access(identity) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      missing = true
    }
  }
  if (!missing && authentication !== 'paste-key') return null
  const pasted = await ui.secretEditor(missing ? 'SSH identity file not found. Paste private key' : 'Paste SSH private key')
  if (!pasted) throw new Error('SSH key entry cancelled')
  return normalizeSshKey(pasted)
}

export function normalizeSshKey (value) {
  if (typeof value !== 'string' || value.length > 65536) throw new Error('Invalid SSH private key format')
  const key = value.replace(/\r\n/g, '\n').trim()
  if (!/^-----BEGIN ((?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY)-----\n[A-Za-z0-9+/=\n]+\n-----END \1-----$/u.test(key)) throw new Error('Invalid SSH private key format')
  return key + '\n'
}

export async function openVaultKeySession (baseSsh, connectionUrl, privateKey, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-ssh-key-'))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  try {
    if (process.platform === 'win32') {
      const script = "$ErrorActionPreference='Stop';$p=$env:INTENT_KEY_DIR;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl"
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, INTENT_KEY_DIR: directory }, timeout: 10000, windowsHide: true })
    }
    const filename = path.join(directory, 'identity')
    await writeFile(filename, normalizeSshKey(privateKey), { mode: 0o600, flag: 'wx' })
    const url = new URL(connectionUrl)
    url.searchParams.set('identity', filename)
    const effectiveUrl = url.href
    const open = baseSsh.openInteractiveSession ?? baseSsh.acquireSession
    const session = await open.call(baseSsh, effectiveUrl, { ...options, authentication: 'key' })
    return {
      multiplexed: session.multiplexed,
      ssh: new Proxy(session.ssh, {
        get (target, key) {
          const value = target[key]
          return typeof value === 'function' ? (...args) => value.apply(target, args[0] === connectionUrl ? [effectiveUrl, ...args.slice(1)] : args) : value
        }
      }),
      async close () { try { await session.close() } finally { await cleanup() } }
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
