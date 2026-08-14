import assert from 'node:assert/strict'
import test from 'node:test'
import { applyApplicationDefaults, FALLBACK_ADMIN_EMAIL, LEGACY_FALLBACK_ADMIN_EMAIL, normalizeAdminEmail, normalizeAdminEmailPreset, normalizeApplicationDefaults } from '../src/application-defaults.js'

test('application defaults validate a conservative command-safe administrator email', () => {
  assert.equal(normalizeAdminEmail(' owner+alerts@example.test '), 'owner+alerts@example.test')
  assert.deepEqual(normalizeApplicationDefaults(), { adminEmail: null })
  for (const invalid of [
    'owner@example',
    'owner..alerts@example.test',
    "owner'@example.test",
    'owner@example.test;id',
    'owner @example.test'
  ]) {
    assert.throws(() => normalizeAdminEmail(invalid), /conventional email/)
  }
})

test('administrator email preset supports both compatible clearing inputs and the fallback', () => {
  assert.equal(normalizeAdminEmailPreset('-'), null)
  assert.equal(normalizeAdminEmailPreset(''), null)
  assert.equal(normalizeAdminEmailPreset(' admin@example.test '), 'admin@example.test')
  assert.equal(normalizeApplicationDefaults({ adminEmail: normalizeAdminEmailPreset('-') }).adminEmail ?? FALLBACK_ADMIN_EMAIL, FALLBACK_ADMIN_EMAIL)
})

test('application defaults replace only the reviewed email placeholder without mutating input', () => {
  const original = { command: `install --email=${FALLBACK_ADMIN_EMAIL}`, nested: [LEGACY_FALLBACK_ADMIN_EMAIL, 'unchanged'] }
  const applied = applyApplicationDefaults(original, { adminEmail: 'owner@example.test' })
  assert.deepEqual(applied, { command: 'install --email=owner@example.test', nested: ['owner@example.test', 'unchanged'] })
  assert.equal(original.command, `install --email=${FALLBACK_ADMIN_EMAIL}`)
})
