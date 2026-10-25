import assert from 'node:assert/strict'
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function assertLabResources (resources, receipts = []) {
  const known = new Map(receipts.map(value => [value.path, value.uid]))
  for (const resource of resources) {
    assert.equal(typeof resource.uid, 'string', 'Resource UID is unavailable')
    assert.equal(known.get(resource.path), resource.uid, `Unowned or replaced resource blocks lab mutation: ${resource.path}`)
  }
}

export async function labResources (netdata) {
  const resources = []
  for (const prefix of ['/apis/apps/v1/namespaces/webminai-tasks/deployments', '/apis/batch/v1/namespaces/webminai-tasks/jobs', '/api/v1/namespaces/webminai-tasks/services', '/api/v1/namespaces/webminai-tasks/persistentvolumeclaims', '/api/v1/namespaces/webminai-tasks/configmaps']) {
    const response = await netdata.kubernetesJson({ method: 'GET', path: prefix })
    assert.ok(Array.isArray(response?.items) && response.items.length <= 128, 'Unexpected or oversized task-resource list')
    for (const item of response.items) {
      if (prefix.endsWith('/configmaps') && item.metadata?.name === 'kube-root-ca.crt') continue
      assert.match(item.metadata?.name ?? '', /^[a-z0-9][a-z0-9.-]{0,252}$/u)
      resources.push({ path: `${prefix}/${item.metadata.name}`, uid: item.metadata.uid })
    }
  }
  return resources
}

export class KubernetesLabCheckpoint {
  constructor (directory, clusterUid, statusFile = path.join(directory, 'status.md')) {
    this.directory = directory
    this.clusterUid = clusterUid
    this.file = path.join(directory, 'state.json')
    this.statusFile = statusFile
    this.state = { version: 1, clusterUid, tasks: {} }
    this.writes = Promise.resolve()
  }

  async load () {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'))
      assert.equal(saved.version, 1)
      assert.equal(saved.clusterUid, this.clusterUid, 'Checkpoint belongs to a different cluster')
      assert.ok(saved.tasks && typeof saved.tasks === 'object' && !Array.isArray(saved.tasks))
      this.state = saved
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return this
  }

  async record (catalogId, update, message) {
    assert.match(catalogId, /^[a-z0-9-]+$/u)
    this.writes = this.writes.then(async () => {
      const current = this.state.tasks[catalogId] ?? {}
      this.state.tasks[catalogId] = { ...current, ...(typeof update === 'function' ? update(current) : update), observedAt: new Date().toISOString() }
      await writeFile(this.file + '.tmp', JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
      await rename(this.file + '.tmp', this.file)
      if (message) await appendFile(this.statusFile, `\n- ${new Date().toISOString()} ${catalogId}: ${message}\n`)
    })
    return this.writes
  }

  async begin (catalogId) {
    return this.record(catalogId, current => {
      assert.ok(!current.status || ['passed-and-reverted', 'cleaned-after-failure'].includes(current.status), 'Incomplete lab work requires inspection, not another apply')
      const { priorAttempts = [], ...previous } = current
      assert.ok(priorAttempts.length < 32, 'Archive this checkpoint before further repeated lab cycles')
      return { executionId: randomUUID(), status: 'applying', receipts: [], intents: {}, nodes: null, cleanupOfStatus: null, historicalUncertainty: [], priorAttempts: previous.status ? [...priorAttempts, previous] : priorAttempts }
    }, 'Started explicitly approved disposable lab cycle; task namespace confirmed empty')
  }

  observe (netdata, catalogId) {
    const run = netdata.runApiRequest.bind(netdata)
    netdata.runApiRequest = async request => {
      if (request.method === 'GET') return run(request)
      if (request.method === 'DELETE' && !request.path.includes('?')) {
        const receipt = this.state.tasks[catalogId]?.receipts?.find(value => value.path === request.path)
        if (!receipt) {
          const observed = await run({ method: 'GET', path: request.path, timeoutSeconds: request.timeoutSeconds })
          let status
          try { status = JSON.parse(observed.stdout) } catch {}
          if (observed.exitCode !== 0 && status?.kind === 'Status' && status.code === 404) return observed
          throw new Error('Cleanup has no creation receipt; existing or uncertain resource preserved')
        }
        request = { ...request, body: { ...request.body, preconditions: { ...request.body?.preconditions, uid: receipt.uid } } }
      }
      const id = randomUUID()
      await this.record(catalogId, current => ({ intents: { ...current.intents, [id]: { method: request.method, path: request.path } } }))
      const result = await run(request)
      let object
      try { object = JSON.parse(result.stdout) } catch {}
      const created = typeof object?.metadata?.uid === 'string' && object.metadata.uid.length > 0 && object.metadata.uid.length <= 128 && object.metadata.namespace === 'webminai-tasks' && object.metadata.name === request.body?.metadata?.name && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(object.metadata.name ?? '')
      if (request.method === 'POST' && result.exitCode === 0 && !result.recoveryRequired && created) {
        await this.record(catalogId, current => ({ receipts: [...(current.receipts ?? []), { path: `${request.path}/${object.metadata.name}`, uid: object.metadata.uid }] }))
      }
      if (result.recoveryRequired || (result.exitCode === 0 && (!object || (request.method === 'POST' && !created)))) {
        await this.record(catalogId, { status: 'outcome-unknown' }, 'API mutation outcome unknown; no retry or cleanup authorized automatically')
        const error = new Error('API mutation outcome unknown; inspect the existing resource before continuation')
        error.recoveryRequired = true
        throw error
      }
      await this.record(catalogId, current => ({ intents: Object.fromEntries(Object.entries(current.intents).filter(([key]) => key !== id)) }))
      return result
    }
    return () => { netdata.runApiRequest = run }
  }
}
