import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { planFingerprint } from './execution-journal.js'

const DOMAIN = 'intentaiops.remote-common-task.v1\n'
const ROTATION_DOMAIN = 'intentaiops.remote-common-task.key-rotation.v1\n'
const HASH = /^[a-f0-9]{64}$/u
const ID = /^[a-f0-9]{32}$/u
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u
const EVENTS = new Set(['plan_approved', 'command_prepared', 'command_dispatched', 'command_acknowledged', 'command_completed', 'command_failed', 'command_outcome_unknown', 'execution_recovery', 'execution_paused', 'execution_resumed', 'plan_revised', 'rollback_started', 'rollback_completed', 'recovery_approved'])
const PLATFORMS = new Set(['linux', 'freebsd', 'macos', 'windows', 'kubernetes'])
const FIELDS = ['version', 'recordId', 'executionId', 'target', 'identityMethod', 'platform', 'catalogId', 'taskId', 'catalogDigest', 'planDigest', 'rollbackDigest', 'revision', 'parentRevision', 'sequence', 'previousHash', 'observedAt', 'event', 'outcome', 'operation', 'commandId', 'commandDigest', 'attemptId', 'jobId', 'baselineDigest']

export function recoveryKeyFingerprint (publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519' && !(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1')) throw new Error('unsupported recovery signing key')
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

export function recoveryRecord (manifest, event, { sequence, previousHash = null, baselineDigest = null, operation = 'deployment' } = {}) {
  const record = {
    version: 1,
    recordId: randomUUID(),
    executionId: manifest.executionId,
    target: manifest.target,
    identityMethod: manifest.identityMethod,
    platform: manifest.platform,
    catalogId: manifest.catalogId,
    taskId: manifest.taskId,
    catalogDigest: manifest.catalogDigest,
    planDigest: manifest.planDigest,
    rollbackDigest: manifest.rollbackDigest,
    revision: manifest.revision,
    parentRevision: manifest.parentRevision ?? null,
    sequence,
    previousHash,
    observedAt: new Date().toISOString(),
    event: event.type,
    outcome: event.type === 'command_completed' ? 'completed' : event.type === 'command_failed' ? 'failed' : ['command_dispatched', 'command_acknowledged', 'command_outcome_unknown'].includes(event.type) ? 'unknown' : event.type === 'execution_paused' ? 'paused' : event.type === 'rollback_completed' ? (event.metadata?.completed === true ? 'completed' : 'partial') : 'pending',
    operation,
    commandId: event.commandId ?? null,
    commandDigest: event.commandDigest ?? null,
    attemptId: event.attemptId ?? null,
    jobId: event.metadata?.jobId ?? null,
    baselineDigest
  }
  return validateRecoveryRecord(record)
}

export function validateRecoveryRecord (record) {
  exactKeys(record, FIELDS)
  for (const field of ['recordId', 'executionId', 'target', 'identityMethod', 'platform', 'catalogId', 'catalogDigest', 'planDigest', 'rollbackDigest', 'revision', 'event', 'outcome', 'operation']) if (typeof record[field] !== 'string') throw new Error(`invalid recovery ${field} type`)
  for (const field of ['parentRevision', 'previousHash', 'baselineDigest', 'commandId', 'commandDigest', 'attemptId', 'jobId']) if (record[field] !== null && typeof record[field] !== 'string') throw new Error(`invalid recovery ${field} type`)
  if (record.version !== 1 || !UUID.test(record.recordId) || !ID.test(record.executionId)) throw new Error('unsupported or invalid recovery record')
  if (!/^SHA256:[a-f0-9]{64}$/u.test(record.target) || !['ssh-host-fingerprint-v1', 'kubernetes-cluster-uid-v1'].includes(record.identityMethod) || !PLATFORMS.has(record.platform)) throw new Error('invalid recovery target identity')
  if ((record.platform === 'kubernetes') !== (record.identityMethod === 'kubernetes-cluster-uid-v1')) throw new Error('recovery identity method does not match platform')
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(record.catalogId) || !Number.isSafeInteger(record.taskId) || record.taskId < 1 || record.taskId > 2147483647) throw new Error('invalid recovery catalog identity')
  for (const name of ['catalogDigest', 'planDigest', 'rollbackDigest', 'revision']) if (!HASH.test(record[name])) throw new Error(`invalid recovery ${name}`)
  for (const name of ['parentRevision', 'previousHash', 'baselineDigest', 'commandDigest']) if (record[name] !== null && !HASH.test(record[name])) throw new Error(`invalid recovery ${name}`)
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > 100000 || (record.sequence === 1) !== (record.previousHash === null)) throw new Error('invalid recovery sequence')
  if (typeof record.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.observedAt) || !Number.isFinite(Date.parse(record.observedAt)) || new Date(record.observedAt).toISOString() !== record.observedAt) throw new Error('invalid recovery observation time')
  if (!EVENTS.has(record.event) || !['deployment', 'rollback', 'recovery'].includes(record.operation)) throw new Error('invalid recovery event')
  if (!['pending', 'completed', 'failed', 'unknown', 'paused', 'partial'].includes(record.outcome)) throw new Error('invalid recovery outcome')
  const commandOutcome = { command_prepared: 'pending', command_dispatched: 'unknown', command_acknowledged: 'unknown', command_completed: 'completed', command_failed: 'failed', command_outcome_unknown: 'unknown' }[record.event]
  if (commandOutcome && record.outcome !== commandOutcome) throw new Error('recovery event contradicts its outcome')
  if (record.commandId !== null && !LABEL.test(record.commandId)) throw new Error('invalid recovery command identity')
  if ((record.commandId === null) !== (record.commandDigest === null)) throw new Error('recovery command digest missing')
  if (record.event.startsWith('command_') && record.commandId === null) throw new Error('recovery command identity missing')
  if (record.attemptId !== null && !UUID.test(record.attemptId)) throw new Error('invalid recovery attempt identity')
  if (record.jobId !== null && !ID.test(record.jobId)) throw new Error('invalid recovery job identity')
  if (Buffer.byteLength(canonicalRecoveryJson(record)) > 4096) throw new Error('recovery record too large')
  return record
}

