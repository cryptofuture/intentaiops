import { createKubernetesApiCommand, createSignedCommand } from './netdata-client.js'
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
    const diagnostics = [...kubernetesApiDiagnostics(object?.kind === 'Status' ? object.code : undefined), ...executionDiagnostics({ result })]
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
    if (method !== 'GET' && (result.exitCode === null || result.timedOut || (object?.kind === 'Status' && [500, 502, 503, 504].includes(object.code)))) result = { ...result, recoveryRequired: true }
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
      detailedError.result = result
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
