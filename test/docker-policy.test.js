import assert from 'node:assert/strict'
import test from 'node:test'
import { detectNetdataContainer, resolveDockerPolicy } from '../src/docker-policy.js'

const ready = {
  platform: 'linux',
  cliAvailable: true,
  daemonReachable: true,
  composeAvailable: true,
  composeCommand: 'docker compose'
}

test('automatic Docker preference selects ready physical Linux hosts', () => {
  const decision = resolveDockerPolicy({ preference: 'auto', capability: ready })
  assert.equal(decision.ready, true)
  assert.equal(decision.preferred, true)
  assert.equal(decision.platform, 'linux')
})

test('automatic Docker preference rejects container hosts but manual enable overrides it', () => {
  const inventory = {
    info: { agents: [{ application: { container: { container: 'lxc' } } }] }
  }
  assert.equal(detectNetdataContainer(inventory), 'lxc')
  const automatic = resolveDockerPolicy({ preference: 'auto', capability: ready, inventory })
  assert.equal(automatic.hostIsContainer, true)
  assert.equal(automatic.preferred, false)
  assert.match(automatic.reason, /lxc/)

  const enabled = resolveDockerPolicy({ preference: 'enabled', capability: ready, inventory })
  assert.equal(enabled.preferred, true)
})

test('manual Docker disable wins even on a ready physical host', () => {
  const decision = resolveDockerPolicy({ preference: 'disabled', capability: ready })
  assert.equal(decision.preferred, false)
  assert.match(decision.reason, /disabled/)
})

test('manual Docker enable can request setup when Docker is absent', () => {
  const decision = resolveDockerPolicy({
    preference: 'enabled',
    capability: { platform: 'linux' }
  })
  assert.equal(decision.preferred, true)
  assert.equal(decision.ready, false)
  assert.match(decision.reason, /setup is required/)
})

test('automatic Docker preference selects a supported physical host before Docker is installed', () => {
  const decision = resolveDockerPolicy({
    preference: 'auto',
    capability: { platform: 'linux', installSupported: true, installMethod: 'official-apt' }
  })
  assert.equal(decision.capable, true)
  assert.equal(decision.preferred, true)
  assert.equal(decision.ready, false)
  assert.equal(decision.setupRequired, true)
  assert.equal(decision.installMethod, 'official-apt')
  assert.match(decision.reason, /setup is required/)
})

test('automatic Docker preference still rejects a supported installation inside a container', () => {
  const decision = resolveDockerPolicy({
    preference: 'auto',
    capability: { platform: 'linux', installSupported: true, containerRuntime: 'lxc' }
  })
  assert.equal(decision.hostIsContainer, true)
  assert.equal(decision.preferred, false)
  assert.equal(decision.setupRequired, false)
})

test('Windows Docker is preferred only when an existing daemon and Compose are ready', () => {
  const available = resolveDockerPolicy({
    preference: 'auto',
    capability: { platform: 'windows', cliAvailable: true, daemonReachable: true, composeAvailable: true, composeCommand: 'docker compose' }
  })
  assert.equal(available.ready, true)
  assert.equal(available.preferred, true)

  const unavailable = resolveDockerPolicy({ preference: 'enabled', capability: { platform: 'windows' } })
  assert.equal(unavailable.preferred, false)
  assert.equal(unavailable.setupRequired, false)
  assert.match(unavailable.reason, /no reviewed setup route/u)

  const supported = resolveDockerPolicy({
    preference: 'auto',
    capability: { platform: 'windows', installSupported: true, installMethod: 'wsl2-docker-desktop' }
  })
  assert.equal(supported.preferred, true)
  assert.equal(supported.setupRequired, true)
  assert.equal(supported.installMethod, 'wsl2-docker-desktop')
})

test('macOS Docker setup requires a reviewed virtualization-backed route', () => {
  const blocked = resolveDockerPolicy({
    preference: 'auto',
    capability: { platform: 'macos', installSupported: false, installMethod: 'homebrew-colima' }
  })
  assert.equal(blocked.preferred, false)
  assert.equal(blocked.capable, false)

  const supported = resolveDockerPolicy({
    preference: 'auto',
    capability: { platform: 'macos', installSupported: true, installMethod: 'homebrew-colima' }
  })
  assert.equal(supported.preferred, true)
  assert.equal(supported.setupRequired, true)
  assert.equal(supported.installMethod, 'homebrew-colima')
})

test('container policy preserves platform virtualization guidance without treating Linux or FreeBSD as VM workloads', () => {
  const windows = resolveDockerPolicy({
    preference: 'auto',
    capability: {
      platform: 'windows',
      virtualizationRequired: true,
      virtualizationAvailable: false,
      virtualizationInstructions: 'Enable SVM or VT-x and restart.'
    }
  })
  assert.equal(windows.virtualizationRequired, true)
  assert.equal(windows.virtualizationAvailable, false)
  assert.match(windows.virtualizationInstructions, /SVM or VT-x/u)

  for (const platform of ['linux', 'freebsd']) {
    const native = resolveDockerPolicy({
      preference: 'auto',
      capability: { platform, virtualizationRequired: false, virtualizationAvailable: true }
    })
    assert.equal(native.virtualizationRequired, false)
    assert.equal(native.virtualizationAvailable, true)
  }
})
