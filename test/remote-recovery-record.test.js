import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import test from 'node:test'
import { planFingerprint } from '../src/execution-journal.js'
import { canonicalRecoveryJson, recoveryKeyFingerprint, recoveryRecord, signRecoveryRecord, verifyRecoveryChain, verifyRecoveryRecord } from '../src/remote-recovery-record.js'

const manifest = {
  executionId: randomBytes(16).toString('hex'),
  target: 'SHA256:' + 'a'.repeat(64),
  identityMethod: 'ssh-host-fingerprint-v1',
  platform: 'linux',
  catalogId: 'systemd-service',
  taskId: 1,
  catalogDigest: 'e'.repeat(64),
  planDigest: 'b'.repeat(64),
  rollbackDigest: 'c'.repeat(64),
  revision: 'b'.repeat(64)
}

for (const platform of ['linux', 'freebsd', 'macos', 'windows', 'kubernetes']) {
  test(`signed ${platform} recovery metadata verifies without retaining secrets`, () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const record = recoveryRecord({ ...manifest, platform, identityMethod: platform === 'kubernetes' ? 'kubernetes-cluster-uid-v1' : manifest.identityMethod }, { type: 'command_prepared', commandId: 'apply', commandDigest: 'd'.repeat(64), metadata: { password: 'do-not-retain', stdout: 'do-not-retain', evidenceBefore: { privateKey: 'do-not-retain' } } }, { sequence: 1 })
    assert.doesNotMatch(JSON.stringify(record), /do-not-retain|stdout|password|privateKey/u)
    const envelope = signRecoveryRecord(record, privateKey)
    assert.deepEqual(verifyRecoveryRecord(envelope, { publicKey, target: manifest.target, pinnedFingerprint: recoveryKeyFingerprint(publicKey) }), record)
  })
}

test('modified records, another target, substituted keys and unsupported algorithms reject', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const envelope = signRecoveryRecord(recoveryRecord(manifest, { type: 'plan_approved' }, { sequence: 1 }), privateKey)
  const trust = { publicKey, target: manifest.target, pinnedFingerprint: recoveryKeyFingerprint(publicKey) }
  assert.throws(() => verifyRecoveryRecord({ ...envelope, payload: envelope.payload.slice(0, -1) + 'A' }, trust))
  assert.throws(() => verifyRecoveryRecord({ ...envelope, algorithm: 'MD5' }, trust), /algorithm/u)
  assert.throws(() => verifyRecoveryRecord({ ...envelope, command: 'rm -rf /' }, trust), /schema/u)
  assert.throws(() => verifyRecoveryRecord(envelope, { ...trust, target: 'SHA256:' + 'f'.repeat(64) }), /another target/u)
  assert.throws(() => verifyRecoveryRecord(envelope, { ...trust, publicKey: generateKeyPairSync('ed25519').publicKey }), /pin/u)
})

test('P-256 signatures use the same strict record and target contract', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const record = recoveryRecord(manifest, { type: 'execution_paused' }, { sequence: 1 })
  assert.deepEqual(verifyRecoveryRecord(signRecoveryRecord(record, privateKey), { publicKey, target: manifest.target, pinnedFingerprint: recoveryKeyFingerprint(publicKey) }), record)
  assert.throws(() => recoveryKeyFingerprint(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey), /unsupported/u)
})

test('Windows CNG-compatible P1363 signatures verify without changing the signed payload contract', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const record = recoveryRecord({ ...manifest, platform: 'windows' }, { type: 'execution_paused' }, { sequence: 1 })
  const payload = Buffer.from(canonicalRecoveryJson(record))
  const envelope = { ...signRecoveryRecord(record, privateKey), algorithm: 'ECDSA-P256-SHA256-P1363', signature: sign('sha256', Buffer.concat([Buffer.from('intentaiops.remote-common-task.v1\n'), payload]), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
  assert.deepEqual(verifyRecoveryRecord(envelope, { publicKey, target: manifest.target, pinnedFingerprint: recoveryKeyFingerprint(publicKey) }), record)
})

test('ordered pages reject gaps, mixed executions and changed heads', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const trust = { publicKey, target: manifest.target, pinnedFingerprint: recoveryKeyFingerprint(publicKey) }
  const first = signRecoveryRecord(recoveryRecord(manifest, { type: 'plan_approved' }, { sequence: 1 }), privateKey)
  const second = signRecoveryRecord(recoveryRecord(manifest, { type: 'execution_paused' }, { sequence: 2, previousHash: planFingerprint(first) }), privateKey)
  assert.equal(verifyRecoveryChain([first, second], trust).sequence, 2)
  assert.equal(verifyRecoveryChain([second], trust, { sequence: 1, head: planFingerprint(first) }).sequence, 2)
  assert.throws(() => verifyRecoveryChain([second], trust), /gap/u)
  const mixed = signRecoveryRecord(recoveryRecord({ ...manifest, executionId: 'f'.repeat(32) }, { type: 'execution_paused' }, { sequence: 2, previousHash: planFingerprint(first) }), privateKey)
  assert.throws(() => verifyRecoveryChain([first, mixed], trust), /mixed/u)
  assert.throws(() => verifyRecoveryChain([first, first], trust), /gap/u)
})

test('schema rejects signed extras, malformed types and oversized identities', () => {
  const record = recoveryRecord(manifest, { type: 'execution_paused' }, { sequence: 1 })
  const { privateKey } = generateKeyPairSync('ed25519')
  for (const change of [{ token: 'secret' }, { commandId: '../escape' }, { version: 2 }, { sequence: -1 }, { target: null }, { jobId: 'x'.repeat(10000) }]) assert.throws(() => signRecoveryRecord({ ...record, ...change }, privateKey))
})
