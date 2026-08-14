import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { MultiHostRunStore } from '../src/multi-host-run-store.js'
import { PLUGIN_VERSION } from '../src/plugin-version.js'
import { runProcess } from '../src/process-runner.js'
import { resolveServerDirectory, validateServerId } from '../src/server-id.js'

test('server IDs validate path-safe host workspace names', () => {
  assert.equal(validateServerId('prod_01-eu'), 'prod_01-eu')
  for (const value of ['', '../prod', 'Prod', 'host.example', 'x'.repeat(64), null]) {
    assert.throws(() => validateServerId(value), /server id must match/u)
  }
  assert.equal(resolveServerDirectory('/var/lib/webminai', 'prod'), path.resolve('/var/lib/webminai/prod'))
})

test('plugin version is a valid published semantic version', () => {
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
})

test('process runner streams output while retaining independently bounded stdout and stderr', async () => {
  const streamed = { stdout: '', stderr: '' }
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('abcdef');process.stderr.write('uvwxyz')"], {
    maxOutputBytes: 4,
    onStdout: value => { streamed.stdout += value },
    onStderr: value => { streamed.stderr += value }
  })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'abcd')
  assert.equal(result.stderr, 'uvwx')
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stderrTruncated, true)
  assert.equal(streamed.stdout, 'abcdef')
  assert.equal(streamed.stderr, 'uvwxyz')
})

test('Kubernetes Netdata client signs gateway requests and decodes command output', async () => {
  const calls = []
  const kubernetes = {
    async request (requestPath, options) {
      calls.push({ requestPath, options })
      return {
        exitCode: 0,
        outputEncoding: 'base64',
        stdout: Buffer.from('{"kind":"NodeList"}').toString('base64'),
        stderr: Buffer.from('').toString('base64')
      }
    }
  }
  const client = new KubernetesNetdataClient({ kubernetes, actionKey: '11'.repeat(32) })
  const result = await client.kubernetesJson({ method: 'GET', path: '/api/v1/nodes' })
  assert.equal(result.kind, 'NodeList')
  assert.match(calls[0].requestPath, /namespaces\/webminai-system\/services\/webminai-stage2%3A19999\/proxy\/api\/v3\/function/u)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(typeof calls[0].options.body.payload, 'string')
  assert.match(calls[0].options.body.mac, /^[a-f0-9]{64}$/u)
  await assert.rejects(client.request('../secret'), /invalid Netdata API path/u)
})

test('multi-host run store persists ordered hosts, state transitions, retry links, and mode 0600', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webminai-runs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new MultiHostRunStore(root)
  const created = store.create({ request: ' inspect fleet ', serverIds: ['zeta', 'alpha'] })
  assert.equal(created.request, 'inspect fleet')
  assert.deepEqual(created.hosts.map(host => host.serverId), ['alpha', 'zeta'])
  assert.equal((await stat(store.databasePath)).mode & 0o777, 0o600)

  const updated = store.updateHost(created.id, 'alpha', {
    taskId: 17,
    status: 'completed',
    verification: { url: 'http://alpha.example/' }
  })
  assert.equal(updated.hosts[0].taskId, 17)
  assert.equal(updated.hosts[0].verification.url, 'http://alpha.example/')
  assert.equal(store.updateRun(created.id, 'partial').status, 'partial')
  const retry = store.create({ request: 'retry fleet', serverIds: ['zeta'], retryOfRunId: created.id, retryInstructions: 'fix package source' })
  assert.equal(retry.retryOfRunId, created.id)
  assert.equal(store.list({ limit: 2 })[0].id, retry.id)
  assert.throws(() => store.updateHost(created.id, 'missing', {}), /is not part/u)
})
