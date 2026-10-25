import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, chmod, stat, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KubernetesApiError } from '../src/kubernetes-client.js'
import { KubernetesStage2Service } from '../src/kubernetes-stage2-service.js'

const ACTION_KEY = 'ab'.repeat(32)

test('recovery PVC initialization restricts a fresh root but preserves unsafe nonempty roots and rejects symlinks', async () => {
  let deployment
  const service = new KubernetesStage2Service({
    kubernetes: {
      async request (_path, options = {}) {
        if (!options.method) throw new KubernetesApiError('missing', { statusCode: 404 })
        deployment = options.body
        return options.body
      }
    }
  })
  await service.ensureDeployment({ chunkNames: [], digest: 'a'.repeat(64), actionKeyDigest: 'b'.repeat(64), recovery: { claimName: 'webminai-recovery', target: 'SHA256:' + 'c'.repeat(64) } })
  const body = deployment.spec.template.spec.initContainers.find(container => container.name === 'initialize-recovery-storage').args[0]
  for (const scenario of ['fresh', 'private', 'unsafe', 'symlink']) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-recovery-root-'))
    try {
      const root = path.join(directory, 'volume')
      await mkdir(root)
      await chmod(root, scenario === 'private' ? 0o700 : 0o777)
      if (scenario === 'unsafe' || scenario === 'private') await writeFile(path.join(root, 'preserved'), 'existing')
      let target = root
      if (scenario === 'symlink') { target = path.join(directory, 'link'); await symlink(root, target) }
      const script = body.replaceAll('/recovery', target)
      const result = spawnSync('/bin/sh', ['-ceu', 'stat() { if test "$1" = -c && test "$2" = %u; then printf 0; else command stat "$@"; fi; }; ' + script], { encoding: 'utf8' })
      assert.equal(result.status === 0, ['fresh', 'private'].includes(scenario))
      assert.equal((await stat(root)).mode & 0o777, ['fresh', 'private'].includes(scenario) ? 0o700 : 0o777)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('fresh cluster credentials are adopted only from a managed valid Secret with existing API authorization', async () => {
  const calls = []
  const secret = { metadata: { labels: { 'app.kubernetes.io/managed-by': 'webminai' } }, data: { 'action.key': Buffer.from(ACTION_KEY + '\n').toString('base64') } }
  const service = new KubernetesStage2Service({ kubernetes: { async request (path, options) { calls.push({ path, options }); return secret } } })
  assert.equal(await service.existingActionKey(), ACTION_KEY)
  assert.ok(calls.every(call => !call.options))
  secret.metadata.labels = {}
  await assert.rejects(service.existingActionKey(), /not managed or valid/u)
  service.kubernetes.request = async () => { throw new KubernetesApiError('forbidden', { statusCode: 403 }) }
  await assert.rejects(service.existingActionKey(), error => error.statusCode === 403)
})

test('persistent recovery storage is explicit, cluster-bound and never replaced or removed by deactivation', async () => {
  const objects = new Map()
  const calls = []
  const kubernetes = {
    async request (path, options = {}) {
      calls.push({ path, ...options })
      if (path === '/api/v1/namespaces/kube-system') return { metadata: { uid: 'verified-cluster-one' } }
      if (path.startsWith('/apis/storage.k8s.io/')) return { metadata: { name: 'standard' } }
      if (options.method === 'POST') { objects.set(path + '/' + options.body.metadata.name, structuredClone(options.body)); return options.body }
      if (options.method === 'DELETE') return {}
      if (!objects.has(path)) throw new KubernetesApiError('missing', { statusCode: 404 })
      return structuredClone(objects.get(path))
    }
  }
  const service = new KubernetesStage2Service({ kubernetes })
  assert.equal(await service.ensureRecoveryStorage(), null)
  assert.ok(calls.every(call => !call.method))
  const recovery = await service.ensureRecoveryStorage('standard')
  const claimPath = '/api/v1/namespaces/webminai-system/persistentvolumeclaims/webminai-recovery'
  assert.equal(objects.get(claimPath).spec.storageClassName, 'standard')
  assert.equal(objects.get(claimPath).metadata.annotations['webminai.io/recovery-target'], recovery.target)
  assert.deepEqual(await service.ensureRecoveryStorage(), recovery)
  await assert.rejects(service.ensureRecoveryStorage('other'), /mismatch/u)
  await assert.rejects(service.ensureRecoveryStorage('../../other'), /Invalid/u)
  await service.ensureDeployment({ chunkNames: [], digest: 'a'.repeat(64), actionKeyDigest: 'b'.repeat(64), recovery })
  const deployment = objects.get('/apis/apps/v1/namespaces/webminai-system/deployments/webminai-stage2')
  assert.equal(deployment.spec.replicas, 1)
  assert.equal(deployment.spec.strategy.type, 'Recreate')
  assert.ok(deployment.spec.template.spec.containers[0].env.some(value => value.name === 'WEBMINAI_RECOVERY_TARGET' && value.value === recovery.target))
  assert.ok(deployment.spec.template.spec.volumes.some(volume => volume.persistentVolumeClaim?.claimName === recovery.claimName))
  const result = await service.deactivate()
  assert.equal(result.recoveryStoragePreserved, true)
  assert.ok(!calls.some(call => call.method === 'DELETE' && (call.path === '/api/v1/namespaces/webminai-system' || call.path === claimPath)))
  objects.get(claimPath).metadata.annotations['webminai.io/recovery-target'] = 'wrong-cluster'
  await assert.rejects(service.ensureRecoveryStorage(), /identity or class mismatch/u)
  objects.get(claimPath).metadata.labels = {}
  await assert.rejects(service.ensureRecoveryStorage(), /unowned/u)
})

test('gateway lifecycle shares cluster mutation ownership and releases it after completion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kubernetes-ownership-'))
  let finish
  let started
  const entered = new Promise(resolve => { started = resolve })
  const hold = new Promise(resolve => { finish = resolve })
  const options = { dataRoot: directory, kubernetes: { async request () { return { metadata: { uid: 'cluster-one' } } } } }
  const first = new KubernetesStage2Service(options)
  const second = new KubernetesStage2Service(options)
  first.activateGateway = async () => { started(); await hold; return 'done' }
  second.deactivateGateway = async () => 'removed'
  const pending = first.activate({ actionKey: ACTION_KEY })
  try {
    await entered
    await assert.rejects(second.deactivate(), /Another operator/u)
    finish()
    assert.equal(await pending, 'done')
    assert.equal(await second.deactivate(), 'removed')
    second.kubernetes = { async request () { return {} } }
    await assert.rejects(second.deactivate(), /identity unavailable/u)
  } finally { finish(); await pending; await rm(directory, { recursive: true, force: true }) }
})

