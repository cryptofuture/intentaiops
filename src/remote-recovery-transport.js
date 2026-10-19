import { readFile } from 'node:fs/promises'
import { createPublicKey } from 'node:crypto'
import { canonicalRecoveryJson, recoveryKeyFingerprint, validateRecoveryRecord, verifyRecoveryRecord } from './remote-recovery-record.js'

const ID = /^[a-f0-9]{32}$/u
const HASH = /^[a-f0-9]{64}$/u

export class RemoteRecoveryTransport {
  constructor ({ client, platform }) {
    this.client = client
    this.platform = platform
  }

  async request (operation, parameters = {}) {
    const command = await recoveryStorageCommand(this.platform, operation, parameters)
    const result = await this.client.runCommand(command, { timeoutSeconds: 15 })
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new Error(`Remote recovery ${operation} failed; no automatic retry is authorized`)
    if (Buffer.byteLength(result.stdout ?? '') > 8192) throw new Error('Remote recovery response exceeds limit')
    try {
      const value = JSON.parse(result.stdout)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object')
      return value
    } catch { throw new Error('Invalid remote recovery response') }
  }

  async key ({ initialize = false } = {}) {
    const result = await this.request(initialize ? 'initialize' : 'key')
    return this.parseKey(result)
  }

  parseKey (result) {
    if (result.available === false) return null
    if (typeof result.publicKey !== 'string' || result.publicKey.length > 1024) throw new Error('Invalid remote recovery public key')
    const key = createPublicKey({ key: Buffer.from(result.publicKey, 'base64'), type: 'spki', format: 'der' })
    return { publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: recoveryKeyFingerprint(key), ...(result.rotation ? { rotation: result.rotation } : {}) }
  }

  async historicalKey (fingerprint) {
    const key = this.parseKey(await this.request('verification-key', { fingerprint }))
    if (!key || key.fingerprint !== fingerprint) throw new Error('Historical recovery key does not match the record')
    return key
  }

  async rotateKey (expectedFingerprint, target) {
    return this.parseKey(await this.request('rotate-key', { fingerprint: expectedFingerprint, target }))
  }

  async append (record, { owner, trust }) {
    validateRecoveryRecord(record)
    const envelope = await this.request('append', { record, owner, fingerprint: trust.pinnedFingerprint })
    verifyRecoveryRecord(envelope, trust)
    return envelope
  }

  async claim (parameters) {
    const result = await this.request('claim', parameters)
    if (result.claimed !== true || Object.keys(result).length !== 1) throw new Error('Invalid remote recovery ownership response')
    return { claimed: true }
  }

  async ownership (parameters) {
    const value = await this.request('ownership', parameters)
    if (Object.keys(value).length !== 2 || typeof value.owned !== 'boolean' || (value.owned ? !HASH.test(value.ownerFingerprint) : value.ownerFingerprint !== null)) throw new Error('Invalid recovery ownership summary')
    return value
  }

  async takeover (parameters) {
    const value = await this.request('takeover', parameters)
    if (value.claimed !== true || Object.keys(value).length !== 1) throw new Error('Invalid reviewed ownership takeover')
    return value
  }

  async release (parameters) {
    const result = await this.request('release', parameters)
    if (result.released !== true || Object.keys(result).length !== 1) throw new Error('Invalid remote recovery release response')
    return { released: true }
  }

  async list (after = '') {
    const result = await this.request('list', { after })
    if (result.available === false) return { available: false, executions: [] }
    if (!Array.isArray(result.executions) || result.executions.length > 10) throw new Error('Invalid remote recovery listing')
    let previous = after
    const executions = result.executions.map(entry => {
      if (!entry || Object.keys(entry).length !== 3 || typeof entry.executionId !== 'string' || !ID.test(entry.executionId) || entry.executionId <= previous || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > 100000 || !HASH.test(entry.head)) throw new Error('Invalid remote recovery execution summary')
      previous = entry.executionId
      return { executionId: entry.executionId, sequence: entry.sequence, head: entry.head }
    })
    return { executions }
  }

  async read (executionId, sequence) { return this.request('read', { executionId, sequence }) }
}

