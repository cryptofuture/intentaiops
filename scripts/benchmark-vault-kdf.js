#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import {
  DEFAULT_KDF,
  DEFAULT_SCRYPT_KDF,
  argon2Available,
  deriveVaultKey
} from '../src/crypto-vault.js'

const PASSPHRASE = 'benchmark-only vault passphrase'
const SALT = 'AAECAwQFBgcICQoLDA0ODw'
const RUNS = 3

await benchmark('scrypt fallback', { ...DEFAULT_SCRYPT_KDF, salt: SALT })
if (argon2Available()) {
  await benchmark('Argon2id default', { ...DEFAULT_KDF, salt: SALT })
} else {
  process.stdout.write('Argon2id default: unavailable (the hardened scrypt fallback will be used for new vaults)\n')
}

async function benchmark (label, parameters) {
  const durations = []
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now()
    const key = await deriveVaultKey(PASSPHRASE, parameters)
    durations.push(performance.now() - started)
    key.fill(0)
  }
  const ordered = [...durations].sort((left, right) => left - right)
  const median = ordered[Math.floor(ordered.length / 2)]
  process.stdout.write(`${label}: median ${median.toFixed(1)} ms (${durations.map(value => value.toFixed(1)).join(', ')} ms)\n`)
}
