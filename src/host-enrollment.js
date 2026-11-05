import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { powershellCommand } from './stage2-remote.js'

const scripts = {
  macos: readFileSync(new URL('../remote/host-enrollment.sh', import.meta.url), 'utf8'),
  windows: readFileSync(new URL('../remote/host-enrollment.ps1', import.meta.url), 'utf8')
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

function validId (value) { return typeof value === 'string' && UUID.test(value) && value !== '00000000-0000-0000-0000-000000000000' }

export function hostIdentityFingerprint (nativeIdentity, enrollmentId = null) {
  if (typeof nativeIdentity !== 'string' || !/^(?:freebsd|linux|macos|windows):[A-Za-z0-9._{}-]{8,256}$/u.test(nativeIdentity)) throw new Error('Invalid native host identity')
  if (enrollmentId !== null && (!/^(?:macos|windows):/u.test(nativeIdentity) || !validId(enrollmentId))) throw new Error('Invalid host enrollment identifier')
  const value = enrollmentId === null ? nativeIdentity : `intentaiops-host-enrollment:v1\0${nativeIdentity}\0${enrollmentId}`
  return `SHA256:${createHash('sha256').update(value).digest('hex')}`
}

export function hostEnrollmentRequest (platform, operation, fields = {}) {
  if (!Object.hasOwn(scripts, platform) || !['read', 'replace'].includes(operation)) throw new Error('Unsupported host enrollment operation')
  if (Object.keys(fields).some(key => !['next', 'previous', 'native'].includes(key)) || (operation === 'replace' && (!validId(fields.next) || (fields.previous !== 'MISSING' && !validId(fields.previous)) || typeof fields.native !== 'string' || !/^[A-Za-z0-9._{}-]{8,256}$/u.test(fields.native)))) throw new Error('Invalid host enrollment request')
  if (platform === 'macos') return { command: `/bin/sh -s -- ${operation}${operation === 'replace' ? ` '${fields.next}' '${fields.previous}' '${fields.native}'` : ''}`, input: scripts.macos }
  const payload = Buffer.from(JSON.stringify(fields)).toString('base64')
  return { command: powershellCommand(`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& ([scriptblock]::Create([Console]::In.ReadToEnd())) '${operation}' '${payload}'`), input: scripts.windows }
}

export async function readHostEnrollment (ssh, connectionUrl, platform) {
  const request = hostEnrollmentRequest(platform, 'read')
  const result = await ssh.execute(connectionUrl, request.command, { input: request.input, timeoutMs: 15000, maxOutputBytes: 1024 })
  const value = result.stdout.trim()
  if (value === 'MISSING') return null
  if (!validId(value)) throw new Error('Invalid or unsupported protected host enrollment record; native identity fallback refused')
  return value
}

export async function replaceHostEnrollment ({ ssh, connectionUrl, platform, expectedFingerprint, runElevated }) {
  if (!Object.hasOwn(scripts, platform)) throw new Error('Host enrollment currently supports macOS and Windows')
  const nativeIdentity = await ssh.nativeHostIdentity(connectionUrl)
  if (!nativeIdentity.startsWith(`${platform}:`)) throw new Error('Host enrollment platform mismatch')
  const previous = await readHostEnrollment(ssh, connectionUrl, platform)
  if (hostIdentityFingerprint(nativeIdentity, previous) !== expectedFingerprint) throw new Error('Host identity changed before enrollment; no identifier was replaced')
  const next = randomUUID()
  const request = hostEnrollmentRequest(platform, 'replace', { next, previous: previous ?? 'MISSING', native: nativeIdentity.slice(platform.length + 1) })
  try {
    const result = await runElevated(request)
    if (result.code !== 0 || result.stdout.trim() !== 'INTENTAI_OPS_HOST_ENROLLED') throw new Error('Enrollment was not acknowledged')
    const confirmed = await ssh.hostFingerprint(connectionUrl)
    if (confirmed !== hostIdentityFingerprint(nativeIdentity, next)) throw new Error('Enrollment fingerprint verification failed')
    return confirmed
  } catch {
    throw new Error('Host enrollment outcome is not confirmed. Inspect the protected enrollment record and native identity before retrying; no automatic retry was performed')
  }
}
