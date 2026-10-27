import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { KubernetesApiError } from './kubernetes-client.js'
import { KubernetesNetdataClient } from './kubernetes-netdata-client.js'
import { PLUGIN_VERSION } from './plugin-version.js'
import { diagnosticSummary } from './execution-diagnostics.js'
import { withHostMutation } from './host-mutation-ownership.js'

const SYSTEM_NAMESPACE = 'webminai-system'
const TASK_NAMESPACE = 'webminai-tasks'
const SERVICE_ACCOUNT = 'webminai-stage2'
const SERVICE_NAME = 'webminai-stage2'
// Stable Kubernetes object name; keep it separate from the secret value.
const ACTION_KEY_SECRET = ['webminai', 'stage2', 'action', 'key'].join('-')
const RECOVERY_CLAIM = 'webminai-recovery'
const PLUGIN_CHUNK_BYTES = 700 * 1024
const MANAGED_LABELS = {
  'app.kubernetes.io/name': 'webminai-stage2',
  'app.kubernetes.io/managed-by': 'webminai'
}

export class KubernetesStage2Service {
  remoteRecoveryCapabilities (health, persistentVerified = false) {
    const available = persistentVerified === true && health?.recoveryProtocolVersion === 1 && health?.recoveryConfigured === true && health?.recoveryOpenSslAvailable === true
    return { version: 1, available, reason: available ? 'Persistent signed resource-bound recovery is available through the authenticated gateway. Recovery always requires a new catalog reconstruction, current-state inspection and explicit approval.' : 'Remote recovery requires an explicitly configured persistent volume, a verified cluster identity and a gateway-native signer with OpenSSL. No RBAC changes or pod-exec fallback are performed.' }
  }

  constructor ({
    kubernetes,
    pluginPath = fileURLToPath(new URL('../dist/webminai.plugin-kubernetes-amd64', import.meta.url)),
    pluginVersion = PLUGIN_VERSION,
    netdataImage = 'netdata/netdata:stable',
    assemblerImage = 'busybox:1.37.0',
    systemNamespace = SYSTEM_NAMESPACE,
    taskNamespace = TASK_NAMESPACE,
    dataRoot = null,
    readinessAttempts = 600,
    readinessIntervalMs = 1000,
    onProgress = (_event) => {}
  }) {
    this.kubernetes = kubernetes
    this.pluginPath = pluginPath
    this.pluginVersion = pluginVersion
    this.netdataImage = netdataImage
    this.assemblerImage = assemblerImage
    this.systemNamespace = systemNamespace
    this.taskNamespace = taskNamespace
    this.dataRoot = dataRoot
    this.readinessAttempts = readinessAttempts
    this.readinessIntervalMs = readinessIntervalMs
    this.onProgress = onProgress
  }

  async activate ({ actionKey, recoveryStorageClass }) {
    return this.withMutation(() => this.activateGateway({ actionKey, recoveryStorageClass }))
  }

  async withMutation (operation) {
    if (!this.dataRoot) return operation()
    const cluster = await this.kubernetes.request('/api/v1/namespaces/kube-system')
    const uid = cluster.metadata?.uid
    if (typeof uid !== 'string' || !uid || uid.length > 128) throw new Error('Cluster identity unavailable; gateway mutation blocked')
    return withHostMutation({ dataRoot: this.dataRoot, identity: `kubernetes:${uid}` }, operation)
  }

