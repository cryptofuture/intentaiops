import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto'
import { KubernetesTaskService } from '../src/kubernetes-task-service.js'
import { planFingerprint, journalMetadata, isKubernetesResourceBinding } from '../src/execution-journal.js'
import { signRecoveryRecord } from '../src/remote-recovery-record.js'

test('journal preserves validated public resource hashes, not arbitrary metadata or numeric UIDs', () => {
  const resource = { path: '/apis/apps/v1/namespaces/webminai-tasks/deployments/app', uid: 'a'.repeat(64), definitionDigest: 'b'.repeat(64) }
  assert.deepEqual(journalMetadata({ resource }), { resource })
  assert.equal(isKubernetesResourceBinding({ ...resource, uid: 123 }), false)
  assert.equal(isKubernetesResourceBinding({ ...resource, password: 'known-secret' }), false)
  assert.doesNotMatch(JSON.stringify(journalMetadata({ resource: { ...resource, password: 'known-secret' } })), /known-secret/u)
})

test('an environment flag alone never proves Kubernetes persistence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-kubernetes-persistence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new KubernetesTaskService({ dataRoot: directory, settings: { clusters: {} } })
  const target = 'SHA256:' + 'a'.repeat(64)
  const gateway = { spec: { replicas: 1, strategy: { type: 'Recreate' }, template: { spec: { containers: [{ name: 'netdata', env: [{ name: 'WEBMINAI_RECOVERY_TARGET', value: target }], volumeMounts: [{ name: 'ledger', mountPath: '/var/lib/intentaiops' }] }], volumes: [{ name: 'ledger', persistentVolumeClaim: { claimName: 'webminai-recovery' } }] } } } }
  const claim = { metadata: { uid: 'claim-uid', labels: { 'app.kubernetes.io/managed-by': 'webminai' }, annotations: { 'webminai.io/recovery-target': target } }, spec: { volumeName: 'volume' }, status: { phase: 'Bound' } }
  const c = { target, netdata: { kubernetes: { async request (path) { return structuredClone(path.includes('/deployments/') ? gateway : claim) } } } }
  await service.assertPersistent(c)
  gateway.spec.template.spec.volumes[0] = { name: 'ledger', emptyDir: {} }
  await assert.rejects(service.assertPersistent(c), /cannot be verified/u)
  gateway.spec.template.spec.volumes[0] = { name: 'ledger', persistentVolumeClaim: { claimName: 'webminai-recovery' } }
  claim.metadata.annotations['webminai.io/recovery-target'] = 'another-cluster'
  await assert.rejects(service.assertPersistent(c), /cannot be verified/u)
  claim.metadata.annotations['webminai.io/recovery-target'] = target
  gateway.spec.replicas = 2
  await assert.rejects(service.assertPersistent(c), /cannot be verified/u)
})

test('Kubernetes plans prepare without mutation, require current explicit approval and recover from a fresh installation', async t => {
  const f = await fixture(t)
  const view = await f.service.prepare('lab', 'n8n-kubernetes')
  assert.equal(f.resources.size, 0)
  assert.equal(f.ledger.size, 0)
  assert.equal(view.commands.length, 8)
  assert.ok(view.commands.every(command => !Object.hasOwn(command, 'command')))
  assert.doesNotMatch(JSON.stringify(view), /N8N_ENCRYPTION_KEY|"spec":|args=/u)
  await assert.rejects(f.service.execute('lab', view.taskId, {}), /approval/u)
  await assert.rejects(f.service.execute('lab', view.taskId, { ...view, approved: true, expectedVersion: 'stale' }), /Stale/u)
  await assert.rejects(f.service.execute('lab', view.taskId, { ...view, approved: true, fingerprint: 'a'.repeat(64) }), /Approval/u)
  const completed = await f.service.execute('lab', view.taskId, { ...view, approved: true })
  assert.equal(completed.status, 'completed')
  await assert.rejects(f.service.execute('lab', view.taskId, { ...completed, approved: true }), /approval is consumed/u)
  assert.equal(f.resources.size, 5)
  const posts = f.posts
  const fresh = new KubernetesTaskService({ dataRoot: f.freshDirectory, settings: { clusters: { lab: {} } }, openCluster: f.openCluster })
  const recovery = await fresh.prepareRecovery('lab', view.executionId)
  assert.equal(recovery.recovery, true)
  assert.equal(recovery.taskId, 1, 'fresh local task IDs can collide without replacing remote executions')
  assert.ok(recovery.commands.every(command => command.method === 'DELETE' && command.resourceUid))
  assert.equal(recovery.takeoverRequired, false)
  const reverted = await fresh.execute('lab', recovery.taskId, { ...recovery, approved: true })
  assert.equal(reverted.status, 'completed')
  assert.equal(f.resources.size, 0)
  assert.equal(f.posts, posts, 'fresh recovery never repeats application creation')
})

