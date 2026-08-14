import { createKubernetesApiCommand, createSignedCommand } from './netdata-client.js'

export class KubernetesNetdataClient {
  constructor ({ kubernetes, actionKey, namespace = 'webminai-system', service = 'webminai-stage2' }) {
    this.kubernetes = kubernetes
    this.actionKey = actionKey
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
    const result = await this.request(`/api/v3/function?function=webminai%3Acommand&timeout=${timeoutSeconds}`, {
      method: 'POST',
      body: envelope,
      timeoutMs: (timeoutSeconds + 5) * 1000
    })
    if (result?.outputEncoding !== 'base64') return result
    return {
      ...result,
      stdout: Buffer.from(result.stdout, 'base64').toString('utf8'),
      stderr: Buffer.from(result.stderr, 'base64').toString('utf8')
    }
  }

  async kubernetesJson (request) {
    const result = await this.runApiRequest(request)
    if (result.exitCode !== 0) {
      const error = new Error(`Kubernetes gateway request failed with exit code ${result.exitCode}: ${result.stderr.trim() || 'no error output'}`)
      /** @type {any} */
      const detailedError = error
      detailedError.result = result
      throw detailedError
    }
    try {
      return result.stdout.length === 0 ? null : JSON.parse(result.stdout)
    } catch (cause) {
      throw new Error(`Kubernetes gateway returned invalid JSON: ${cause.message}`, { cause })
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