  async activateGateway ({ actionKey, recoveryStorageClass }) {
    validateActionKey(actionKey)
    const binary = await readFile(this.pluginPath)
    const digest = createHash('sha256').update(binary).digest('hex')
    const chunks = splitBuffer(binary, PLUGIN_CHUNK_BYTES)
    const suffix = digest.slice(0, 12)
    const chunkNames = chunks.map((chunk, index) => `webminai-plugin-${suffix}-${String(index).padStart(3, '0')}`)

    this.progress('connect', 'Checking Kubernetes API access')
    const [version, nodes] = await Promise.all([this.kubernetes.version(), this.kubernetes.nodes()])
    this.progress('credentials', `Connected to ${version.gitVersion}; ${nodes.items.length} nodes discovered`)

    await this.ensureNamespaces()
    const recovery = await this.ensureRecoveryStorage(recoveryStorageClass)
    await this.ensureRbac()
    await this.ensureConfig()
    await this.ensureActionKey(actionKey)
    this.progress('plugin', `Uploading plugin v${this.pluginVersion} as ${chunks.length} bounded Secret chunks`)
    for (let index = 0; index < chunks.length; index++) {
      await this.upsertNamespaced('secrets', chunkNames[index], {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: chunkNames[index],
          namespace: this.systemNamespace,
          labels: { ...MANAGED_LABELS, 'webminai.io/plugin-chunk': 'true' }
        },
        immutable: true,
        type: 'Opaque',
        data: { chunk: chunks[index].toString('base64') }
      })
    }