test('unknown Kubernetes creation is journaled and cannot be replayed or destructively recovered', async t => {
  const f = await fixture(t, { unknown: true })
  const view = await f.service.prepare('lab', 'n8n-kubernetes')
  const result = await f.service.execute('lab', view.taskId, { ...view, approved: true })
  assert.equal(f.posts, 1)
  assert.ok(result.execution.some(command => command.status === 'uncertain'))
  await assert.rejects(f.service.execute('lab', view.taskId, { ...result, approved: true }), /Unknown mutation/u)
  await assert.rejects(f.service.prepareRecovery('lab', view.executionId), /authoritative resource identity/u)
  assert.equal(f.posts, 1)
})

test('signed resource identity and current configuration both protect recovery', async t => {
  for (const change of ['uid', 'image']) {
    const f = await fixture(t)
    const view = await f.service.prepare('lab', 'n8n-kubernetes')
    await f.service.execute('lab', view.taskId, { ...view, approved: true })
    const deployment = [...f.resources.values()].find(resource => resource.kind === 'Deployment')
    if (change === 'uid') deployment.metadata.uid = 'replacement'
    else deployment.spec.template.spec.containers[0].image = 'unrelated/application'
    await assert.rejects(f.service.prepareRecovery('lab', view.executionId), /identity, ownership or configuration changed/u)
    assert.equal(f.deletes, 0)
  }
})

test('a later successful Kubernetes attempt cannot hide an earlier uncertain creation', async t => {
  const f = await fixture(t)
  const view = await f.service.prepare('lab', 'n8n-kubernetes')
  await f.service.execute('lab', view.taskId, { ...view, approved: true })
  const envelopes = f.ledger.get(view.executionId)
  const records = envelopes.map(envelope => JSON.parse(Buffer.from(envelope.payload, 'base64url')))
  const index = records.findIndex(record => record.event === 'command_dispatched')
  const attemptId = randomUUID()
  const dispatched = { ...records[index], recordId: randomUUID(), attemptId }
  records.splice(index, 0, dispatched, { ...dispatched, recordId: randomUUID(), event: 'command_outcome_unknown' })
  let head = null
  const resigned = records.map((record, index) => {
    const envelope = f.sign({ ...record, sequence: index + 1, previousHash: head })
    head = planFingerprint(envelope)
    return envelope
  })
  f.ledger.set(view.executionId, resigned)
  const fresh = new KubernetesTaskService({ dataRoot: f.freshDirectory, settings: { clusters: { lab: {} } }, openCluster: f.openCluster })
  await assert.rejects(fresh.prepareRecovery('lab', view.executionId), /authoritative resource identity/u)
  assert.equal(f.deletes, 0)
})

test('an uncertain partial recovery is never repeated by a fresh client', async t => {
  const f = await fixture(t)
  const view = await f.service.prepare('lab', 'n8n-kubernetes')
  await f.service.execute('lab', view.taskId, { ...view, approved: true })
  const recovery = await f.service.prepareRecovery('lab', view.executionId)
  f.unknownDelete = true
  const partial = await f.service.execute('lab', recovery.taskId, { ...recovery, approved: true })
  assert.equal(partial.status, 'partial')
  assert.equal(f.deletes, 1)
  const fresh = new KubernetesTaskService({ dataRoot: f.freshDirectory, settings: { clusters: { lab: {} } }, openCluster: f.openCluster })
  await assert.rejects(fresh.prepareRecovery('lab', view.executionId), /unresolved deletion/u)
  assert.equal(f.deletes, 1)
})

test('Kubernetes safe-boundary pause persists and reviewed continuation skips confirmed creates', async t => {
  const f = await fixture(t)
  let paused = false
  f.service.onEvent = event => {
    if (!paused && event.event === 'command_completed') {
      paused = true
      const c = f.identity
      f.service.tasks.setControl(c, event.taskId, 'pause', 1)
    }
  }
  const view = await f.service.prepare('lab', 'n8n-kubernetes')
  const partial = await f.service.execute('lab', view.taskId, { ...view, approved: true })
  assert.equal(f.posts, 1)
  assert.equal(partial.control.action, 'pause')
  const complete = await f.service.execute('lab', view.taskId, { ...partial, approved: true })
  assert.equal(complete.status, 'completed')
  assert.equal(f.posts, 5)
})

