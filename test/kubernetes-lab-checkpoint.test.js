import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { KubernetesLabCheckpoint, assertLabResources, labResources } from '../scripts/kubernetes-lab-checkpoint.js'

test('lab cleanup refuses unowned or substituted resource UIDs', () => {
  const owned = { path: '/api/v1/namespaces/webminai-tasks/services/test', uid: 'original' }
  assert.doesNotThrow(() => assertLabResources([], [owned]))
  assert.doesNotThrow(() => assertLabResources([owned], [owned]))
  assert.throws(() => assertLabResources([owned]), /Unowned/u)
  assert.throws(() => assertLabResources([{ ...owned, uid: 'replacement' }], [owned]), /replaced/u)
  assert.throws(() => assertLabResources([{ path: owned.path }], [owned]), /UID/u)
})

test('lab resource inspection is bounded and restricted to task collections', async () => {
  const requests = []
  const resources = await labResources({
    async kubernetesJson (request) {
      requests.push(request)
      return { items: request.path.endsWith('/configmaps') ? [{ metadata: { name: 'kube-root-ca.crt', uid: 'system' } }] : [] }
    }
  })
  assert.deepEqual(resources, [])
  assert.equal(requests.length, 5)
  assert.ok(requests.every(value => value.method === 'GET' && value.path.includes('/namespaces/webminai-tasks/')))
  await assert.rejects(labResources({ async kubernetesJson () { return { items: new Array(129) } } }), /oversized/u)
})

test('lab checkpoint serializes concurrent receipts without recording payloads and rejects cluster reuse', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kubernetes-checkpoint-'))
  try {
    const checkpoint = await new KubernetesLabCheckpoint(directory, 'cluster-one').load()
    await checkpoint.record('nginx', { status: 'applying', receipts: [], intents: {} })
    const netdata = {
      async runApiRequest (request) {
        return { exitCode: 0, stdout: JSON.stringify({ metadata: { name: request.body.metadata.name, uid: request.body.metadata.name, namespace: 'webminai-tasks' }, secret: 'private-payload' }) }
      }
    }
    const restore = checkpoint.observe(netdata, 'nginx')
    await Promise.all(['one', 'two', 'three'].map(name => netdata.runApiRequest({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/services', body: { metadata: { name }, password: 'private-payload' } })))
    restore()
    const saved = await readFile(path.join(directory, 'state.json'), 'utf8')
    assert.doesNotMatch(saved, /private-payload|password/u)
    assert.equal(checkpoint.state.tasks.nginx.receipts.length, 3)
    assert.deepEqual(checkpoint.state.tasks.nginx.intents, {})
    assert.equal((await new KubernetesLabCheckpoint(directory, 'cluster-one').load()).state.tasks.nginx.receipts.length, 3)
    await checkpoint.record('nginx', { status: 'passed-and-reverted' })
    await checkpoint.begin('nginx')
    assert.equal(checkpoint.state.tasks.nginx.priorAttempts[0].receipts.length, 3)
    assert.equal(checkpoint.state.tasks.nginx.priorAttempts[0].status, 'passed-and-reverted')
    assert.deepEqual(checkpoint.state.tasks.nginx.receipts, [])
    assert.match(checkpoint.state.tasks.nginx.executionId, /^[a-f0-9-]{36}$/u)
    await assert.rejects(new KubernetesLabCheckpoint(directory, 'cluster-two').load(), /different cluster/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('lost or malformed mutation results retain intent and stop without cleanup or replay', async () => {
  for (const failure of ['transport', 'unknown', 'invalid-json', 'missing-uid', 'wrong-resource']) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kubernetes-unknown-'))
    try {
      const checkpoint = await new KubernetesLabCheckpoint(directory, 'cluster-one').load()
      let calls = 0
      const netdata = {
        async runApiRequest () {
          calls++
          if (failure === 'transport') throw new Error('connection lost')
          return { exitCode: 0, stdout: failure === 'invalid-json' ? '<invalid>' : failure === 'wrong-resource' ? JSON.stringify({ metadata: { uid: 'wrong', name: 'wrong', namespace: 'webminai-tasks' } }) : '{}', recoveryRequired: failure === 'unknown' }
        }
      }
      checkpoint.observe(netdata, 'nginx')
      await assert.rejects(netdata.runApiRequest({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/services' }))
      assert.equal(calls, 1)
      assert.equal(Object.keys(checkpoint.state.tasks.nginx.intents).length, 1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('cleanup adds atomic UID preconditions and never deletes a resource without a receipt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kubernetes-delete-'))
  try {
    const checkpoint = await new KubernetesLabCheckpoint(directory, 'cluster-one').load()
    const resource = '/api/v1/namespaces/webminai-tasks/services/owned'
    await checkpoint.record('nginx', { receipts: [{ path: resource, uid: 'created-uid' }], intents: {} })
    const calls = []
    let missing = true
    const netdata = {
      async runApiRequest (request) {
        calls.push(request)
        if (request.method === 'GET') return missing ? { exitCode: 1, stdout: JSON.stringify({ kind: 'Status', code: 404 }) } : { exitCode: 0, stdout: JSON.stringify({ metadata: { uid: 'unowned' } }) }
        return { exitCode: 0, stdout: JSON.stringify({ kind: 'Status', status: 'Success' }) }
      }
    }
    checkpoint.observe(netdata, 'nginx')
    await netdata.runApiRequest({ method: 'DELETE', path: resource, body: { preconditions: { resourceVersion: '7' } } })
    assert.deepEqual(calls[0].body.preconditions, { uid: 'created-uid', resourceVersion: '7' })
    await netdata.runApiRequest({ method: 'DELETE', path: resource + '-missing' })
    assert.equal(calls.at(-1).method, 'GET')
    missing = false
    await assert.rejects(netdata.runApiRequest({ method: 'DELETE', path: resource + '-unowned' }), /no creation receipt/u)
    assert.equal(calls.filter(request => request.method === 'DELETE').length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