test('gateway rollout allows bounded cold pulls and reports only allowlisted readiness evidence', async () => {
  const progress = []
  const service = new KubernetesStage2Service({
    readinessAttempts: 1,
    onProgress: event => progress.push(event),
    kubernetes: {
      async request (path) {
        if (path.includes('/deployments/')) return { metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, availableReplicas: 0 } }
        assert.match(path, /labelSelector=app.kubernetes.io%2Fname%3Dwebminai-stage2/u)
        return { items: [{ status: { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'secret-token' } } }, { state: { waiting: { reason: 'secret-token' } } }] } }] }
      }
    }
  })
  await assert.rejects(service.waitForDeployment(), /ImagePullBackOff.*Resources remain in place/u)
  assert.ok(progress.length > 0)
  assert.doesNotMatch(JSON.stringify(progress), /secret-token/u)
  assert.equal(new KubernetesStage2Service({ kubernetes: {} }).readinessAttempts, 600)
  service.kubernetes.request = async () => { throw new Error('secret-token') }
  assert.equal(await service.gatewayReadiness(), 'Pod evidence unavailable')
})

test('remote recovery remains unavailable without a durable gateway backend and performs no API writes', () => {
  const service = new KubernetesStage2Service({ kubernetes: { request () { assert.fail('capability inspection must not access or mutate the cluster') } } })
  assert.equal(service.remoteRecoveryCapabilities().available, false)
  assert.match(service.remoteRecoveryCapabilities().reason, /persistent volume/u)
})

test('Kubernetes Stage 2 uploads bounded plugin chunks and installs least-privilege gateway RBAC', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-kubernetes-stage2-'))
  const pluginPath = path.join(directory, 'webminai.plugin')
  await writeFile(pluginPath, Buffer.alloc(800 * 1024, 7))
  const objects = new Map()
  const kubernetes = {
    async version () { return { gitVersion: 'v1.36.1' } },
    async nodes () { return { items: [{ metadata: { name: 'node-a' } }, { metadata: { name: 'node-b' } }] } },
    async request (requestPath, options = {}) {
      const method = options.method || 'GET'
      if (requestPath.includes('/services/webminai-stage2%3A19999/proxy/api/v3/function')) {
        return { status: 'ok', platform: 'kubernetes', executionMode: 'kubernetes-api', version: '0.5.0' }
      }
      if (method === 'POST') {
        const itemPath = `${requestPath}/${options.body.metadata.name}`
        objects.set(itemPath, structuredClone(options.body))
        return structuredClone(options.body)
      }
      if (method === 'PUT') {
        objects.set(requestPath, structuredClone(options.body))
        return structuredClone(options.body)
      }
      if (method === 'DELETE') {
        objects.delete(requestPath)
        return { status: 'Success' }
      }
      const object = objects.get(requestPath)
      if (!object) throw new KubernetesApiError('missing', { statusCode: 404 })
      const result = structuredClone(object)
      result.metadata.resourceVersion ||= '1'
      result.metadata.generation ||= 1
      if (result.kind === 'Deployment') {
        result.status = { observedGeneration: 1, availableReplicas: result.spec.replicas }
      }
      return result
    }
  }
  try {
    const service = new KubernetesStage2Service({
      kubernetes,
      pluginPath,
      pluginVersion: '0.5.0',
      readinessAttempts: 1
    })
    const result = await service.activate({ actionKey: ACTION_KEY })
    assert.equal(result.status, 'active')
    assert.deepEqual(result.nodes, ['node-a', 'node-b'])
    const chunks = [...objects.values()].filter(object => object.metadata?.labels?.['webminai.io/plugin-chunk'] === 'true')
    assert.equal(chunks.length, 2)
    assert.ok(chunks.every(secret => Buffer.from(secret.data.chunk, 'base64').length <= 700 * 1024))
    const role = objects.get('/apis/rbac.authorization.k8s.io/v1/namespaces/webminai-tasks/roles/webminai-stage2-tasks')
    assert.ok(role.rules.some(rule => rule.resources.includes('jobs')))
    assert.ok(role.rules.some(rule => rule.resources.includes('persistentvolumeclaims')))
    assert.equal(role.rules.some(rule => rule.resources.includes('secrets')), false)
    assert.equal(role.rules.some(rule => rule.resources.includes('daemonsets')), false)
    const clusterRole = objects.get('/apis/rbac.authorization.k8s.io/v1/clusterroles/webminai-stage2-node-reader')
    assert.deepEqual(clusterRole.rules, [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list'] }])
  } finally {
    await rm(directory, { recursive: true })
  }
})