export async function recoveryStorageCommand (platform, operation, parameters = {}) {
  if (!['linux', 'freebsd', 'macos', 'windows'].includes(platform)) throw new Error(platform === 'kubernetes' ? 'Remote recovery unavailable: gateway persistent storage and cluster identity are not configured' : 'Remote recovery unavailable: native signing/storage backend is not supported')
  const args = [operation, platform]
  if (operation === 'verification-key' || operation === 'rotate-key') {
    if (!HASH.test(parameters.fingerprint)) throw new Error('Invalid recovery key fingerprint')
    args.push(parameters.fingerprint)
    if (operation === 'rotate-key') {
      if (!/^SHA256:[a-f0-9]{64}$/u.test(parameters.target)) throw new Error('Invalid recovery target')
      args.push(parameters.target)
    }
    // No execution state is created by a key read.
  } else if (operation === 'list') {
    if (parameters.after !== '' && !ID.test(parameters.after)) throw new Error('Invalid recovery cursor')
    args.push(parameters.after)
  } else if (!['initialize', 'key'].includes(operation)) {
    const record = parameters.record
    const executionId = record?.executionId ?? parameters.executionId
    const sequence = record ? record.sequence - 1 : parameters.sequence
    if (!ID.test(executionId) || !Number.isSafeInteger(sequence) || sequence < (operation === 'read' ? 1 : 0) || sequence > 100000) throw new Error('Invalid recovery execution identity or sequence')
    args.push(executionId, String(sequence))
    if (operation !== 'read') {
      const head = record ? record.previousHash : parameters.head
      if ((sequence === 0 ? head !== null : !HASH.test(head)) || (operation !== 'ownership' && !ID.test(parameters.owner))) throw new Error('Invalid recovery head or owner')
      args.push(head ?? '-')
      if (operation !== 'ownership') args.push(parameters.owner)
      if (operation === 'takeover') {
        if (!HASH.test(parameters.ownerFingerprint)) throw new Error('Invalid previous recovery owner fingerprint')
        args.push(parameters.ownerFingerprint)
      } else if (operation === 'claim') {
        if (!Number.isSafeInteger(parameters.taskId) || parameters.taskId < 1 || parameters.taskId > 2147483647) throw new Error('Invalid original task identity')
        args.push(String(parameters.taskId))
      } else if (operation === 'append') {
        validateRecoveryRecord(record)
        if (!HASH.test(parameters.fingerprint)) throw new Error('Invalid recovery key pin')
        const payload = canonicalRecoveryJson(record)
        args.push(parameters.fingerprint, Buffer.from(payload).toString('base64url'), Buffer.from('intentaiops.remote-common-task.v1\n' + payload).toString('base64'))
      } else if (!['release', 'ownership'].includes(operation)) throw new Error('Unsupported recovery operation')
    }
  }
  let command
  if (platform === 'windows') {
    const request = { operation }
    if (operation === 'verification-key' || operation === 'rotate-key') {
      request.fingerprint = args[2]
      if (operation === 'rotate-key') request.target = args[3]
    } else if (operation === 'list') request.after = args[2]
    else if (!['key', 'initialize'].includes(operation)) {
      request.executionId = args[2]
      request.sequence = Number(args[3])
      if (operation !== 'read') {
        request.head = args[4]
        if (operation !== 'ownership') request.owner = args[5]
        if (operation === 'takeover') request.ownerFingerprint = args[6]
        if (operation === 'claim') request.taskId = Number(args[6])
        if (operation === 'append') Object.assign(request, { fingerprint: args[6], payload: args[7], signing: args[8] })
      }
    }
    const helper = await readFile(new URL('../remote/recovery-store.ps1', import.meta.url), 'utf8')
    command = `& {\n${helper}\n} '${Buffer.from(JSON.stringify(request)).toString('base64')}'`
  } else {
    const helper = await readFile(new URL('../remote/recovery-store.sh', import.meta.url), 'utf8')
    command = ['sh', '-c', quote(helper), 'intentaiops-recovery', ...args.map(quote)].join(' ')
  }
  if (Buffer.byteLength(command) > 32768) throw new Error('Recovery request exceeds transport limit')
  return command
}

function quote (value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'"
}
