import assert from 'node:assert/strict'
import test from 'node:test'
import { detectPersistedPlatform, normalizePlatformIdentity } from '../src/platform-identity.js'

const ismetInventory = {
  info: {
    agents: [{
      application: {
        os: {
          kernel: 'Linux',
          os: 'Ubuntu',
          version: '22.04.5 LTS'
        },
        features: { 'built-for': 'Linux' },
        plugins: {
          windows: false,
          'windows-events': false,
          freebsd: false,
          macos: false
        }
      }
    }]
  }
}

test('persisted platform uses explicit Ismet Netdata identity instead of plugin capability names', () => {
  assert.equal(detectPersistedPlatform(ismetInventory), 'linux')
  assert.equal(detectPersistedPlatform({
    info: { agents: [{ application: { plugins: { windows: true }, directories: { logs: 'C:\\windows\\logs' } } }] }
  }), null)
})

test('persisted platform normalizes supported explicit OS identities', () => {
  for (const [identity, expected] of [
    ['Linux', 'linux'],
    ['Ubuntu Linux', 'linux'],
    ['Windows', 'windows'],
    ['Windows_NT', 'windows'],
    ['Microsoft Windows', 'windows'],
    ['FreeBSD', 'freebsd'],
    ['FreeBSD 15.1', 'freebsd'],
    ['Darwin', 'macos'],
    ['macOS', 'macos'],
    ['Mac OS', 'macos']
  ]) assert.equal(normalizePlatformIdentity(identity), expected, identity)
  assert.equal(detectPersistedPlatform({
    info: { agents: [{ application: { os: { name: 'FreeBSD', version: '14.3' } } }] }
  }), 'freebsd')
})

test('persisted platform follows explicit execution, direct identity, then agent order', () => {
  assert.equal(detectPersistedPlatform({
    webminaiExecution: { platform: 'windows' },
    info: { agents: [{ application: { os: 'Linux' } }] }
  }), 'windows')
  assert.equal(detectPersistedPlatform({
    webminaiExecution: { platform: 'unsupported' },
    info: { agents: [{ application: { os: 'FreeBSD' } }] }
  }), 'freebsd')
  assert.equal(detectPersistedPlatform({
    info: { agents: [{ application: { os: 'Linux' } }, { application: { os: 'Windows' } }] }
  }), 'linux')
})

test('persisted platform remains unknown without explicit supported identity', () => {
  for (const inventory of [null, undefined, {}, { info: {} }, { info: { agents: [] } }, {
    info: { agents: [{ application: { os: { os: 'Ubuntu' }, package: { distro: 'Linux package for Windows tools' } } }] }
  }]) assert.equal(detectPersistedPlatform(inventory), null)
})
