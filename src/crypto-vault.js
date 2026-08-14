import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback
} from 'node:crypto'
import { createRequire } from 'node:module'
const KEY_LENGTH = 32
const NONCE_LENGTH = 12
const TAG_LENGTH = 16

export class VaultAuthenticationError extends Error {
  constructor (message = 'vault authentication failed', options = {}) {
    super(message, options)
    this.name = 'VaultAuthenticationError'
  }
}

const require = createRequire(import.meta.url)
let argon2 = null
try {
  argon2 = require('@node-rs/argon2')
} catch {}

export const DEFAULT_KDF = Object.freeze({
  name: 'argon2id',
  version: 19,
  memoryCost: 128 * 1024,
  timeCost: 4,
  parallelization: 1,
  outputLength: KEY_LENGTH
})

export const DEFAULT_SCRYPT_KDF = Object.freeze({
  name: 'scrypt',
  cost: 131072,
  blockSize: 8,
  parallelization: 1,
  maxmem: 256 * 1024 * 1024
})

export function createKdfParameters ({ preferArgon2 = true } = {}) {
  return {
    ...(preferArgon2 && argon2 ? DEFAULT_KDF : DEFAULT_SCRYPT_KDF),
    salt: randomBytes(16).toString('base64url')
  }
}

export function argon2Available () {
  return argon2 !== null
}

export async function deriveVaultKey (passphrase, parameters) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) {
    throw new TypeError('passphrase must contain at least 12 characters')
  }
  if (parameters?.name === 'argon2id') return deriveArgon2idKey(passphrase, parameters)
  if (parameters?.name !== 'scrypt') throw new Error(`unsupported KDF: ${parameters?.name ?? 'missing'}`)
  validateScryptParameters(parameters)

  return new Promise((resolve, reject) => scryptCallback(
    Buffer.from(passphrase, 'utf8'), Buffer.from(parameters.salt, 'base64url'), KEY_LENGTH, {
      cost: parameters.cost,
      blockSize: parameters.blockSize,
      parallelization: parameters.parallelization,
      maxmem: parameters.maxmem
    }, (error, key) => error ? reject(error) : resolve(key)
  ))
}

async function deriveArgon2idKey (passphrase, parameters) {
  validateArgon2Parameters(parameters)
  if (!argon2) throw new Error('this vault requires @node-rs/argon2, but a compatible native Argon2 binary is unavailable')
  return argon2.hashRaw(Buffer.from(passphrase, 'utf8'), {
    algorithm: argon2.Algorithm.Argon2id,
    version: argon2.Version.V0x13,
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelization,
    outputLen: parameters.outputLength,
    salt: Buffer.from(parameters.salt, 'base64url')
  })
}

function validateArgon2Parameters (parameters) {
  const salt = decodeKdfSalt(parameters.salt)
  if (salt.length < 16 || salt.length > 64 || parameters.version !== 19 ||
      !Number.isInteger(parameters.memoryCost) || parameters.memoryCost < 19 * 1024 || parameters.memoryCost > 1024 * 1024 ||
      !Number.isInteger(parameters.timeCost) || parameters.timeCost < 2 || parameters.timeCost > 32 ||
      !Number.isInteger(parameters.parallelization) || parameters.parallelization < 1 || parameters.parallelization > 16 ||
      parameters.outputLength !== KEY_LENGTH) {
    throw new Error('invalid or weakened Argon2id parameters')
  }
}

function validateScryptParameters (parameters) {
  const salt = decodeKdfSalt(parameters.salt)
  const costIsPowerOfTwo = Number.isInteger(parameters.cost) &&
    parameters.cost > 1 && (parameters.cost & (parameters.cost - 1)) === 0
  if (salt.length < 16 || salt.length > 64 || !costIsPowerOfTwo ||
      parameters.cost < 16384 || parameters.cost > 1048576 ||
      !Number.isInteger(parameters.blockSize) || parameters.blockSize < 1 || parameters.blockSize > 32 ||
      !Number.isInteger(parameters.parallelization) || parameters.parallelization < 1 || parameters.parallelization > 16 ||
      !Number.isInteger(parameters.maxmem) || parameters.maxmem < 32 * 1024 * 1024 ||
      parameters.maxmem > 1024 * 1024 * 1024) {
    throw new Error('invalid scrypt parameters')
  }
}

function decodeKdfSalt (value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return Buffer.alloc(0)
  return Buffer.from(value, 'base64url')
}

export function encryptJson (key, serverId, value) {
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(serverId))

  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return {
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  }
}

export function decryptJson (key, serverId, envelope) {
  if (envelope?.algorithm !== 'aes-256-gcm') {
    throw new Error('unsupported encrypted settings format')
  }

  const nonce = decodeEnvelopeField(envelope.nonce, 'nonce', NONCE_LENGTH)
  const tag = decodeEnvelopeField(envelope.tag, 'authentication tag', TAG_LENGTH)
  const ciphertext = decodeEnvelopeField(envelope.ciphertext, 'ciphertext')

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    nonce
  )
  decipher.setAAD(aad(serverId))
  decipher.setAuthTag(tag)

  let plaintext
  try {
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ])
  } catch (cause) {
    throw new VaultAuthenticationError(undefined, { cause })
  }

  try {
    return JSON.parse(plaintext.toString('utf8'))
  } catch (cause) {
    throw new Error('encrypted settings plaintext is invalid JSON', { cause })
  }
}

function decodeEnvelopeField (value, label, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`invalid encrypted settings ${label}`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length === 0 || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error(`invalid encrypted settings ${label}`)
  }
  return decoded
}

function aad (serverId) {
  return Buffer.from(`webminai:settings:v1:${serverId}`, 'utf8')
}
