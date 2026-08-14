import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_KDF,
  DEFAULT_SCRYPT_KDF,
  VaultAuthenticationError,
  argon2Available,
  createKdfParameters,
  decryptJson,
  deriveVaultKey,
  encryptJson
} from '../src/crypto-vault.js'

test('new vault KDF parameters prefer the benchmarked Argon2id profile', () => {
  const parameters = createKdfParameters()
  if (argon2Available()) {
    assert.deepEqual({ ...parameters, salt: undefined }, { ...DEFAULT_KDF, salt: undefined })
  } else {
    assert.deepEqual({ ...parameters, salt: undefined }, { ...DEFAULT_SCRYPT_KDF, salt: undefined })
  }
  assert.match(parameters.salt, /^[A-Za-z0-9_-]{22}$/u)
})

test('the native-unavailable fallback uses the hardened OWASP scrypt profile', async () => {
  const parameters = createKdfParameters({ preferArgon2: false })
  assert.deepEqual({ ...parameters, salt: undefined }, { ...DEFAULT_SCRYPT_KDF, salt: undefined })
  const key = await deriveVaultKey('correct horse battery staple', parameters)
  assert.equal(key.length, 32)
  key.fill(0)
})

test('Argon2id envelopes reject weakened or malformed parameters', async t => {
  if (!argon2Available()) return t.skip('compatible @node-rs/argon2 binary is unavailable')
  const parameters = createKdfParameters()
  await assert.rejects(
    deriveVaultKey('correct horse battery staple', { ...parameters, memoryCost: 1024 }),
    /invalid or weakened Argon2id parameters/
  )
  await assert.rejects(
    deriveVaultKey('correct horse battery staple', { ...parameters, version: 16 }),
    /invalid or weakened Argon2id parameters/
  )
})

test('vault decryption classifies authentication failures separately from malformed envelopes', async () => {
  const parameters = createKdfParameters()
  const key = await deriveVaultKey('correct horse battery staple', parameters)
  const wrongKey = await deriveVaultKey('another sufficiently long password', parameters)
  const envelope = encryptJson(key, 'primary', { value: true })

  assert.deepEqual(decryptJson(key, 'primary', envelope), { value: true })
  assert.throws(
    () => decryptJson(wrongKey, 'primary', envelope),
    error => error instanceof VaultAuthenticationError && error.cause instanceof Error
  )
  assert.throws(
    () => decryptJson(key, 'primary', { ...envelope, nonce: '*' }),
    /invalid encrypted settings nonce/
  )
  assert.throws(
    () => decryptJson(key, 'primary', { ...envelope, algorithm: 'future-format' }),
    /unsupported encrypted settings format/
  )

  key.fill(0)
  wrongKey.fill(0)
})
