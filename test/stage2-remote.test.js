import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRemoteTemporaryDirectory,
  detectPlatform,
  removeRemoteTemporaryDirectory,
  selectPluginArtifact
} from '../src/stage2-remote.js'

test('stage2 remote helpers validate temporary paths and detect platforms', async () => {
  const calls = []
  let invocation = 0
  const ssh = {
    async execute (url, command) {
      calls.push({ url, command })
      invocation += 1
      return { stdout: invocation === 1 ? '/tmp/webminai.ABC12345\n' : 'system=Linux\nmachine=x86_64\n', stderr: '' }
    }
  }
  const directory = await createRemoteTemporaryDirectory({ ssh, connectionUrl: 'ssh://host' })
  assert.equal(directory, '/tmp/webminai.ABC12345')
  assert.equal((await detectPlatform({ ssh, connectionUrl: 'ssh://host' })).os, 'linux')
  await removeRemoteTemporaryDirectory({ ssh, connectionUrl: 'ssh://host', directory })
  assert.equal(calls.length, 3)
})

test('stage2 remote helpers select an existing platform artifact', async () => {
  const ssh = { async execute () { return { stdout: 'system=Linux\nmachine=x86_64\n', stderr: '' } } }
  const selected = await selectPluginArtifact({
    ssh,
    connectionUrl: 'ssh://host',
    pluginPath: null,
    pluginPaths: { 'linux-amd64': new URL('../dist/webminai.plugin', import.meta.url).pathname }
  })
  assert.equal(selected.key, 'linux-amd64')
  assert.equal(selected.platform.supported, true)
})

test('stage2 remote helpers recognize macOS and select its native artifact', async () => {
  const ssh = { async execute () { return { stdout: 'system=Darwin\nmachine=arm64\n', stderr: '' } } }
  const selected = await selectPluginArtifact({
    ssh,
    connectionUrl: 'ssh://mac.example',
    pluginPath: '/tmp/webminai.plugin-macos-arm64',
    pluginPaths: {}
  })
  assert.equal(selected.key, 'explicit')
  assert.equal((await detectPlatform({ ssh, connectionUrl: 'ssh://mac.example' })).os, 'macos')
})
