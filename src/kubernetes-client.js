import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { load as parseYaml } from 'js-yaml'

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export class KubernetesApiError extends Error {
  /**
   * @param {string} message
   * @param {{statusCode?: number, body?: any, method?: string, path?: string, cause?: unknown}} [options]
   */
  constructor (message, { statusCode, body, method, path, cause } = {}) {
    super(message, { cause })
    this.name = 'KubernetesApiError'
    this.statusCode = statusCode
    this.body = body
    this.method = method
    this.path = path
  }
}

export class KubernetesClient {
  constructor ({ server, ca, cert, key, token, contextName = null, clusterName = null, requestImpl = https.request }) {
    const url = new URL(server)
    if (url.protocol !== 'https:') throw new TypeError('Kubernetes API server must use HTTPS')
    if (!ca) throw new TypeError('Kubernetes certificate authority is required')
    if ((!cert || !key) && !token) throw new TypeError('Kubernetes client certificate or token is required')
    this.server = url
    this.ca = ca
    this.cert = cert
    this.key = key
    this.token = token
    this.contextName = contextName
    this.clusterName = clusterName
    this.requestImpl = requestImpl
  }

  static async fromKubeconfig (kubeconfigPath, options = {}) {
    const source = await readFile(kubeconfigPath, 'utf8')
    return KubernetesClient.fromKubeconfigSource(source, options)
  }

  static fromKubeconfigSource (source, options = {}) {
    if (typeof source !== 'string' || source.trim().length === 0) throw new TypeError('kubeconfig source must be non-empty YAML')
    const config = parseYaml(source)
    const selected = selectKubeconfigCredentials(config)
    return new KubernetesClient({ ...selected, ...options })
  }

  /** @param {string} path @param {{method?: string, body?: any, contentType?: string, timeoutMs?: number}} [options] */
  async request (path, { method = 'GET', body, contentType = 'application/json', timeoutMs = 30000 } = {}) {
    validateRequestPath(path)
    const normalizedMethod = String(method).toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) {
      throw new TypeError('unsupported Kubernetes API method')
    }
    const serializedBody = body === undefined || body === null
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body)
    const url = new URL(path, this.server)
    const headers = { Accept: 'application/json' }
    if (serializedBody !== undefined) {
      headers['Content-Type'] = contentType
      headers['Content-Length'] = Buffer.byteLength(serializedBody)
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    return new Promise((resolve, reject) => {
      const request = this.requestImpl(url, {
        method: normalizedMethod,
        ca: this.ca,
        cert: this.cert,
        key: this.key,
        headers,
        timeout: timeoutMs
      }, response => {
        const chunks = []
        let received = 0
        response.on('data', chunk => {
          received += chunk.length
          if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk)
          else request.destroy(new Error('Kubernetes API response is too large'))
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text.length === 0 ? null : JSON.parse(text)
          } catch (error) {
            reject(new KubernetesApiError(`Kubernetes API returned invalid JSON: ${error.message}`, {
              statusCode: response.statusCode,
              method: normalizedMethod,
              path,
              cause: error
            }))
            return
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const reason = parsed?.message || parsed?.reason || `HTTP ${response.statusCode}`
            reject(new KubernetesApiError(`Kubernetes ${normalizedMethod} ${path} failed: ${reason}`, {
              statusCode: response.statusCode,
              body: parsed,
              method: normalizedMethod,
              path
            }))
            return
          }
          resolve(parsed)
        })
      })
      request.once('timeout', () => request.destroy(new Error(`Kubernetes ${normalizedMethod} ${path} timed out`)))
      request.once('error', reject)
      request.end(serializedBody)
    })
  }

  async version () {
    return this.request('/version')
  }

  async nodes () {
    return this.request('/api/v1/nodes')
  }
}

function selectKubeconfigCredentials (config) {
  if (!config || typeof config !== 'object') throw new TypeError('invalid kubeconfig')
  const currentContext = requiredString(config['current-context'], 'kubeconfig current-context')
  const context = findNamedEntry(config.contexts, currentContext, 'context').context
  const cluster = findNamedEntry(config.clusters, requiredString(context.cluster, 'context cluster'), 'cluster').cluster
  const user = findNamedEntry(config.users, requiredString(context.user, 'context user'), 'user').user
  if (cluster['insecure-skip-tls-verify'] === true) {
    throw new TypeError('insecure Kubernetes TLS verification is not supported')
  }
  if (cluster['certificate-authority'] || user['client-certificate'] || user['client-key'] || user.exec || user['auth-provider']) {
    throw new TypeError('kubeconfig file references and executable authentication are not supported; embed certificate data or a token')
  }
  return {
    server: requiredString(cluster.server, 'cluster server'),
    ca: decodeData(cluster['certificate-authority-data'], 'certificate authority'),
    cert: optionalData(user['client-certificate-data'], 'client certificate'),
    key: optionalData(user['client-key-data'], 'client key'),
    token: optionalString(user.token),
    contextName: currentContext,
    clusterName: context.cluster
  }
}

function findNamedEntry (entries, name, type) {
  if (!Array.isArray(entries)) throw new TypeError(`kubeconfig ${type} list is missing`)
  const entry = entries.find(candidate => candidate?.name === name)
  if (!entry || !entry[type]) throw new TypeError(`kubeconfig ${type} ${name} is missing`)
  return entry
}

function decodeData (value, label) {
  const encoded = requiredString(value, label)
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length === 0) throw new TypeError(`${label} is empty`)
  return decoded
}

function optionalData (value, label) {
  return value === undefined ? undefined : decodeData(value, label)
}

function requiredString (value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is missing`)
  return value
}

function optionalString (value) {
  if (value === undefined) return undefined
  return requiredString(value, 'user token')
}

function validateRequestPath (path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..')) {
    throw new TypeError('invalid Kubernetes API path')
  }
}