    const previousChunks = await this.deploymentChunkNames()
    await this.ensureService()
    await this.ensureDeployment({
      chunkNames,
      digest,
      actionKeyDigest: createHash('sha256').update(actionKey).digest('hex'),
      recovery
    })
    this.progress('rollout', 'Waiting for the gateway Netdata pod')
    await this.waitForDeployment()
    const netdata = new KubernetesNetdataClient({
      kubernetes: this.kubernetes,
      actionKey,
      namespace: this.systemNamespace,
      service: SERVICE_NAME,
      taskNamespace: this.taskNamespace,
      onDiagnostics: diagnostics => this.progress('execution-diagnostics', diagnosticSummary(diagnostics))
    })
    const health = await this.waitForPlugin(netdata)
    if (health.platform !== 'kubernetes' || health.executionMode !== 'kubernetes-api' || health.version !== this.pluginVersion) {
      throw new Error(`unexpected Kubernetes plugin health: ${JSON.stringify(health)}`)
    }
    await this.removeOldChunks(previousChunks, new Set(chunkNames))
    this.progress('ready', `Kubernetes Stage 2 plugin v${health.version} is ready`)
    return {
      status: 'active',
      platform: 'kubernetes',
      executionMode: 'kubernetes-api',
      pluginVersion: health.version,
      nodes: nodes.items.map(node => node.metadata.name),
      netdata
    }
  }

  async deactivate () {
    return this.withMutation(() => this.deactivateGateway())
  }

  async deactivateGateway () {
    const recovery = await this.readRecoveryClaim()
    await this.deleteIfPresent('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/webminai-stage2-node-reader')
    await this.deleteIfPresent('/apis/rbac.authorization.k8s.io/v1/clusterroles/webminai-stage2-node-reader')
    await this.deleteIfPresent(`/api/v1/namespaces/${this.taskNamespace}`)
    if (recovery) {
      await this.deleteIfPresent(`/apis/apps/v1/namespaces/${this.systemNamespace}/deployments/${SERVICE_NAME}`)
      await this.deleteIfPresent(`/api/v1/namespaces/${this.systemNamespace}/services/${SERVICE_NAME}`)
      this.progress('storage', 'Persistent recovery storage and its namespace were preserved; removal requires a separate explicit administrative action')
    } else await this.deleteIfPresent(`/api/v1/namespaces/${this.systemNamespace}`)
    return { status: 'inactive', recoveryStoragePreserved: Boolean(recovery) }
  }

  async readRecoveryClaim () {
    let claim
    try { claim = await this.kubernetes.request(`/api/v1/namespaces/${this.systemNamespace}/persistentvolumeclaims/${RECOVERY_CLAIM}`) } catch (error) { if (error.statusCode === 404) return null; throw error }
    if (claim.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'webminai' || claim.metadata?.deletionTimestamp) throw new Error('Recovery storage is unowned or deleting; gateway update blocked')
    return claim
  }

  async existingActionKey () {
    let secret
    try { secret = await this.kubernetes.request(`/api/v1/namespaces/${this.systemNamespace}/secrets/${ACTION_KEY_SECRET}`) } catch (error) { if (error.statusCode === 404) return null; throw error }
    if (secret.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'webminai' || typeof secret.data?.['action.key'] !== 'string' || secret.data['action.key'].length > 128) throw new Error('Existing gateway credentials are not managed or valid; no credentials were adopted')
    const key = Buffer.from(secret.data['action.key'], 'base64').toString('utf8').trim()
    validateActionKey(key)
    return key
  }

  async ensureRecoveryStorage (storageClass) {
    if (storageClass !== undefined && (typeof storageClass !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(storageClass))) throw new Error('Invalid recovery storage class')
    let claim = await this.readRecoveryClaim()
    if (!claim && storageClass === undefined) return null
    const cluster = await this.kubernetes.request('/api/v1/namespaces/kube-system')
    const uid = cluster.metadata?.uid
    if (typeof uid !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/u.test(uid)) throw new Error('Verified cluster identity is required for persistent recovery')
    const target = 'SHA256:' + createHash('sha256').update(uid).digest('hex')
    if (claim) {
      if (claim.metadata.annotations?.['webminai.io/recovery-target'] !== target || (storageClass !== undefined && claim.spec.storageClassName !== storageClass)) throw new Error('Recovery storage identity or class mismatch; existing data preserved')
    } else {
      await this.kubernetes.request(`/apis/storage.k8s.io/v1/storageclasses/${storageClass}`)
      claim = await this.kubernetes.request(`/api/v1/namespaces/${this.systemNamespace}/persistentvolumeclaims`, {
        method: 'POST',
        body: {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: { name: RECOVERY_CLAIM, namespace: this.systemNamespace, labels: MANAGED_LABELS, annotations: { 'webminai.io/recovery-target': target } },
          spec: { storageClassName: storageClass, accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } }
        }
      })
      this.progress('storage', 'Created dedicated persistent recovery claim; signing material is not stored in ConfigMaps or returned to clients')
    }
    return { claimName: RECOVERY_CLAIM, target }
  }

  async ensureNamespaces () {
    await this.upsertCluster('namespaces', this.systemNamespace, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: this.systemNamespace, labels: MANAGED_LABELS }
    })
    await this.upsertCluster('namespaces', this.taskNamespace, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: this.taskNamespace,
        labels: {
          ...MANAGED_LABELS,
          'pod-security.kubernetes.io/enforce': 'baseline',
          'pod-security.kubernetes.io/audit': 'restricted',
          'pod-security.kubernetes.io/warn': 'restricted'
        }
      }
    })
  }

  async ensureRbac () {
    await this.upsertNamespaced('serviceaccounts', SERVICE_ACCOUNT, {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: SERVICE_ACCOUNT, namespace: this.systemNamespace, labels: MANAGED_LABELS }
    })
    await this.upsertNamespacedRbac('roles', 'webminai-stage2-tasks', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name: 'webminai-stage2-tasks', namespace: this.taskNamespace, labels: MANAGED_LABELS },
      rules: [
        { apiGroups: [''], resources: ['pods'], verbs: ['create', 'get', 'list', 'watch', 'delete', 'deletecollection'] },
        { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
        { apiGroups: [''], resources: ['services', 'configmaps', 'persistentvolumeclaims'], verbs: ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete', 'deletecollection'] },
        { apiGroups: ['apps'], resources: ['deployments', 'replicasets'], verbs: ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete', 'deletecollection'] },
        { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'list', 'watch', 'update', 'patch', 'delete', 'deletecollection'] }
      ]
    })
    await this.upsertNamespacedRbac('rolebindings', 'webminai-stage2-tasks', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'webminai-stage2-tasks', namespace: this.taskNamespace, labels: MANAGED_LABELS },
      subjects: [{ kind: 'ServiceAccount', name: SERVICE_ACCOUNT, namespace: this.systemNamespace }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'webminai-stage2-tasks' }
    })
    await this.upsertRbacCluster('clusterroles', 'webminai-stage2-node-reader', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'webminai-stage2-node-reader', labels: MANAGED_LABELS },
      rules: [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list'] }]
    })
    await this.upsertRbacCluster('clusterrolebindings', 'webminai-stage2-node-reader', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'webminai-stage2-node-reader', labels: MANAGED_LABELS },
      subjects: [{ kind: 'ServiceAccount', name: SERVICE_ACCOUNT, namespace: this.systemNamespace }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'webminai-stage2-node-reader' }
    })
  }

  async ensureConfig () {
    await this.upsertNamespaced('configmaps', 'webminai-stage2-netdata', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'webminai-stage2-netdata', namespace: this.systemNamespace, labels: MANAGED_LABELS },
      data: {
        'netdata.conf': '[global]\n  run as user = root\n[plugins]\n  enable running new plugins = yes\n  check for new plugins every = 1\n  webminai = yes\n[web]\n  bind to = *\n'
      }
    })
  }

  async ensureActionKey (actionKey) {
    await this.upsertNamespaced('secrets', ACTION_KEY_SECRET, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: ACTION_KEY_SECRET, namespace: this.systemNamespace, labels: MANAGED_LABELS },
      type: 'Opaque',
      data: { 'action.key': Buffer.from(`${actionKey}\n`).toString('base64') }
    })
  }

  async ensureService () {
    await this.upsertNamespaced('services', SERVICE_NAME, {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: SERVICE_NAME, namespace: this.systemNamespace, labels: MANAGED_LABELS },
      spec: {
        type: 'ClusterIP',
        selector: { 'app.kubernetes.io/name': 'webminai-stage2' },
        ports: [{ name: 'http', port: 19999, targetPort: 19999, protocol: 'TCP' }]
      }
    })
  }

  async ensureDeployment ({ chunkNames, digest, actionKeyDigest, recovery }) {
    const chunkMounts = chunkNames.map((name, index) => ({
      name: `chunk-${index}`,
      mountPath: `/chunks/${String(index).padStart(3, '0')}`,
      readOnly: true
    }))
    const chunkVolumes = chunkNames.map((name, index) => ({
      name: `chunk-${index}`,
      secret: { secretName: name, defaultMode: 256 }
    }))
    const inputs = chunkNames.map((name, index) => `/chunks/${String(index).padStart(3, '0')}/chunk`).join(' ')
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: SERVICE_NAME, namespace: this.systemNamespace, labels: MANAGED_LABELS },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { 'app.kubernetes.io/name': 'webminai-stage2' } },
        template: {
          metadata: {
            labels: MANAGED_LABELS,
            annotations: {
              'webminai.io/plugin-sha256': digest,
              'webminai.io/plugin-version': this.pluginVersion,
              'webminai.io/action-key-sha256': actionKeyDigest
            }
          },
          spec: {
            serviceAccountName: SERVICE_ACCOUNT,
            automountServiceAccountToken: true,
            initContainers: [{
              name: 'assemble-plugin',
              image: this.assemblerImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: {
                runAsUser: 0,
                runAsNonRoot: false,
                allowPrivilegeEscalation: false
              },
              command: ['/bin/sh', '-ceu'],
              args: [`cat ${inputs} > /assembled/webminai.plugin\necho '${digest}  /assembled/webminai.plugin' | sha256sum -c -\nchmod 0555 /assembled/webminai.plugin`],
              volumeMounts: [...chunkMounts, { name: 'plugin', mountPath: '/assembled' }]
            }, ...(recovery
              ? [{
                  name: 'initialize-recovery-storage',
                  image: this.assemblerImage,
                  securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
                  command: ['/bin/sh', '-ceu'],
                  args: ['test ! -L /recovery; test "$(stat -c %u /recovery)" = 0; if test "$(stat -c %a /recovery)" != 700; then test -z "$(find /recovery -mindepth 1 -maxdepth 1 -print -quit)"; chmod 0700 /recovery; fi'],
                  volumeMounts: [{ name: 'recovery', mountPath: '/recovery' }]
                }]
              : [])],
            containers: [{
              name: 'netdata',
              image: this.netdataImage,
              imagePullPolicy: 'IfNotPresent',
              ...(recovery ? { env: [{ name: 'WEBMINAI_RECOVERY_TARGET', value: recovery.target }] } : {}),
              securityContext: {
                runAsUser: 0,
                runAsNonRoot: false,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] }
              },
              ports: [{ name: 'http', containerPort: 19999, protocol: 'TCP' }],
              readinessProbe: {
                httpGet: { path: '/api/v1/info', port: 'http' },
                initialDelaySeconds: 2,
                periodSeconds: 2,
                timeoutSeconds: 2,
                failureThreshold: 30
              },
              resources: {
                requests: { cpu: '25m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '512Mi' }
              },
              volumeMounts: [
                { name: 'plugin', mountPath: '/usr/libexec/netdata/plugins.d/webminai.plugin', subPath: 'webminai.plugin', readOnly: true },
                { name: 'action-key', mountPath: '/var/run/secrets/webminai', readOnly: true },
                { name: 'netdata-config', mountPath: '/etc/netdata/netdata.conf', subPath: 'netdata.conf', readOnly: true },
                { name: 'netdata-lib', mountPath: '/var/lib/netdata' },
                { name: 'netdata-cache', mountPath: '/var/cache/netdata' },
                ...(recovery ? [{ name: 'recovery', mountPath: '/var/lib/intentaiops' }] : [])
              ]
            }],
            volumes: [
              ...chunkVolumes,
              { name: 'plugin', emptyDir: {} },
              { name: 'action-key', secret: { secretName: ACTION_KEY_SECRET, defaultMode: 256 } },
              { name: 'netdata-config', configMap: { name: 'webminai-stage2-netdata', defaultMode: 292 } },
              { name: 'netdata-lib', emptyDir: {} },
              { name: 'netdata-cache', emptyDir: {} },
              ...(recovery ? [{ name: 'recovery', persistentVolumeClaim: { claimName: recovery.claimName } }] : [])
            ]
          }
        }
      }
    }
    await this.upsertApps('deployments', SERVICE_NAME, deployment)
  }

  async waitForDeployment () {
    let readiness = 'Pod evidence unavailable'
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt++) {
      const deployment = await this.kubernetes.request(`/apis/apps/v1/namespaces/${this.systemNamespace}/deployments/${SERVICE_NAME}`)
      const desired = deployment.spec?.replicas ?? 1
      if (deployment.status?.observedGeneration >= deployment.metadata.generation &&
          deployment.status?.availableReplicas === desired) return deployment
      if (attempt === 1 || attempt % 30 === 0 || attempt === this.readinessAttempts) {
        readiness = await this.gatewayReadiness()
        this.progress('rollout', `Waiting for gateway (${attempt}/${this.readinessAttempts}): ${readiness}`)
      }
      if (attempt < this.readinessAttempts) await delay(this.readinessIntervalMs)
    }
    throw new Error(`Kubernetes Stage 2 gateway deployment did not become ready: ${readiness}. Resources remain in place; inspect the existing rollout before another approved update.`)
  }

  async gatewayReadiness () {
    try {
      const pods = await this.kubernetes.request(`/api/v1/namespaces/${this.systemNamespace}/pods?labelSelector=app.kubernetes.io%2Fname%3Dwebminai-stage2`)
      const allowed = new Set(['PodInitializing', 'ContainerCreating', 'ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CrashLoopBackOff', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError'])
      const states = (pods.items ?? []).slice(0, 8).flatMap(pod => [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].slice(0, 16).map(container => {
        const reason = container.state?.waiting?.reason
        if (allowed.has(reason)) return reason
        if (container.state?.terminated) return container.state.terminated.exitCode === 0 ? 'Init/process completed' : 'Process terminated'
        if (container.state?.running) return container.ready ? 'Ready' : 'Running, not ready'
        return 'State unavailable'
      }))
      return [...new Set(states)].join(', ') || 'No container status available'
    } catch { return 'Pod evidence unavailable' }
  }

  async waitForPlugin (netdata) {
    let lastError
    for (let attempt = 1; attempt <= this.readinessAttempts; attempt++) {
      try {
        const health = await netdata.health()
        if (health?.status === 'ok') return health
      } catch (error) {
        lastError = error
      }
      if (attempt < this.readinessAttempts) await delay(this.readinessIntervalMs)
    }
    throw new Error(`Kubernetes Stage 2 Netdata function did not become ready: ${lastError?.message ?? 'unknown error'}`, { cause: lastError })
  }

  async deploymentChunkNames () {
    try {
      const deployment = await this.kubernetes.request(`/apis/apps/v1/namespaces/${this.systemNamespace}/deployments/${SERVICE_NAME}`)
      return (deployment.spec?.template?.spec?.volumes ?? [])
        .map(volume => volume.secret?.secretName)
        .filter(name => name?.startsWith('webminai-plugin-'))
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return []
      throw error
    }
  }

  async removeOldChunks (previous, current) {
    for (const name of previous) {
      if (!current.has(name)) await this.deleteIfPresent(`/api/v1/namespaces/${this.systemNamespace}/secrets/${name}`)
    }
  }

  async upsertNamespaced (resource, name, object) {
    return this.upsert(`/api/v1/namespaces/${this.systemNamespace}/${resource}`, name, object)
  }

  async upsertNamespacedRbac (resource, name, object) {
    return this.upsert(`/apis/rbac.authorization.k8s.io/v1/namespaces/${this.taskNamespace}/${resource}`, name, object)
  }

  async upsertApps (resource, name, object) {
    return this.upsert(`/apis/apps/v1/namespaces/${this.systemNamespace}/${resource}`, name, object)
  }

  async upsertCluster (resource, name, object) {
    return this.upsert(`/api/v1/${resource}`, name, object)
  }

  async upsertRbacCluster (resource, name, object) {
    return this.upsert(`/apis/rbac.authorization.k8s.io/v1/${resource}`, name, object)
  }

  async upsert (collectionPath, name, object) {
    const itemPath = `${collectionPath}/${name}`
    try {
      const current = await this.kubernetes.request(itemPath)
      object.metadata.resourceVersion = current.metadata.resourceVersion
      if (object.kind === 'Service') preserveServiceNetworkFields(object, current)
      return await this.kubernetes.request(itemPath, { method: 'PUT', body: object })
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 404) throw error
      return this.kubernetes.request(collectionPath, { method: 'POST', body: object })
    }
  }

  async deleteIfPresent (path) {
    try {
      return await this.kubernetes.request(path, {
        method: 'DELETE',
        body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground' }
      })
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) return null
      throw error
    }
  }

  progress (phase, message) {
    this.onProgress({ phase, message })
  }
}

function validateActionKey (actionKey) {
  if (!/^[a-f0-9]{64}$/i.test(actionKey)) throw new TypeError('action key must be a 32-byte hexadecimal key')
}

function splitBuffer (buffer, size) {
  const chunks = []
  for (let offset = 0; offset < buffer.length; offset += size) chunks.push(buffer.subarray(offset, offset + size))
  return chunks
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function preserveServiceNetworkFields (object, current) {
  for (const field of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'healthCheckNodePort']) {
    if (current.spec?.[field] !== undefined) object.spec[field] = current.spec[field]
  }
}
