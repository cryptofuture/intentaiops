import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { KubernetesApiError, KubernetesClient } from '../src/kubernetes-client.js'

test('Kubernetes client preserves invalid JSON as the API error cause', async () => {
  const client = new KubernetesClient({
    server: 'https://cluster.example',
    ca: Buffer.from('ca'),
    token: 'token',
    requestImpl: responseRequest(503, '{invalid')
  })

  await assert.rejects(client.version(), error => {
    assert.ok(error instanceof KubernetesApiError)
    assert.ok(error.cause instanceof SyntaxError)
    assert.equal(error.statusCode, 503)
    assert.equal(error.method, 'GET')
    assert.equal(error.path, '/version')
    return true
  })
})

test('Kubernetes client loads embedded TLS credentials without invoking external auth', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-kubeconfig-'))
  const kubeconfig = path.join(directory, 'config')
  const encoded = value => Buffer.from(value).toString('base64')
  await writeFile(kubeconfig, `
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${encoded('ca')}
    server: https://cluster.example:6443
  name: lab
contexts:
- context:
    cluster: lab
    user: admin
  name: lab
current-context: lab
users:
- name: admin
  user:
    client-certificate-data: ${encoded('cert')}
    client-key-data: ${encoded('key')}
`)
  let observed
  const requestImpl = (url, options, callback) => {
    observed = { url: url.href, options }
    const request = new EventEmitter()
    request.end = () => {
      const response = new PassThrough()
      response.statusCode = 200
      callback(response)
      response.end('{"gitVersion":"v1.36.1"}')
    }
    request.destroy = error => request.emit('error', error)
    return request
  }
  try {
    const client = await KubernetesClient.fromKubeconfig(kubeconfig, { requestImpl })
    assert.deepEqual(await client.version(), { gitVersion: 'v1.36.1' })
    assert.equal(observed.url, 'https://cluster.example:6443/version')
    assert.equal(observed.options.ca.toString(), 'ca')
    assert.equal(observed.options.cert.toString(), 'cert')
    assert.equal(observed.options.key.toString(), 'key')
    assert.equal(observed.options.rejectUnauthorized, undefined)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('Kubernetes client loads pasted kubeconfig YAML and exposes safe context metadata', () => {
  const encoded = value => Buffer.from(value).toString('base64')
  const client = KubernetesClient.fromKubeconfigSource(`
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${encoded('ca')}
    server: https://cluster.example:6443
  name: production-api
contexts:
- context:
    cluster: production-api
    user: administrator
  name: production
current-context: production
users:
- name: administrator
  user:
    token: secret-token
`)

  assert.equal(client.server.origin, 'https://cluster.example:6443')
  assert.equal(client.contextName, 'production')
  assert.equal(client.clusterName, 'production-api')
})

test('Kubernetes client rejects insecure TLS and executable kubeconfig authentication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-kubeconfig-'))
  const kubeconfig = path.join(directory, 'config')
  await writeFile(kubeconfig, `
clusters:
- name: lab
  cluster:
    server: https://cluster.example
    insecure-skip-tls-verify: true
contexts:
- name: lab
  context: {cluster: lab, user: admin}
current-context: lab
users:
- name: admin
  user:
    exec: {command: steal-credentials}
`)
  try {
    await assert.rejects(KubernetesClient.fromKubeconfig(kubeconfig), /insecure Kubernetes TLS/)
  } finally {
    await rm(directory, { recursive: true })
  }
})

function responseRequest (statusCode, body) {
  return (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      const response = new PassThrough()
      response.statusCode = statusCode
      callback(response)
      response.end(body)
    }
    request.destroy = error => request.emit('error', error)
    return request
  }
}
