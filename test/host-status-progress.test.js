import assert from 'node:assert/strict'
import test from 'node:test'
import { readStatus } from '../src/cli.js'

test('host status reports independently completed Netdata probes as they finish', async () => {
  const progress = []
  let releaseHealth
  let releaseCloud
  const stage2 = {
    async capabilities () {
      return {
        platform: { os: 'linux', system: 'Linux', machine: 'x86_64' },
        hasNetdata: true,
        hasStage2Runner: true,
        docker: { platform: 'linux', installSupported: true }
      }
    },
    async probe () {
      return new Promise(resolve => { releaseHealth = resolve })
    },
    async cloudStatus () {
      return new Promise(resolve => { releaseCloud = resolve })
    }
  }
  const admin = {
    async refreshLinuxHostContext () {
      return { profile: { family: 'debian' } }
    }
  }

  const loading = readStatus({
    stage2,
    server: { connectionUrl: 'ssh://root@example.test' },
    admin,
    settings: {},
    passphrase: 'not-rendered',
    serverId: 'prod',
    onProgress: event => progress.push(event)
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(progress.map(event => event.phase), ['capabilities', 'capabilities', 'netdata'])

  releaseCloud({ claimed: true, status: 'online' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(progress.at(-1).phase, 'netdata-cloud')
  releaseHealth({ status: 'active', info: { agents: [] } })

  const status = await loading
  assert.equal(status.connected, true)
  assert.deepEqual(progress.map(event => event.phase), [
    'capabilities',
    'capabilities',
    'netdata',
    'netdata-cloud',
    'stage2',
    'linux-context',
    'linux-context',
    'status'
  ])
  assert.equal(progress.at(-1).message, 'Current host status is ready.')
})

test('host status reports inactive Stage 2 immediately when Netdata is absent', async () => {
  const progress = []
  const status = await readStatus({
    stage2: {
      async capabilities () {
        return {
          platform: { os: 'linux', system: 'Linux', machine: 'aarch64' },
          hasNetdata: false,
          hasStage2Runner: false,
          docker: { platform: 'linux' }
        }
      }
    },
    server: {},
    onProgress: event => progress.push(event)
  })

  assert.equal(status.connected, true)
  assert.equal(progress.find(event => event.phase === 'netdata').state, 'warning')
  assert.equal(progress.at(-1).phase, 'status')
})