async function fixture (t, { unknown = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-kubernetes-task-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resources = new Map()
  const ledger = new Map()
  const owners = new Map()
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
  const f = { resources, ledger, posts: 0, deletes: 0, freshDirectory: path.join(directory, 'fresh') }
  f.sign = record => signRecoveryRecord(record, privateKey)
  const netdata = {
    async health () { return { platform: 'kubernetes', recoveryConfigured: true, recoveryProtocolVersion: 1, recoveryOpenSslAvailable: true } },
    async runApiRequest (request) {
      if (request.method === 'GET') {
        if (request.path.includes('/log?')) return { exitCode: 0, stdout: 'WEBMINAI_N8N_OK node=node-a\nWEBMINAI_N8N_OK node=node-b', stderr: '' }
        const resource = resources.get(request.path)
        return resource ? { exitCode: 0, stdout: JSON.stringify(resource), stderr: '' } : { exitCode: 1, stdout: JSON.stringify({ kind: 'Status', code: 404 }), stderr: '' }
      }
      if (request.method === 'POST') {
        f.posts++
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body
        const resource = structuredClone(body)
        resource.metadata.uid = 'uid-' + f.posts
        resource.metadata.generation = 1
        if (resource.kind === 'Deployment') resource.status = { observedGeneration: 1, availableReplicas: 1 }
        if (resource.kind === 'Job') resource.status = { succeeded: 1 }
        resources.set(request.path + '/' + body.metadata.name, resource)
        if (unknown) return { exitCode: null, state: 'unknown', recoveryRequired: true, stdout: '', stderr: '' }
        return { exitCode: 0, stdout: JSON.stringify(resource), stderr: '' }
      }
      assert.equal(request.method, 'DELETE')
      assert.equal(JSON.parse(request.body).preconditions.uid, resources.get(request.path).metadata.uid)
      resources.delete(request.path)
      f.deletes++
      if (f.unknownDelete) return { exitCode: null, state: 'unknown', recoveryRequired: true, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '{"kind":"Status","status":"Success"}', stderr: '' }
    },
    async kubernetesJson (request) {
      if (request.path === '/api/v1/nodes') return { items: ['node-a', 'node-b'].map(name => ({ metadata: { name, uid: name + '-uid' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } })) }
      if (request.path.includes('/pods?')) {
        const job = [...resources.values()].find(resource => resource.kind === 'Job' && request.path.includes(resource.metadata.name))
        return { items: [{ metadata: { name: 'validator-pod', ownerReferences: [{ uid: job.metadata.uid, kind: 'Job' }] } }] }
      }
      const result = await netdata.runApiRequest(request)
      if (result.exitCode) throw new Error('fixture resource absent')
      return JSON.parse(result.stdout)
    },
    async runRecoveryRequest (command) {
      const [version, operationLine, argsLine] = command.split('\n')
      assert.equal(version, 'v=1')
      const operation = operationLine.slice(10)
      const args = argsLine.slice(5).split(',')
      let result
      if (operation === 'key' || operation === 'initialize') result = { publicKey }
      else if (operation === 'list') result = { executions: [...ledger].map(([executionId, records]) => ({ executionId, sequence: records.length, head: planFingerprint(records.at(-1)) })).sort((a, b) => a.executionId.localeCompare(b.executionId)) }
      else if (operation === 'read') result = ledger.get(args[0])[Number(args[1]) - 1]
      else if (operation === 'ownership') result = { owned: owners.has(args[0]), ownerFingerprint: null }
      else if (operation === 'claim') {
        assert.ok(!owners.has(args[0]) || owners.get(args[0]) === args[3])
        owners.set(args[0], args[3]); result = { claimed: true }
      } else if (operation === 'release') { assert.equal(owners.get(args[0]), args[3]); owners.delete(args[0]); result = { released: true } } else {
        assert.equal(operation, 'append')
        assert.equal(owners.get(args[0]), args[3])
        const records = ledger.get(args[0]) ?? []
        assert.equal(records.length, Number(args[1]))
        assert.equal(records.length ? planFingerprint(records.at(-1)) : '-', args[2])
        result = signRecoveryRecord(JSON.parse(Buffer.from(args[5], 'base64url')), privateKey)
        records.push(result); ledger.set(args[0], records)
      }
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' }
    }
  }
  f.openCluster = async () => ({ uid: 'cluster-uid-one', netdata, persistent: true })
  f.service = new KubernetesTaskService({ dataRoot: directory, settings: { clusters: { lab: {} } }, openCluster: f.openCluster })
  f.identity = (await f.service.connect('lab')).historyId
  return f
}
