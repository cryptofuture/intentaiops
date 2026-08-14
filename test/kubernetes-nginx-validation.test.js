import assert from 'node:assert/strict'
import test from 'node:test'
import { revertNginxValidation, validateNginxFromAllNodes } from '../src/kubernetes-nginx-validation.js'

test('nginx validation creates one HTTP probe per ready node and supports clean revert', async () => {
  const createdJobs = []
  const deleted = []
  let pendingJobDeletion = false
  let jobDeletionProbes = 0
  const netdata = {
    async kubernetesJson ({ method, path, body }) {
      if (path === '/api/v1/nodes') {
        return {
          items: ['control', 'worker-a', 'worker-b'].map(name => ({
            metadata: { name },
            status: { conditions: [{ type: 'Ready', status: 'True' }] }
          }))
        }
      }
      if (method === 'POST' && path.endsWith('/jobs')) {
        createdJobs.push({ name: body.metadata.name, node: body.spec.template.spec.nodeName })
        return body
      }
      if (path.includes('/deployments/webminai-nginx')) {
        return { metadata: { generation: 1 }, status: { observedGeneration: 1, availableReplicas: 2 } }
      }
      if (path.includes('/jobs/')) return { status: { succeeded: 1 } }
      if (path.includes('/pods?labelSelector=')) return { items: [{ metadata: { name: `pod-${path.split('%3D')[1]}` } }] }
      return body || {}
    },
    async runApiRequest ({ method, path }) {
      if (method === 'DELETE') {
        deleted.push(path)
        if (path.includes('/jobs?labelSelector=')) pendingJobDeletion = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (method === 'GET' && path.includes('/jobs?labelSelector=')) {
        jobDeletionProbes++
        if (pendingJobDeletion) {
          pendingJobDeletion = false
          return { exitCode: 0, stdout: '{"items":[{}]}', stderr: '' }
        }
        return { exitCode: 0, stdout: '{"items":[]}', stderr: '' }
      }
      if (method === 'GET' && !path.includes('/pods/')) {
        return { exitCode: 22, stdout: '{"code":404,"reason":"NotFound"}', stderr: '' }
      }
      const job = createdJobs.find(candidate => path.includes(candidate.name))
      return { exitCode: 0, stdout: `WEBMINAI_NGINX_OK node=${job.node}\n`, stderr: '' }
    }
  }
  const report = await validateNginxFromAllNodes({ netdata })
  assert.equal(report.status, 'successful')
  assert.deepEqual(createdJobs.map(job => job.node).sort(), ['control', 'worker-a', 'worker-b'])
  assert.ok(report.nodes.every(node => node.reachable))
  await revertNginxValidation({ netdata })
  assert.ok(deleted.some(path => path.includes('/jobs?labelSelector=')))
  assert.ok(deleted.some(path => path.endsWith('/deployments/webminai-nginx')))
  assert.ok(deleted.some(path => path.endsWith('/services/webminai-nginx')))
  assert.ok(deleted.some(path => path.endsWith('/configmaps/webminai-nginx-page')))
  assert.ok(jobDeletionProbes >= 4, 'revert must poll until foreground job deletion is observable')
})
