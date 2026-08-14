const TASK_NAMESPACE = 'webminai-tasks'
const LABEL_SELECTOR = 'webminai.io%2Fvalidation%3Dnginx-all-nodes'

export async function validateNginxFromAllNodes ({ netdata, namespace = TASK_NAMESPACE, onProgress = (_event) => {} }) {
  await revertNginxValidation({ netdata, namespace, onProgress })
  const nodes = await gatewayJson(netdata, { method: 'GET', path: '/api/v1/nodes' })
  const nodeNames = nodes.items
    .filter(node => node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'))
    .map(node => node.metadata.name)
  if (nodeNames.length === 0) throw new Error('no ready Kubernetes nodes were returned by Stage 2')

  onProgress({ phase: 'install', message: 'Creating the nginx page, Deployment, and internal Service' })
  await gatewayJson(netdata, {
    method: 'POST',
    path: `/api/v1/namespaces/${namespace}/configmaps`,
    body: configMap(namespace)
  })
  await gatewayJson(netdata, {
    method: 'POST',
    path: `/apis/apps/v1/namespaces/${namespace}/deployments`,
    body: deployment(namespace)
  })
  await gatewayJson(netdata, {
    method: 'POST',
    path: `/api/v1/namespaces/${namespace}/services`,
    body: service(namespace)
  })
  await waitForDeployment(netdata, namespace)

  onProgress({ phase: 'validate', message: `Starting one HTTP validation Job on each of ${nodeNames.length} nodes` })
  const jobs = []
  await Promise.all(nodeNames.map(async nodeName => {
    const name = jobName(nodeName)
    await gatewayJson(netdata, {
      method: 'POST',
      path: `/apis/batch/v1/namespaces/${namespace}/jobs`,
      body: validationJob(namespace, name, nodeName)
    })
    jobs.push({ name, nodeName })
  }))

  const results = await Promise.all(jobs.map(async job => {
    await waitForJob(netdata, namespace, job.name)
    const pods = await gatewayJson(netdata, {
      method: 'GET',
      path: `/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${job.name}`
    })
    const podName = pods.items[0]?.metadata?.name
    if (!podName) throw new Error(`validation pod for ${job.nodeName} was not found`)
    const output = await gatewayText(netdata, {
      method: 'GET',
      path: `/api/v1/namespaces/${namespace}/pods/${podName}/log`
    })
    if (!output.includes(`WEBMINAI_NGINX_OK node=${job.nodeName}`)) {
      throw new Error(`nginx validation on ${job.nodeName} returned unexpected output`)
    }
    onProgress({ phase: 'node', message: `${job.nodeName}: nginx page reachable` })
    return { node: job.nodeName, reachable: true }
  }))

  return {
    status: 'successful',
    nodes: results,
    workload: `${namespace}/webminai-nginx`,
    service: `http://webminai-nginx.${namespace}.svc.cluster.local`
  }
}

export async function revertNginxValidation ({ netdata, namespace = TASK_NAMESPACE, onProgress = (_event) => {} }) {
  const resources = [
    `/apis/batch/v1/namespaces/${namespace}/jobs?labelSelector=${LABEL_SELECTOR}`,
    `/apis/apps/v1/namespaces/${namespace}/deployments/webminai-nginx`,
    `/api/v1/namespaces/${namespace}/services/webminai-nginx`,
    `/api/v1/namespaces/${namespace}/configmaps/webminai-nginx-page`
  ]
  for (const path of resources) await gatewayDeleteIgnoringMissing(netdata, path)
  onProgress({ phase: 'revert', message: 'Removed nginx validation resources' })
  return { status: 'reverted' }
}

async function waitForDeployment (netdata, namespace) {
  for (let attempt = 1; attempt <= 180; attempt++) {
    const current = await gatewayJson(netdata, {
      method: 'GET',
      path: `/apis/apps/v1/namespaces/${namespace}/deployments/webminai-nginx`
    })
    if (current.status?.observedGeneration >= current.metadata.generation && current.status?.availableReplicas === 2) return
    await delay(1000)
  }
  throw new Error('nginx Deployment did not become ready')
}

async function waitForJob (netdata, namespace, name) {
  for (let attempt = 1; attempt <= 180; attempt++) {
    const current = await gatewayJson(netdata, {
      method: 'GET',
      path: `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`
    })
    if (current.status?.succeeded === 1) return
    if (current.status?.failed > 0) throw new Error(`nginx validation Job failed on ${current.spec?.template?.spec?.nodeName ?? name}`)
    await delay(1000)
  }
  throw new Error(`nginx validation Job timed out: ${name}`)
}

async function gatewayJson (netdata, request) {
  return netdata.kubernetesJson({ ...request, timeoutSeconds: 30 })
}

async function gatewayText (netdata, request) {
  const result = await netdata.runApiRequest({ ...request, timeoutSeconds: 30 })
  if (result.exitCode !== 0) throw new Error(`Kubernetes gateway request failed: ${result.stderr.trim()}`)
  return result.stdout
}

async function gatewayDeleteIgnoringMissing (netdata, path) {
  const result = await netdata.runApiRequest({
    method: 'DELETE',
    path,
    body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground' },
    timeoutSeconds: 30
  })
  if (result.exitCode === 0) {
    await waitForDeletion(netdata, path)
    return
  }
  let status
  try {
    status = JSON.parse(result.stdout)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  if (status?.code === 404 || status?.reason === 'NotFound') return
  throw new Error(`Kubernetes gateway delete failed: ${result.stderr.trim() || result.stdout.trim()}`)
}

async function waitForDeletion (netdata, path) {
  for (let attempt = 1; attempt <= 120; attempt++) {
    const result = await netdata.runApiRequest({ method: 'GET', path, timeoutSeconds: 30 })
    if (result.exitCode !== 0) {
      let status
      try {
        status = JSON.parse(result.stdout)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      if (status?.code === 404 || status?.reason === 'NotFound') return
      throw new Error(`Kubernetes gateway deletion probe failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    let current
    try {
      current = JSON.parse(result.stdout)
    } catch (cause) {
      throw new Error(`Kubernetes gateway deletion probe returned invalid JSON: ${cause.message}`, { cause })
    }
    if (Array.isArray(current.items) && current.items.length === 0) return
    await delay(500)
  }
  throw new Error(`Kubernetes resource deletion timed out: ${path}`)
}

function labels () {
  return {
    'app.kubernetes.io/name': 'webminai-nginx-validation',
    'app.kubernetes.io/managed-by': 'webminai',
    'webminai.io/validation': 'nginx-all-nodes'
  }
}

function configMap (namespace) {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'webminai-nginx-page', namespace, labels: labels() },
    data: { 'index.html': 'WEBMINAI_NGINX_OK\n' }
  }
}

function deployment (namespace) {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'webminai-nginx', namespace, labels: labels() },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'webminai-nginx' } },
      template: {
        metadata: { labels: { app: 'webminai-nginx', ...labels() } },
        spec: {
          containers: [{
            name: 'nginx',
            image: 'nginx:alpine',
            ports: [{ name: 'http', containerPort: 80 }],
            readinessProbe: { httpGet: { path: '/', port: 'http' }, periodSeconds: 2 },
            resources: {
              requests: { cpu: '10m', memory: '16Mi' },
              limits: { cpu: '250m', memory: '128Mi' }
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'] }
            },
            volumeMounts: [{ name: 'page', mountPath: '/usr/share/nginx/html/index.html', subPath: 'index.html', readOnly: true }]
          }],
          volumes: [{ name: 'page', configMap: { name: 'webminai-nginx-page' } }]
        }
      }
    }
  }
}

function service (namespace) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'webminai-nginx', namespace, labels: labels() },
    spec: { selector: { app: 'webminai-nginx' }, ports: [{ name: 'http', port: 80, targetPort: 'http' }] }
  }
}

function validationJob (namespace, name, nodeName) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace, labels: labels() },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 120,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: labels() },
        spec: {
          nodeName,
          restartPolicy: 'Never',
          containers: [{
            name: 'validator',
            image: 'busybox:1.37.0',
            command: ['/bin/sh', '-ceu'],
            args: [`body=$(wget -qO- --timeout=10 http://webminai-nginx.${namespace}.svc.cluster.local)\ntest "$body" = WEBMINAI_NGINX_OK\nprintf 'WEBMINAI_NGINX_OK node=%s\\n' '${nodeName}'`],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65534,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
              seccompProfile: { type: 'RuntimeDefault' }
            },
            resources: {
              requests: { cpu: '5m', memory: '8Mi' },
              limits: { cpu: '100m', memory: '32Mi' }
            }
          }]
        }
      }
    }
  }
}

function jobName (nodeName) {
  const suffix = nodeName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 38)
  return `webminai-nginx-${suffix}`
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
