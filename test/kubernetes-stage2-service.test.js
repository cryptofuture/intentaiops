import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KubernetesApiError } from '../src/kubernetes-client.js'
import { KubernetesStage2Service } from '../src/kubernetes-stage2-service.js'

const ACTION_KEY = 'ab'.repeat(32)

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
