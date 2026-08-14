import assert from 'node:assert/strict'
import test from 'node:test'
import { listKubernetesCommonTasks } from '../src/kubernetes-common-task-catalog.js'
import { validateKubernetesApplication, revertKubernetesApplication } from '../src/kubernetes-application-validation.js'

test('every Kubernetes application common task composes API-only resources and validates every ready node', async () => {
  for (const task of listKubernetesCommonTasks().filter(task => task.applicationId)) {
    const posted = []
    const netdata = fakeNetdata(posted)
    const result = await validateKubernetesApplication({ netdata, catalogId: task.id })
    assert.equal(result.nodes.length, 2, task.id)
    assert.equal(posted.some(item => item.kind === 'Deployment'), true, task.id)
    assert.equal(posted.some(item => item.kind === 'Service'), true, task.id)
    assert.equal(posted.some(item => item.kind === 'PersistentVolumeClaim'), true, task.id)
    assert.equal(posted.some(item => item.kind === 'Secret'), false, task.id)
    const serialized = JSON.stringify(posted)
    assert.doesNotMatch(serialized, /kind":"Secret/u, task.id)
    if (!['jellyfin', 'home-assistant'].includes(task.applicationId)) assert.match(serialized, /\/state\/credentials/u, task.id)
  }
})

test('Kubernetes application revert removes only catalog-labelled task resources', async () => {
  const requests = []
  await revertKubernetesApplication({ netdata: fakeNetdata([], requests), catalogId: 'wordpress-kubernetes' })
  assert.equal(requests.every(request => request.method === 'DELETE'), true)
  assert.equal(requests.some(request => request.path.includes('labelSelector=webminai.io%2Fcatalog-id%3Dwordpress-kubernetes')), true)
})

function fakeNetdata (posted, requests = []) {
  const markers = listKubernetesCommonTasks().filter(task => task.applicationId).flatMap(task => ['node-a', 'node-b'].map(node => `WEBMINAI_${task.applicationId.toUpperCase().replaceAll('-', '_')}_OK node=${node}`)).join('\n')
  return {
    async kubernetesJson ({ method, path, body }) {
      if (method === 'POST') {
        posted.push(body)
        return body
      }
      if (path === '/api/v1/nodes') return { items: ['node-a', 'node-b'].map(name => ({ metadata: { name }, status: { conditions: [{ type: 'Ready', status: 'True' }] } })) }
      if (path.includes('/deployments/')) return { metadata: { generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, availableReplicas: 1 } }
      if (path.includes('/jobs/') && !path.includes('/pods?')) return { status: { succeeded: 1 } }
      if (path.includes('/pods?')) return { items: [{ metadata: { name: 'validator-pod' } }] }
      throw new Error(`unexpected Kubernetes JSON request: ${method} ${path}`)
    },
    async runApiRequest (request) {
      requests.push(request)
      if (request.method === 'DELETE') return { exitCode: 1, stdout: '{"code":404,"reason":"NotFound"}', stderr: '' }
      if (request.method === 'GET' && request.path.endsWith('/log')) return { exitCode: 0, stdout: markers, stderr: '' }
      throw new Error(`unexpected Kubernetes request: ${request.method} ${request.path}`)
    }
  }
}