export function signRecoveryRecord (record, privateKey) {
  validateRecoveryRecord(record)
  const publicKey = createPublicKey(privateKey)
  const algorithm = publicKey.asymmetricKeyType === 'ed25519' ? 'Ed25519' : 'ECDSA-P256-SHA256'
  const payload = Buffer.from(canonicalRecoveryJson(record))
  return {
    format: 'intentaiops-remote-recovery',
    version: 1,
    algorithm,
    keyFingerprint: recoveryKeyFingerprint(publicKey),
    payload: payload.toString('base64url'),
    signature: sign(algorithm === 'Ed25519' ? null : 'sha256', Buffer.concat([Buffer.from(DOMAIN), payload]), privateKey).toString('base64url')
  }
}

export function verifyRecoveryRecord (envelope, { publicKey, target, pinnedFingerprint }) {
  const payload = verifySignedPayload(envelope, { publicKey, pinnedFingerprint }, 'intentaiops-remote-recovery', DOMAIN)
  const record = validateRecoveryRecord(JSON.parse(payload))
  if (canonicalRecoveryJson(record) !== payload) throw new Error('noncanonical recovery payload')
  if (record.target !== target) throw new Error('recovery record belongs to another target')
  return record
}

export function verifyRecoveryKeyRotation (envelope, { publicKey, target, pinnedFingerprint }) {
  const payload = verifySignedPayload(envelope, { publicKey, pinnedFingerprint }, 'intentaiops-recovery-key-rotation', ROTATION_DOMAIN)
  const record = JSON.parse(payload)
  exactKeys(record, ['version', 'target', 'oldFingerprint', 'newFingerprint', 'newPublicKey', 'rotationId', 'observedAt'])
  if (canonicalRecoveryJson(record) !== payload || record.version !== 1 || record.target !== target || record.oldFingerprint !== pinnedFingerprint || !ID.test(record.rotationId) || !HASH.test(record.newFingerprint) || typeof record.newPublicKey !== 'string' || record.newPublicKey.length > 1024 || typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt)) || new Date(record.observedAt).toISOString() !== record.observedAt) throw new Error('invalid recovery key rotation')
  const key = createPublicKey({ key: Buffer.from(record.newPublicKey, 'base64'), type: 'spki', format: 'der' })
  if (recoveryKeyFingerprint(key) !== record.newFingerprint || record.newFingerprint === record.oldFingerprint) throw new Error('invalid replacement recovery key')
  return { ...record, publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: record.newFingerprint }
}

function verifySignedPayload (envelope, { publicKey, pinnedFingerprint }, format, domain) {
  exactKeys(envelope, ['format', 'version', 'algorithm', 'keyFingerprint', 'payload', 'signature'])
  if (Buffer.byteLength(JSON.stringify(envelope)) > 8192 || envelope.format !== format || envelope.version !== 1) throw new Error('unsupported or oversized signed recovery record')
  if (!['Ed25519', 'ECDSA-P256-SHA256', 'ECDSA-P256-SHA256-P1363'].includes(envelope.algorithm)) throw new Error('unsupported recovery signature algorithm')
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  const fingerprint = recoveryKeyFingerprint(key)
  if (!HASH.test(pinnedFingerprint) || fingerprint !== pinnedFingerprint || envelope.keyFingerprint !== fingerprint) throw new Error('recovery signing key does not match trusted pin')
  if ((key.asymmetricKeyType === 'ed25519') !== (envelope.algorithm === 'Ed25519')) throw new Error('recovery algorithm does not match key')
  const payload = decode(envelope.payload, 4096)
  const signature = decode(envelope.signature, 128)
  const verificationKey = envelope.algorithm === 'ECDSA-P256-SHA256-P1363' ? { key, dsaEncoding: 'ieee-p1363' } : key
  if (!verify(envelope.algorithm === 'Ed25519' ? null : 'sha256', Buffer.concat([Buffer.from(domain), payload]), verificationKey, signature)) throw new Error('recovery signature verification failed')
  return payload.toString('utf8')
}

export function verifyRecoveryChain (envelopes, trust, { sequence = 0, head = null } = {}) {
  if (!Array.isArray(envelopes) || envelopes.length > 1000) throw new Error('recovery page exceeds limit')
  const records = []
  let identity
  for (const envelope of envelopes) {
    const record = verifyRecoveryRecord(envelope, trust)
    const currentIdentity = canonicalRecoveryJson([record.executionId, record.target, record.identityMethod, record.platform, record.catalogId, record.taskId])
    if (identity && identity !== currentIdentity) throw new Error('mixed recovery executions')
    identity = currentIdentity
    if (record.sequence !== sequence + 1 || record.previousHash !== head) throw new Error('recovery chain has a gap or changed head')
    sequence = record.sequence
    head = planFingerprint(envelope)
    records.push(record)
  }
  return { records, sequence, head }
}

export function canonicalRecoveryJson (value) {
  const canonical = item => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]))
    return item
  }
  return JSON.stringify(canonical(value))
}

function decode (value, limit) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length > limit * 2) throw new Error('invalid recovery encoding')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length > limit || bytes.toString('base64url') !== value) throw new Error('invalid recovery encoding')
  return bytes
}

function exactKeys (value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error('invalid recovery schema or unexpected fields')
}
