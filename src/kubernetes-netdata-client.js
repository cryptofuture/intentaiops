import { createKubernetesApiCommand, parseKubernetesApiCommand, createSignedCommand } from './netdata-client.js'
import { executionDiagnostics, observation } from './execution-diagnostics.js'
import { kubernetesApiDiagnostics, kubernetesWorkloadDiagnostics } from './workload-execution-evidence.js'

export class KubernetesNetdataClient {
  constructor ({ kubernetes, actionKey, namespace = 'webminai-system', service = 'webminai-stage2', taskNamespace = 'webminai-tasks', onDiagnostics = (_diagnostics) => {} }) {
    this.kubernetes = kubernetes
    this.actionKey = actionKey
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(taskNamespace)) throw new TypeError('invalid task namespace')
    this.taskNamespace = taskNamespace
    this.onDiagnostics = onDiagnostics
    this.workloadReferences = new Map()
    this.diagnosticSignatures = new Map()
    this.proxyPrefix = `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(`${service}:19999`)}/proxy`
  }

  async info () {
    return this.request('/api/v3/info?options=full')
  }

  async functions () {
    return this.request('/api/v3/functions?options=debug')
  }

  async health () {
    return this.request('/api/v3/function?function=webminai%3Ahealth&timeout=10')
  }

  async runCommand (command, { timeoutSeconds = 30 } = {}) {
    const request = parseKubernetesApiCommand(command)
    let result
    try { result = await this.runApiRequest({ ...request, timeoutSeconds }) } catch (cause) {
      const error = new Error('Kubernetes API observation failed; inspect structured diagnostics before continuation.')
      if (['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause.code)) error.code = cause.code
      if (Number.isInteger(cause.statusCode) && cause.statusCode >= 400 && cause.statusCode <= 599) error.kubernetesHttpStatus = cause.statusCode
      error.recoveryRequired = request.method !== 'GET'
      throw error
    }
    let object
    try { object = JSON.parse(result.stdout) } catch {}
    const summary = publicResult(object)
    let stdout = JSON.stringify(summary)
    const truncated = Buffer.byteLength(stdout) > 32768
    if (truncated) stdout = JSON.stringify({ contentPolicy: summary.contentPolicy, kind: summary.kind, metadata: summary.metadata, truncated: true })
    return { ...result, stdout, stdoutTruncated: result.stdoutTruncated || truncated, stderr: result.stderr ? 'Kubernetes request did not complete normally; inspect structured diagnostics.' : '' }
  }

  async runRecoveryRequest (command, { timeoutSeconds = 30 } = {}) {
    if (typeof command !== 'string' || Buffer.byteLength(command) > 16384 || !/^v=1\noperation=(?:key|initialize|verification-key|rotate-key|list|read|ownership|release|claim|takeover|append)\nargs=[A-Za-z0-9_+/=,:-]*$/u.test(command)) throw new Error('Invalid fixed recovery request')
    const result = await this.request(`/api/v3/function?function=webminai%3Arecovery&timeout=${Math.min(60, timeoutSeconds)}`, { method: 'POST', body: createSignedCommand(command, this.actionKey), timeoutMs: (Math.min(60, timeoutSeconds) + 5) * 1000 })
    if (result?.outputEncoding !== 'base64') throw new Error('Invalid recovery gateway response')
    return { ...result, stdout: Buffer.from(result.stdout, 'base64').toString('utf8'), stderr: result.stderr ? 'Recovery storage request failed; inspect recorded state before continuation' : '' }
  }

  async runApiRequest ({ method, path, body, contentType, timeoutSeconds = 30 }) {
    const command = createKubernetesApiCommand({ method, path, body, contentType })
    const envelope = createSignedCommand(command, this.actionKey)
    const startedAt = new Date().toISOString()
    let result
    try {
      result = await this.request(`/api/v3/function?function=webminai%3Acommand&timeout=${timeoutSeconds}`, {
        method: 'POST',
        body: envelope,
        timeoutMs: (timeoutSeconds + 5) * 1000
      })
    } catch (error) {
      error.diagnostics = [...kubernetesApiDiagnostics(error.statusCode), ...executionDiagnostics({ result: { exitCode: null }, error })]
      error.recoveryRequired = method !== 'GET'
      this.reportDiagnostics(error.diagnostics, path)
      throw error
    }
    if (result?.outputEncoding === 'base64') {
      result = {
        ...result,
        stdout: Buffer.from(result.stdout, 'base64').toString('utf8'),
        stderr: Buffer.from(result.stderr, 'base64').toString('utf8')
      }
    }
    let object
    try { object = JSON.parse(result.stdout) } catch {}
    if (object?.kind === 'Status' && Number.isInteger(object.code) && object.code >= 400 && object.code <= 599) result = { ...result, kubernetesHttpStatus: object.code }
    const diagnostics = executionDiagnostics({ result })
    const reference = this.workloadReferences.get(path)
    if (method === 'GET' && reference && result.exitCode === 0) diagnostics.push(...kubernetesWorkloadDiagnostics(object, reference))
    if (result.exitCode === 0 && !result.timedOut && ['POST', 'PUT', 'PATCH'].includes(method) && ['Pod', 'Deployment', 'Job'].includes(object?.kind) && object.metadata?.namespace === this.taskNamespace && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(object.metadata?.name ?? '')) {
      const prefix = object.kind === 'Pod' ? '/api/v1' : object.kind === 'Deployment' ? '/apis/apps/v1' : '/apis/batch/v1'
      const resource = object.kind === 'Pod' ? 'pods' : object.kind === 'Deployment' ? 'deployments' : 'jobs'
      this.workloadReferences.set(`${prefix}/namespaces/${this.taskNamespace}/${resource}/${object.metadata.name}`, { uid: object.metadata.uid, generation: object.metadata.generation, startedAt })
      if (this.workloadReferences.size > 64) this.workloadReferences.delete(this.workloadReferences.keys().next().value)
    }
    if (diagnostics.length) {
      result = { ...result, diagnostics }
      this.reportDiagnostics(diagnostics, path)
    }
    if (method !== 'GET') {
      const rejected = object?.kind === 'Status' && Number.isInteger(object.code) && object.code >= 400 && object.code < 500 && object.code !== 408
      const identity = typeof object?.metadata?.uid === 'string' && object.metadata.uid.length > 0 && object.metadata.uid.length <= 128
      const listKinds = { pods: 'PodList', jobs: 'JobList', deployments: 'DeploymentList', replicasets: 'ReplicaSetList', services: 'ServiceList', configmaps: 'ConfigMapList', persistentvolumeclaims: 'PersistentVolumeClaimList' }
      const resource = path.split('?')[0].split('/').at(-1)
      const deletedList = Array.isArray(object?.items) && Object.hasOwn(listKinds, resource) && object.kind === listKinds[resource]
      const deleted = method === 'DELETE' && (deletedList || (object?.kind === 'Status' && object.status === 'Success' && (object.code === undefined || (Number.isInteger(object.code) && object.code >= 200 && object.code < 300))))
      const acknowledged = result.exitCode === 0 && !result.timedOut && typeof object?.kind === 'string' && (identity || deleted)
      if ((!acknowledged && !rejected) || result.timedOut || result.recoveryRequired) result = { ...result, state: 'unknown', recoveryRequired: true }
    }
    return result
  }

  async collectWorkloadEvidence ({ path, uid, startedAt, generation }) {
    const safeNamespace = /^[a-z0-9][a-z0-9-]{0,62}$/u.test(this.taskNamespace)
    const allowed = new RegExp(`^/(?:api/v1/namespaces/${this.taskNamespace}/pods|apis/(?:apps/v1/namespaces/${this.taskNamespace}/deployments|batch/v1/namespaces/${this.taskNamespace}/jobs))/[a-z0-9][a-z0-9.-]{0,252}$`, 'u')
    if (!safeNamespace || !allowed.test(path)) throw new TypeError('workload diagnostics require one task-namespace Pod, Deployment or Job')
    const result = await this.runApiRequest({ method: 'GET', path, timeoutSeconds: 5 })
    if (result.exitCode !== 0) return result.diagnostics ?? []
    try { return kubernetesWorkloadDiagnostics(JSON.parse(result.stdout), { uid, startedAt, generation }) } catch { return executionDiagnostics({ result: { exitCode: null } }) }
  }

  reportDiagnostics (diagnostics, key) {
    const visible = diagnostics.filter(value => !['WORKLOAD_NOT_READY', 'CONTAINER_NOT_STARTED'].includes(value.code))
    if (!visible.length) return
    const signature = JSON.stringify(visible.map(({ observedAt, ...value }) => value))
    if (this.diagnosticSignatures.get(key) === signature) return
    this.diagnosticSignatures.set(key, signature)
    if (this.diagnosticSignatures.size > 64) this.diagnosticSignatures.delete(this.diagnosticSignatures.keys().next().value)
    try { Promise.resolve(this.onDiagnostics(visible)).catch(() => {}) } catch {}
  }

  async kubernetesJson (request) {
    const result = await this.runApiRequest(request)
    if (result.exitCode !== 0 || result.recoveryRequired) {
      const error = new Error(`Kubernetes gateway request failed with exit code ${result.exitCode}: ${result.stderr.trim() || 'no error output'}`)
      /** @type {any} */
      const detailedError = error
      detailedError.result = result.recoveryRequired ? { exitCode: result.exitCode, state: result.state, timedOut: result.timedOut, recoveryRequired: true } : result
      detailedError.diagnostics = result.diagnostics ?? []
      detailedError.recoveryRequired = result.recoveryRequired === true
      throw detailedError
    }
    try {
      return result.stdout.length === 0 ? null : JSON.parse(result.stdout)
    } catch {
      const error = new Error('Kubernetes gateway returned invalid JSON. Inspect resource state before continuing.')
      error.diagnostics = [observation('INVALID_API_RESPONSE', 'unknown', 'transport', 'kubernetes-api', 'The API response could not be decoded; raw response content is withheld.')]
      error.recoveryRequired = request.method !== 'GET'
      this.reportDiagnostics(error.diagnostics, request.path)
      throw error
    }
  }

  /** @param {string} path @param {{method?: string, body?: any, contentType?: string, timeoutMs?: number}} [options] */
  async request (path, { method = 'GET', body, contentType, timeoutMs = 35000 } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new TypeError('invalid Netdata API path')
    return this.kubernetes.request(`${this.proxyPrefix}${path}`, {
      method,
      body,
      contentType,
      timeoutMs
    })
  }
}

function publicResult (object, depth = 0) {
  const summary = { contentPolicy: 'metadata-status-only' }
  if (!object || typeof object !== 'object') return summary
  for (const key of ['kind', 'status', 'reason']) if (typeof object[key] === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(object[key])) summary[key] = object[key]
  if (Number.isInteger(object.code) && object.code >= 100 && object.code <= 599) summary.code = object.code
  const metadata = {}
  for (const key of ['name', 'namespace', 'uid', 'resourceVersion']) if (typeof object.metadata?.[key] === 'string' && /^[A-Za-z0-9_.:-]{1,253}$/u.test(object.metadata[key])) metadata[key] = object.metadata[key]
  if (Number.isSafeInteger(object.metadata?.generation)) metadata.generation = object.metadata.generation
  if (Object.keys(metadata).length) summary.metadata = metadata
  const status = {}
  for (const key of ['succeeded', 'failed', 'readyReplicas', 'availableReplicas']) if (Number.isSafeInteger(object.status?.[key]) && object.status[key] >= 0) status[key] = object.status[key]
  if (['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'].includes(object.status?.phase)) status.phase = object.status.phase
  if (Array.isArray(object.status?.conditions)) status.conditions = object.status.conditions.slice(0, 16).map(condition => Object.fromEntries(['type', 'status', 'reason'].filter(key => typeof condition?.[key] === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(condition[key])).map(key => [key, condition[key]])))
  if (Object.keys(status).length) summary.workloadStatus = status
  if (depth === 0 && Array.isArray(object.items)) summary.items = object.items.slice(0, 128).map(item => publicResult(item, depth + 1))
  return summary
}
