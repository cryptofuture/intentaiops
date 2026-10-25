import { kubernetesCommonTask } from './kubernetes-common-task-catalog.js'
import { joomlaComposeAssets } from './joomla-task.js'
import { drupalComposeAssets } from './drupal-task.js'
import { prestaShopComposeAssets } from './prestashop-task.js'
import { moodleComposeAssets, moodleRelease } from './moodle-task.js'
import { magentoComposeAssets, magentoIndexerVerification } from './magento-task.js'
import { createKubernetesApiCommand } from './netdata-client.js'
import { planFingerprint } from './execution-journal.js'

const TASK_NAMESPACE = 'webminai-tasks'
const SUPPORTED_APPLICATIONS = new Set(['nginx', 'wordpress', 'woocommerce', 'joomla', 'drupal', 'prestashop', 'moodle', 'magento', 'n8n', 'ghost', 'mattermost', 'odoo', 'jellyfin', 'home-assistant'])

function workspaceTask (catalogId) {
  const task = kubernetesCommonTask(catalogId)
  if (task.id === 'nginx-static-site-kubernetes') task.applicationId = 'nginx'
  return task
}

export function buildKubernetesApplicationPlan ({ catalogId, executionId, nodes }) {
  const task = workspaceTask(catalogId)
  if (!SUPPORTED_APPLICATIONS.has(task.applicationId) || !/^[a-f0-9]{32}$/u.test(executionId) || !Array.isArray(nodes) || !nodes.length || nodes.length > 16 || new Set(nodes).size !== nodes.length || nodes.some(node => !/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(node))) throw new Error('Invalid Kubernetes catalog reconstruction parameters')
  const profile = applicationProfile(task, { namespace: TASK_NAMESPACE, adminEmail: 'intentaiops@example.invalid' })
  const paths = {
    PersistentVolumeClaim: `/api/v1/namespaces/${TASK_NAMESPACE}/persistentvolumeclaims`,
    Deployment: `/apis/apps/v1/namespaces/${TASK_NAMESPACE}/deployments`,
    Service: `/api/v1/namespaces/${TASK_NAMESPACE}/services`,
    Job: `/apis/batch/v1/namespaces/${TASK_NAMESPACE}/jobs`
  }
  const source = { type: 'verified-application', id: catalogId, version: 1 }
  const resources = [persistentVolumeClaim(task, TASK_NAMESPACE), deployment(task, profile, TASK_NAMESPACE), service(task, profile, TASK_NAMESPACE), ...[...nodes].sort().map(node => validationJob(task, profile, TASK_NAMESPACE, validationJobName(task, node), node))]
  const commands = resources.flatMap((body, index) => {
    body.metadata.labels['webminai.io/execution-id'] = executionId
    body.metadata.annotations = { 'webminai.io/definition-sha256': planFingerprint(body) }
    const command = { id: 'resource-' + index, command: createKubernetesApiCommand({ method: 'POST', path: paths[body.kind], body }), purpose: `Create ${body.kind} ${body.metadata.name}`, risk: 'change', timeoutMs: 300000, requiresSudo: false, phase: body.kind === 'Job' ? 'verify' : 'configure', dependsOn: index ? [index === 3 ? 'workload-ready' : index > 3 ? 'probe-' + (index - 1) : 'resource-' + (index - 1)] : [], source }
    return body.kind === 'Job' ? [command, { ...command, id: 'probe-' + index, command: createKubernetesApiCommand({ method: 'GET', path: paths.Job + '/' + body.metadata.name }), purpose: 'Observe this exact validation Job and confirm its application marker', risk: 'read', dependsOn: [command.id] }] : [command]
  })
  commands.splice(3, 0, { id: 'workload-ready', command: createKubernetesApiCommand({ method: 'GET', path: paths.Deployment + '/' + resourceName(task) }), purpose: 'Observe this exact Deployment until application readiness; inspection timeout never cancels or replays the workload', risk: 'read', timeoutMs: 300000, requiresSudo: false, phase: 'health', dependsOn: ['resource-2'], source })
  const revertCommands = resources.slice().reverse().map((body, index) => ({ id: 'revert-' + index, command: createKubernetesApiCommand({ method: 'DELETE', path: paths[body.kind] + '/' + body.metadata.name, body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', preconditions: { uid: 'review-required' } } }), purpose: `Review deletion of the signed original ${body.kind} UID; PVC deletion removes task data`, risk: 'destructive', timeoutMs: 300000, requiresSudo: false, source }))
  return { summary: task.label, changeOverview: 'Create task-owned persistent state, workload, Service and per-node health probes through the signed Kubernetes gateway', modifiedFiles: [], assumptions: ['Existing resources are never adopted', 'Recovery requires a separate current-UID review'], warnings: ['Application-generated data is deleted only through a separately approved recovery plan'], requiresConfirmation: true, commands, revertCommands, kubernetes: { catalogId, executionId, nodes: [...nodes].sort() } }
}

export async function inspectKubernetesApplicationReadiness (netdata, catalogId, uid, shouldContinue = () => true) {
  const task = workspaceTask(catalogId)
  const profile = applicationProfile(task, { namespace: TASK_NAMESPACE, adminEmail: 'intentaiops@example.invalid' })
  await waitForDeployment(netdata, TASK_NAMESPACE, resourceName(task), profile.deploymentAttempts ?? 360, uid, shouldContinue)
}

export async function inspectKubernetesValidationJob (netdata, body, uid, shouldContinue = () => true) {
  const path = `/apis/batch/v1/namespaces/${TASK_NAMESPACE}/jobs/${body.metadata.name}`
  await waitForJob(netdata, TASK_NAMESPACE, body.metadata.name, 300, uid, shouldContinue)
  const pods = await gatewayJson(netdata, { method: 'GET', path: `/api/v1/namespaces/${TASK_NAMESPACE}/pods?labelSelector=${encodeURIComponent('job-name=' + body.metadata.name)}` })
  const pod = pods.items?.find(pod => pod.metadata?.ownerReferences?.some(owner => owner.uid === uid && owner.kind === 'Job'))
  if (!pod || !/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(pod.metadata?.name ?? '')) throw new Error('Validation Pod ownership is unavailable')
  const current = await gatewayJson(netdata, { method: 'GET', path })
  if (current.metadata?.uid !== uid) throw new Error('Validation Job identity changed')
  const output = await gatewayText(netdata, { method: 'GET', path: `/api/v1/namespaces/${TASK_NAMESPACE}/pods/${pod.metadata.name}/log?limitBytes=8192` })
  const task = workspaceTask(body.metadata.labels['webminai.io/catalog-id'])
  if (!output.includes(validationMarker(task, body.spec.template.spec.nodeName))) throw new Error('Application validation marker is unavailable')
}

export async function validateKubernetesApplication ({ netdata, catalogId, namespace = TASK_NAMESPACE, adminEmail = 'intentaiops@example.invalid', onProgress = (_event) => {} }) {
  const task = kubernetesCommonTask(catalogId)
  if (!SUPPORTED_APPLICATIONS.has(task.applicationId)) throw new Error(`Kubernetes application adapter is not implemented yet: ${catalogId}`)
  for (const resource of [`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${resourceName(task)}`, `/apis/apps/v1/namespaces/${namespace}/deployments/${resourceName(task)}`, `/api/v1/namespaces/${namespace}/services/${resourceName(task)}`]) {
    if (await readResource(netdata, resource)) throw new Error('Existing application resource requires inspection and reviewed cleanup before another apply')
  }
  const profile = applicationProfile(task, { adminEmail, namespace })
  const nodes = await readyNodeNames(netdata)
  if (nodes.length === 0) throw new Error('no ready Kubernetes nodes were returned by Stage 2')

  onProgress({ phase: 'apply', message: `${task.label}: creating persistent state, Deployment, and Service` })
  await gatewayJson(netdata, { method: 'POST', path: `/api/v1/namespaces/${namespace}/persistentvolumeclaims`, body: persistentVolumeClaim(task, namespace) })
  const created = await gatewayJson(netdata, { method: 'POST', path: `/apis/apps/v1/namespaces/${namespace}/deployments`, body: deployment(task, profile, namespace) })
  await gatewayJson(netdata, { method: 'POST', path: `/api/v1/namespaces/${namespace}/services`, body: service(task, profile, namespace) })
  return verifyKubernetesApplication({ netdata, catalogId, namespace, adminEmail, onProgress, expectedDeploymentUid: created.metadata?.uid })
}

export async function verifyKubernetesApplication ({ netdata, catalogId, expectedDeploymentUid, namespace = TASK_NAMESPACE, adminEmail = 'intentaiops@example.invalid', onProgress = (_event) => {} }) {
  if (typeof expectedDeploymentUid !== 'string' || !expectedDeploymentUid) throw new Error('Confirmed Deployment UID is required before verification')
  const task = kubernetesCommonTask(catalogId)
  if (!SUPPORTED_APPLICATIONS.has(task.applicationId)) throw new Error('Unsupported Kubernetes application verification')
  const profile = applicationProfile(task, { adminEmail, namespace })
  await waitForDeployment(netdata, namespace, resourceName(task), profile.deploymentAttempts ?? 360, expectedDeploymentUid)
  const nodes = await readyNodeNames(netdata)
  if (!nodes.length) throw new Error('No ready nodes available for verification')

  onProgress({ phase: 'verify', message: `Validating ${task.applicationId} from ${nodes.length} ready nodes` })
  const results = await Promise.all(nodes.map(async node => {
    const name = validationJobName(task, node)
    await gatewayJson(netdata, { method: 'POST', path: `/apis/batch/v1/namespaces/${namespace}/jobs`, body: validationJob(task, profile, namespace, name, node) })
    await waitForJob(netdata, namespace, name, 180)
    const pods = await gatewayJson(netdata, { method: 'GET', path: `/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${name}` })
    const podName = pods.items[0]?.metadata?.name
    if (!podName) throw new Error(`validation pod for ${task.applicationId} on ${node} was not found`)
    const output = await gatewayText(netdata, { method: 'GET', path: `/api/v1/namespaces/${namespace}/pods/${podName}/log` })
    const marker = validationMarker(task, node)
    if (!output.includes(marker)) throw new Error(`${task.applicationId} validation on ${node} returned unexpected output`)
    onProgress({ phase: 'node', message: `${node}: ${task.applicationId} Service reachable` })
    return { node, reachable: true }
  }))
  return { status: 'successful', catalogId, application: task.applicationId, nodes: results, service: `http://${resourceName(task)}.${namespace}.svc.cluster.local:${task.port}` }
}

export async function revertKubernetesApplication ({ netdata, catalogId, namespace = TASK_NAMESPACE, expectedResources, onProgress = (_event) => {} }) {
  const task = kubernetesCommonTask(catalogId)
  if (!task.applicationId) throw new Error(`Kubernetes application adapter is not applicable: ${catalogId}`)
  const name = resourceName(task)
  const selector = encodeURIComponent(`webminai.io/catalog-id=${catalogId}`)
  const jobsPath = `/apis/batch/v1/namespaces/${namespace}/jobs`
  const jobs = await gatewayJson(netdata, { method: 'GET', path: `${jobsPath}?labelSelector=${selector}` })
  if (!Array.isArray(jobs?.items) || jobs.items.length > 128) throw new Error('Unexpected validation Job list; cleanup blocked')
  const expected = expectedResources ? new Map(expectedResources.map(resource => [resource.path, resource.uid])) : null
  const paths = [
    ...jobs.items.map(job => {
      if (!/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(job.metadata?.name ?? '')) throw new Error('Invalid validation Job identity')
      return `${jobsPath}/${job.metadata.name}`
    }),
    `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
    `/api/v1/namespaces/${namespace}/services/${name}`,
    `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`
  ]
  const removals = []
  for (const path of paths) {
    const resource = await readResource(netdata, path)
    if (!resource) continue
    const uid = resource.metadata?.uid
    if (typeof uid !== 'string' || !uid || resource.metadata?.labels?.['webminai.io/catalog-id'] !== catalogId || resource.metadata?.labels?.['app.kubernetes.io/managed-by'] !== 'webminai' || (expected && expected.get(path) !== uid)) throw new Error('Unowned or replaced application resource; cleanup blocked')
    removals.push({ path, uid, deleting: Boolean(resource.metadata.deletionTimestamp) })
  }
  for (const resource of removals) {
    if (!resource.deleting) await gatewayDeleteIgnoringMissing(netdata, resource.path, resource.uid)
    else await waitForDeletion(netdata, resource.path, resource.uid)
  }
  onProgress({ phase: 'revert', message: `Removed task-owned ${task.applicationId} resources` })
  return { status: 'reverted', catalogId }
}

function applicationProfile (task, options) {
  if (task.applicationId === 'nginx') {
    return {
      port: 80,
      path: '/',
      httpMarker: 'WEBMINAI_NGINX_OK',
      initScript: "mkdir -p /state/html; printf '%s\\n' '<!doctype html><title>Intent AI Ops</title><h1>WEBMINAI_NGINX_OK</h1>' > /state/html/index.html; chmod 0755 /state/html; chmod 0644 /state/html/index.html",
      containers: [{ name: 'nginx', image: task.images[0], volumeMounts: [{ name: 'state', mountPath: '/usr/share/nginx/html', subPath: 'html', readOnly: true }] }]
    }
  }
  if (['wordpress', 'woocommerce'].includes(task.applicationId)) return wordpressProfile(task, options)
  if (task.applicationId === 'joomla') return joomlaProfile(task, options)
  if (task.applicationId === 'drupal') return drupalProfile(task, options)
  if (task.applicationId === 'prestashop') return prestaShopProfile(task, options)
  if (task.applicationId === 'moodle') return moodleProfile(task, options)
  if (task.applicationId === 'magento') return magentoProfile(task, options)
  if (task.applicationId === 'n8n') {
    return {
      port: 5678,
      path: '/healthz',
      initScript: 'umask 077; mkdir -p /state/credentials /state/data; chown -R 1000:1000 /state/data; test -s /state/credentials/encryption_key || head -c 48 /dev/urandom | base64 > /state/credentials/encryption_key; chmod 0600 /state/credentials/encryption_key',
      containers: [{
        name: 'n8n',
        image: task.images[0],
        command: ['/bin/sh', '-ceu'],
        args: ['export N8N_ENCRYPTION_KEY="$(cat /state/credentials/encryption_key)"; exec /docker-entrypoint.sh start'],
        env: [
          { name: 'N8N_PORT', value: '5678' },
          { name: 'N8N_LISTEN_ADDRESS', value: '0.0.0.0' },
          { name: 'N8N_DIAGNOSTICS_ENABLED', value: 'false' },
          { name: 'N8N_VERSION_NOTIFICATIONS_ENABLED', value: 'false' },
          { name: 'N8N_SECURE_COOKIE', value: 'false' }
        ],
        volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/home/node/.n8n', subPath: 'data' }]
      }]
    }
  }
  if (task.applicationId === 'ghost') return ghostProfile(task)
  if (task.applicationId === 'mattermost') return mattermostProfile(task)
  if (task.applicationId === 'odoo') return odooProfile(task)
  if (task.applicationId === 'jellyfin') {
    return {
      port: 8096,
      path: '/health',
      initScript: 'mkdir -p /state/config /state/cache /state/media; chown -R 1000:1000 /state/config /state/cache /state/media',
      containers: [{
        name: 'jellyfin',
        image: task.images[0],
        volumeMounts: [{ name: 'state', mountPath: '/config', subPath: 'config' }, { name: 'state', mountPath: '/cache', subPath: 'cache' }, { name: 'state', mountPath: '/media', subPath: 'media', readOnly: true }]
      }]
    }
  }
  return {
    port: 8123,
    path: '/',
    initScript: "mkdir -p /state/config; test -s /state/config/configuration.yaml || printf '%s\\n' 'default_config:' > /state/config/configuration.yaml",
    containers: [{
      name: 'home-assistant',
      image: task.images[0],
      env: [{ name: 'TZ', value: 'Etc/UTC' }],
      volumeMounts: [{ name: 'state', mountPath: '/config', subPath: 'config' }]
    }]
  }
}

function drupalProfile (task, { adminEmail }) {
  const assets = drupalComposeAssets()
  const installer = assets.installer.join('\n').replaceAll('intentaiops@example.invalid', adminEmail)
  const initScript = credentialInit(['database_password', 'database_root_password', 'admin_password'], ['mysql', 'webroot', 'php-run', 'config'], ['999:999:mysql', '33:33:webroot', '33:33:php-run']) + `; chgrp 101 /state/webroot /state/php-run; chmod 2770 /state/webroot /state/php-run; printf '%s\\n' ${shellWord(kubernetesFpm(assets.phpFpm.join('\n')))} > /state/config/php-fpm.conf; printf '%s\\n' ${shellWord(assets.nginx.join('\n'))} > /state/config/nginx.conf; printf '%s\\n' ${shellWord(installer)} > /state/config/install-drupal.php; printf '%s\\n' ${shellWord(assets.reconciler.join('\n'))} > /state/config/reconcile-drupal.php; chmod 0644 /state/config/*`
  const initialize = [
    'ready=',
    'for attempt in $(seq 1 180); do if test -f /var/www/html/autoload.php; then ready=yes; break; fi; sleep 2; done',
    'test "$ready" = yes',
    'if ! test -f /var/www/html/sites/default/.webminai-installed; then WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DB_HOST=127.0.0.1 WEBMINAI_DB_NAME=webminai_drupal WEBMINAI_DB_USER=webminai_drupal WEBMINAI_DB_PASS_FILE=/state/credentials/database_password WEBMINAI_ADMIN_PASS_FILE=/state/credentials/admin_password php /state/config/install-drupal.php; fi',
    'WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DRUPAL_URL=http://127.0.0.1:80/ php /state/config/reconcile-drupal.php',
    `php -r ${shellWord('$root=\'/var/www/html\'; $settings=$root.\'/sites/default/settings.php\'; if (!is_file($settings)) exit(1); file_put_contents($root.\'/webminai-health\', "WEBMINAI_DRUPAL_OK\\n");')}`,
    'chgrp 101 /var/www/html /run/php-fpm; chmod 2770 /var/www/html /run/php-fpm; chmod 0644 /var/www/html/webminai-health',
    'while :; do sleep 3600; done'
  ].join('\n')
  return {
    port: 80,
    path: '/webminai-health',
    initScript,
    initContainers: [{
      name: 'seed-drupal-code',
      image: task.images[0],
      command: ['/bin/sh', '-ceu'],
      args: ['if ! test -f /state/webroot/autoload.php; then cp -a /var/www/html/. /state/webroot/; chown -R 33:101 /state/webroot; fi'],
      volumeMounts: [{ name: 'state', mountPath: '/state' }]
    }],
    containers: [
      databaseContainer(task.images[2], 'mysql', {
        env: [{ name: 'MARIADB_DATABASE', value: 'webminai_drupal' }, { name: 'MARIADB_USER', value: 'webminai_drupal' }, { name: 'MARIADB_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MARIADB_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }],
        port: 3306,
        mountPath: '/var/lib/mysql'
      }),
      { name: 'drupal', image: task.images[0], volumeMounts: phpApplicationMounts() },
      {
        name: 'initializer',
        image: task.images[0],
        command: ['/bin/sh', '-ceu'],
        args: [initialize],
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
        volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }]
      },
      nginxContainer(task.images[1])
    ]
  }
}

function joomlaProfile (task, { adminEmail }) {
  const assets = joomlaComposeAssets()
  const initScript = credentialInit(['database_password', 'database_root_password', 'admin_password'], ['mysql', 'webroot', 'php-run', 'config'], ['999:999:mysql', '33:33:webroot', '33:33:php-run']) + `; chgrp 101 /state/webroot /state/php-run; chmod 2770 /state/webroot /state/php-run; printf '%s\\n' ${shellWord(kubernetesFpm(assets.fpm))} > /state/config/php-fpm.conf; printf '%s\\n' ${shellWord(assets.nginx)} > /state/config/nginx.conf; printf '%s\\n' ${shellWord(assets.installer)} > /state/config/installer.php; chmod 0644 /state/config/php-fpm.conf /state/config/nginx.conf /state/config/installer.php`
  const initialize = [
    'ready=',
    'for attempt in $(seq 1 180); do if test -f /var/www/html/installation/joomla.php; then ready=yes; break; fi; sleep 2; done',
    'test "$ready" = yes',
    'if ! test -f /var/www/html/configuration.php; then WEBMINAI_DB_PASS_FILE=/state/credentials/database_password WEBMINAI_ADMIN_PASSWORD_FILE=/state/credentials/admin_password php -d auto_prepend_file=/state/config/installer.php /var/www/html/installation/joomla.php install --no-interaction --site-name=WEBMINAI_JOOMLA_OK --admin-user="Intent AI Ops Administrator" --admin-username=webminai_admin ' + `--admin-email=${shellWord(adminEmail)} --db-type=mysqli --db-host=127.0.0.1 --db-user=webminai_joomla --db-name=webminai_joomla --db-prefix=wmai_ --db-encryption=0; fi`,
    "printf '%s\\n' WEBMINAI_JOOMLA_OK > /var/www/html/webminai-health",
    'while :; do sleep 3600; done'
  ].join('; ')
  return {
    port: 80,
    path: '/webminai-health',
    initScript,
    containers: [
      databaseContainer(task.images[2], 'mysql', {
        env: [{ name: 'MARIADB_DATABASE', value: 'webminai_joomla' }, { name: 'MARIADB_USER', value: 'webminai_joomla' }, { name: 'MARIADB_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MARIADB_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }],
        port: 3306,
        mountPath: '/var/lib/mysql'
      }),
      {
        name: 'joomla',
        image: task.images[0],
        env: [{ name: 'JOOMLA_DB_HOST', value: '127.0.0.1:3306' }, { name: 'JOOMLA_DB_NAME', value: 'webminai_joomla' }, { name: 'JOOMLA_DB_USER', value: 'webminai_joomla' }, { name: 'JOOMLA_DB_PASSWORD_FILE', value: '/state/credentials/database_password' }],
        volumeMounts: phpApplicationMounts()
      },
      {
        name: 'initializer',
        image: task.images[0],
        command: ['/bin/sh', '-ceu'],
        args: [initialize],
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
        volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }]
      },
      nginxContainer(task.images[1])
    ]
  }
}

function prestaShopProfile (task, { adminEmail }) {
  const assets = prestaShopComposeAssets()
  const marker = 'WEBMINAI_PRESTASHOP_OK'
  const initScript = credentialInit(['database_password', 'database_root_password', 'admin_password'], ['mysql', 'webroot', 'php-run', 'config'], ['999:999:mysql', '33:33:webroot', '33:33:php-run']) + `; chgrp 101 /state/webroot /state/php-run; chmod 2770 /state/webroot /state/php-run; printf '%s\n' ${shellWord(kubernetesFpm(assets.phpFpm.join('\n')))} > /state/config/php-fpm.conf; printf '%s\n' ${shellWord(assets.nginx.join('\n'))} > /state/config/nginx.conf; printf '%s\n' ${shellWord(assets.installer.join('\n'))} > /state/config/installer.php; chmod 0644 /state/config/*`
  const base = `WEBMINAI_DB_PASS_FILE=/state/credentials/database_password WEBMINAI_ADMIN_PASSWORD_FILE=/state/credentials/admin_password php -d memory_limit=-1 -d auto_prepend_file=/state/config/installer.php /var/www/html/install/index_cli.php --domain=${resourceName(task)} --db_server=127.0.0.1 --db_user=webminai_prestashop --db_name=webminai_prestashop --db_clear=1 --prefix=wmai_ --name=${marker} --email=${shellWord(adminEmail)} --firstname=Intent AI Ops --lastname=Administrator --country=us --timezone=Etc/UTC --fixtures=0 --rewrite=1`
  const initialize = [
    'ready=',
    'for attempt in $(seq 1 240); do if test -f /var/www/html/install/index_cli.php; then ready=yes; break; fi; sleep 2; done',
    'test "$ready" = yes',
    'if ! test -f /var/www/html/.webminai-installed; then',
    `${base} --step=database >/dev/null`,
    `${base} --step=modules --modules=ps_linklist >/dev/null`,
    `${base} --step=theme,postInstall >/dev/null`,
    `${base} --step=finalize >/dev/null`,
    'rm -rf /var/www/html/install',
    `printf '%s\n' ${marker} > /var/www/html/webminai-health`,
    'touch /var/www/html/.webminai-installed',
    'chown -R 33:101 /var/www/html; chmod 0644 /var/www/html/webminai-health',
    'fi',
    'while :; do sleep 3600; done'
  ].join('\n')
  return {
    port: 80,
    path: '/webminai-health',
    deploymentAttempts: 900,
    initScript,
    containers: [
      databaseContainer(task.images[2], 'mysql', { env: [{ name: 'MARIADB_DATABASE', value: 'webminai_prestashop' }, { name: 'MARIADB_USER', value: 'webminai_prestashop' }, { name: 'MARIADB_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MARIADB_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }], port: 3306, mountPath: '/var/lib/mysql' }),
      { name: 'prestashop', image: task.images[0], volumeMounts: phpApplicationMounts() },
      { name: 'initializer', image: task.images[0], command: ['/bin/sh', '-ceu'], args: [initialize], securityContext: { runAsUser: 0, allowPrivilegeEscalation: false }, volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }] },
      nginxContainer(task.images[1])
    ]
  }
}

function moodleProfile (task, { adminEmail }) {
  /** @type {any} */
  const assets = moodleComposeAssets()
  const release = moodleRelease()
  const marker = 'WEBMINAI_MOODLE_OK'
  const initScript = credentialInit(['database_password', 'database_root_password', 'admin_password'], ['mysql', 'webroot', 'moodledata', 'php-run', 'config'], ['999:999:mysql', '33:33:webroot', '33:33:moodledata', '33:33:php-run']) + `; chgrp 101 /state/webroot /state/php-run; chmod 2770 /state/webroot /state/php-run; printf '%s\n' ${shellWord(kubernetesFpm(assets.fpm.join('\n')))} > /state/config/php-fpm.conf; printf '%s\n' ${shellWord(assets.phpIni.join('\n'))} > /state/config/php.ini; printf '%s\n' ${shellWord(assets.nginx.join('\n'))} > /state/config/nginx.conf; printf '%s\n' ${shellWord(assets.installer.join('\n'))} > /state/config/installer.php; chmod 0755 /state/config; chmod 0644 /state/config/*`
  const install = `WEBMINAI_DB_PASS_FILE=/run/webminai/database_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password php -d memory_limit=512M -d max_input_vars=5000 -d auto_prepend_file=/state/config/installer.php /var/www/html/admin/cli/install.php --non-interactive --agree-license --lang=en --wwwroot=http://${resourceName(task)} --dataroot=/var/moodledata --dbtype=mariadb --dbhost=127.0.0.1 --dbname=webminai_moodle --dbuser=webminai_moodle --prefix=wmai_ --fullname=${marker} --shortname=${marker} --adminuser=webminai_admin --adminemail=${shellWord(adminEmail)}`
  const runtime = [
    'apt-get update >/dev/null',
    'apt-get install -y --no-install-recommends curl ca-certificates libcurl4-openssl-dev libfreetype6-dev libicu-dev libjpeg62-turbo-dev libonig-dev libpng-dev libxml2-dev libzip-dev >/dev/null',
    'docker-php-ext-configure gd --with-freetype --with-jpeg >/dev/null',
    'docker-php-ext-install -j1 curl gd intl mbstring mysqli soap zip >/dev/null',
    'rm -rf /var/lib/apt/lists/*',
    `if ! test -f /var/www/html/public/version.php; then curl --fail --location --silent --show-error --output /tmp/moodle.tgz ${shellWord(release.url)}; printf '%s  %s\n' ${release.sha256} /tmp/moodle.tgz | sha256sum -c -; tar -xzf /tmp/moodle.tgz --strip-components=1 -C /var/www/html; rm /tmp/moodle.tgz; chown -R www-data:www-data /var/www/html /var/moodledata; fi`,
    'install -d -o www-data -g www-data -m 0700 /run/webminai; install -o www-data -g www-data -m 0400 /state/credentials/database_password /run/webminai/database_password; install -o www-data -g www-data -m 0400 /state/credentials/admin_password /run/webminai/admin_password',
    `if ! test -f /var/www/html/config.php; then su -s /bin/sh www-data -c ${shellWord(install)}; fi`,
    'rm -f /run/webminai/database_password /run/webminai/admin_password',
    `printf '%s\n' ${marker} > /var/www/html/public/webminai-health.txt`,
    'chown -R 33:101 /var/www/html; chown -R 33:33 /var/moodledata; find /var/www/html -type d -exec chmod g+rx {} +; find /var/www/html -type f -exec chmod g+r {} +; chmod 0644 /var/www/html/public/webminai-health.txt',
    '(while :; do php /var/www/html/admin/cli/cron.php --keep-alive=0 >/dev/null 2>&1 || true; sleep 60; done) &',
    'exec docker-php-entrypoint php-fpm'
  ].join('\n')
  return {
    port: 80,
    path: '/webminai-health.txt',
    deploymentAttempts: 1200,
    initScript,
    containers: [
      databaseContainer(task.images[2], 'mysql', { env: [{ name: 'MARIADB_DATABASE', value: 'webminai_moodle' }, { name: 'MARIADB_USER', value: 'webminai_moodle' }, { name: 'MARIADB_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MARIADB_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }], port: 3306, mountPath: '/var/lib/mysql' }),
      { name: 'moodle', image: release.phpImage, command: ['/bin/sh', '-ceu'], args: [runtime], securityContext: { runAsUser: 0, allowPrivilegeEscalation: false }, volumeMounts: [...phpApplicationMounts(), { name: 'state', mountPath: '/var/moodledata', subPath: 'moodledata' }, { name: 'state', mountPath: '/usr/local/etc/php/conf.d/zz-webminai-moodle.ini', subPath: 'config/php.ini', readOnly: true }] },
      nginxContainer(task.images[1])
    ]
  }
}

function magentoProfile (task, { adminEmail, namespace = TASK_NAMESPACE }) {
  /** @type {any} */
  const assets = magentoComposeAssets()
  const marker = 'WEBMINAI_MAGENTO_OK'
  const nginx = assets.nginx.join('\n').replace('    include /var/www/html/nginx.conf.sample;', '    location = /webminai-health { root /var/www/html; default_type text/plain; try_files /webminai-health =503; }\n    include /var/www/html/nginx.conf.sample;')
  const dirs = ['mysql', 'opensearch', 'valkey', 'webroot', 'php-run', 'config']
  const initScript = credentialInit(['database_username', 'database_password', 'database_root_password', 'admin_username', 'admin_password'], dirs, ['999:999:mysql', '1000:1000:opensearch', '999:999:valkey', '82:82:webroot', '82:82:php-run']) + `; chgrp 101 /state/webroot /state/php-run; chmod 2770 /state/webroot /state/php-run; printf '%s\n' ${shellWord(kubernetesFpm(assets.fpm.join('\n')))} > /state/config/php-fpm.conf; printf '%s\n' ${shellWord(nginx)} > /state/config/nginx.conf; printf '%s\n' ${shellWord(assets.installer.join('\n'))} > /state/config/installer.php; printf '%s\n' ${shellWord(assets.marker.join('\n'))} > /state/config/marker.php; chmod 0644 /state/config/*`
  const setup = 'cd /var/www/html; timeout 900 php -d memory_limit=2G -d auto_prepend_file=/state/config/installer.php bin/magento setup:install --no-interaction --no-ansi --cleanup-database --base-url=http://' + resourceName(task) + '.' + namespace + '.svc.cluster.local:' + task.port + '/ --db-host=127.0.0.1 --db-name=webminai_magento --backend-frontname=webminai_admin --admin-firstname=Intent --admin-lastname=Administrator --admin-email=' + shellWord(adminEmail) + ' --language=en_US --currency=USD --timezone=UTC --use-rewrites=1 --search-engine=opensearch --opensearch-host=127.0.0.1 --opensearch-port=9200 --opensearch-enable-auth=0 --session-save=redis --session-save-redis-host=127.0.0.1 --session-save-redis-db=2 --cache-backend=redis --cache-backend-redis-server=127.0.0.1 --cache-backend-redis-db=0 --page-cache=redis --page-cache-redis-server=127.0.0.1 --page-cache-redis-db=1'
  const asOwner = command => `su -s /bin/sh www-data -c ${shellWord(`cd /var/www/html; ${command}`)}`
  const failureSummary = 'foreach([\'setup\',\'schema\',\'mode\',\'marker\',\'index\',\'cache\',\'verify-schema\',\'verify-index\'] as $stage){$p=\'/state/config/magento-\'.$stage.\'-failure.json\';if(!is_file($p)||is_link($p)||filesize($p)>2048)continue;$x=json_decode(file_get_contents($p,false,null,0,2048),true);if(($x[\'version\']??null)!==1||($x[\'stage\']??null)!==$stage||!is_int($x[\'exitCode\']??null)||$x[\'exitCode\']<1||$x[\'exitCode\']>255||!in_array($x[\'reason\']??null,[\'unknown\',\'permission\',\'missing-path\',\'memory-allocation\',\'database\',\'incompatible\',\'contract\'],true))continue;echo \'MAGENTO_STEP_FAILURE \'.json_encode([\'version\'=>1,\'stage\'=>$stage,\'exitCode\'=>$x[\'exitCode\'],\'reason\'=>$x[\'reason\']])."\\n";}'
  const reportFailure = `php -r ${shellWord(failureSummary.replace('"\\\\n"', 'chr(10)'))}`
  const runStep = `run_step() {
step=$1; shift
case "$step" in setup|schema|mode|marker|index|cache|verify-schema|verify-index) ;; *) exit 78;; esac
log=/state/config/magento-$step.log
failure=/state/config/magento-$step-failure.json
test ! -L "$log"; test ! -L "$failure"
if test -e "$failure"; then log=/dev/null; fi
status_file=$(mktemp /state/config/magento-status.XXXXXX)
(set +e; "$@"; printf '%s\\n' "$?" > "$status_file") 2>&1 | { head -c 65536 > "$log"; cat >/dev/null; }
status=$(cat "$status_file"); rm -f "$status_file"
case "$status" in ''|*[!0-9]*) printf '%s\\n' MAGENTO_STEP_OUTCOME_UNKNOWN >&2; exit 78;; esac
if [ "$status" -ne 0 ]; then
reason=unknown
if grep -Eqi 'Permission denied|failed to open stream' "$log"; then reason=permission
elif grep -Eqi 'Could not open input file' "$log"; then reason=missing-path
elif grep -Eqi 'Allowed memory size|Cannot allocate memory' "$log"; then reason=memory-allocation
elif grep -Eqi 'not supported|incompatible version' "$log"; then reason=incompatible
elif grep -Eqi 'SQLSTATE|Access denied for user|Connection refused' "$log"; then reason=database
elif grep -Eqi 'Unknown option|option .*does not exist|syntax error' "$log"; then reason=contract
fi
if ! test -e "$failure"; then printf '{"version":1,"stage":"%s","exitCode":%s,"reason":"%s"}\\n' "$step" "$status" "$reason" > "$failure"; fi
${reportFailure}
exit "$status"
fi
}`
  const install = [
    'umask 077',
    runStep,
    'ready=',
    'for attempt in $(seq 1 300); do if test -f /var/www/html/bin/magento && curl -fsS http://127.0.0.1:9200/_cluster/health >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done',
    'test "$ready" = yes',
    'if ! test -f /state/config/magento-installed; then',
    `if test -e /state/config/magento-install-started || test -f /var/www/html/app/etc/env.php; then ${reportFailure}; printf '%s\\n' MAGENTO_INSTALLATION_REVIEW_REQUIRED >&2; exit 78; fi`,
    'touch /state/config/magento-install-started; chmod 0600 /state/config/magento-install-started',
    'install -d -o www-data -g www-data -m 0700 /run/webminai',
    'for name in database_username database_password admin_username admin_password; do install -o www-data -g www-data -m 0400 "/state/credentials/$name" "/run/webminai/$name"; done',
    "trap 'rm -f /run/webminai/database_username /run/webminai/database_password /run/webminai/admin_username /run/webminai/admin_password' EXIT",
    'export WEBMINAI_DB_USERNAME_FILE=/run/webminai/database_username WEBMINAI_DB_PASSWORD_FILE=/run/webminai/database_password WEBMINAI_ADMIN_USERNAME_FILE=/run/webminai/admin_username WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password',
    `run_step setup su -s /bin/sh www-data -c ${shellWord(setup)}`,
    'run_step schema ' + asOwner('php bin/magento setup:db:status'),
    'run_step mode ' + asOwner('php bin/magento deploy:mode:set developer --skip-compilation --no-ansi'),
    'run_step marker ' + asOwner('php -d memory_limit=2G /state/config/marker.php'),
    'run_step index ' + asOwner('php bin/magento indexer:reindex --no-ansi --quiet && touch var/.webminai-indexed'),
    'run_step cache ' + asOwner('php bin/magento cache:flush --no-ansi --quiet'),
    'touch /state/config/magento-installed; chmod 0644 /state/config/magento-installed',
    'fi',
    'run_step verify-schema ' + asOwner('php bin/magento setup:db:status'),
    'run_step verify-index ' + asOwner(`php -r ${shellWord(magentoIndexerVerification())}`),
    'ready=; for attempt in $(seq 1 180); do if test -f /var/www/html/var/.webminai-cron-ok; then ready=yes; break; fi; sleep 2; done; test "$ready" = yes',
    `printf '%s\n' ${marker} > /var/www/html/webminai-health`,
    'chown -R www-data:101 /var/www/html; chmod 0644 /var/www/html/webminai-health',
    'while :; do sleep 3600; done'
  ].join('\n')
  return {
    port: 80,
    path: '/webminai-health',
    validationPaths: ['/webminai-health', '/'],
    httpMarker: marker,
    deploymentAttempts: 1200,
    initScript: initScript + '; chmod 0755 /state/config; rm -f /state/webroot/webminai-health /state/webroot/var/.webminai-cron-ok',
    initContainers: [{ name: 'seed-magento-code', image: task.images[0], command: ['/bin/sh', '-ceu'], args: ['if ! test -f /state/webroot/var/.webminai-source-prepared; then test -f /state/webroot/bin/magento || cp -a /var/www/html/. /state/webroot/; rm -f /state/webroot/app/etc/env.php; rm -rf /state/webroot/generated/code/* /state/webroot/generated/metadata/* /state/webroot/var/cache/* /state/webroot/var/page_cache/* /state/webroot/var/di/*; cd /state/webroot; COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload --no-dev --no-interaction --no-ansi --quiet; touch /state/webroot/var/.webminai-source-prepared; chown -R www-data:101 /state/webroot; fi'], volumeMounts: [{ name: 'state', mountPath: '/state' }] }],
    containers: [
      databaseContainer(task.images[2], 'mysql', { env: [{ name: 'MARIADB_DATABASE', value: 'webminai_magento' }, { name: 'MARIADB_USER_FILE', value: '/state/credentials/database_username' }, { name: 'MARIADB_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MARIADB_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }], port: 3306, mountPath: '/var/lib/mysql' }),
      { name: 'opensearch', image: task.images[3], env: [{ name: 'discovery.type', value: 'single-node' }, { name: 'DISABLE_SECURITY_PLUGIN', value: 'true' }, { name: 'OPENSEARCH_JAVA_OPTS', value: '-Xms256m -Xmx256m' }], volumeMounts: [{ name: 'state', mountPath: '/usr/share/opensearch/data', subPath: 'opensearch' }] },
      { name: 'valkey', image: task.images[4], args: ['valkey-server', '--save', '', '--appendonly', 'no', '--maxmemory', '64mb', '--maxmemory-policy', 'allkeys-lru'], volumeMounts: [{ name: 'state', mountPath: '/data', subPath: 'valkey' }] },
      { name: 'magento', image: task.images[0], env: [{ name: 'MAGE_MODE', value: 'developer' }], command: ['/bin/sh', '-ceu'], args: ['install -d -o www-data -g www-data -m 0775 /run/php-fpm; rm -f /run/php-fpm/webminai.sock; exec docker-php-entrypoint php-fpm'], volumeMounts: phpApplicationMounts() },
      { name: 'initializer', image: task.images[0], env: [{ name: 'MAGE_MODE', value: 'developer' }], command: ['/bin/sh', '-ceu'], args: [install], securityContext: { runAsUser: 0, allowPrivilegeEscalation: false }, volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }] },
      { name: 'cron', image: task.images[0], env: [{ name: 'MAGE_MODE', value: 'developer' }], command: ['/bin/sh', '-ceu'], args: ['cd /var/www/html; while ! test -f /state/config/magento-installed; do sleep 2; done; while :; do php bin/magento cron:run --group default --no-ansi >/dev/null 2>&1 && touch var/.webminai-cron-ok; sleep 60; done'], securityContext: { runAsUser: 82, allowPrivilegeEscalation: false }, volumeMounts: phpApplicationMounts() },
      nginxContainer(task.images[1])
    ]
  }
}

function phpApplicationMounts () {
  return [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }, { name: 'state', mountPath: '/run/php-fpm', subPath: 'php-run' }, { name: 'state', mountPath: '/usr/local/etc/php-fpm.d/zz-webminai.conf', subPath: 'config/php-fpm.conf', readOnly: true }]
}

function nginxContainer (image) {
  return {
    name: 'nginx',
    image,
    volumeMounts: [{ name: 'state', mountPath: '/var/www/html', subPath: 'webroot', readOnly: true }, { name: 'state', mountPath: '/run/php-fpm', subPath: 'php-run' }, { name: 'state', mountPath: '/etc/nginx/conf.d/default.conf', subPath: 'config/nginx.conf', readOnly: true }]
  }
}

function wordpressProfile (task, { adminEmail }) {
  const wordpress = kubernetesCommonTask('wordpress-kubernetes')
  const wooCommerce = task.applicationId === 'woocommerce'
  const database = `webminai_${task.applicationId}`
  const marker = `WEBMINAI_${task.applicationId.toUpperCase()}_OK`
  const initScript = credentialInit(['database_password', 'database_root_password', 'admin_password'], ['mysql', 'webroot', 'php-run', 'config'], ['999:999:mysql', '33:33:webroot', '33:33:php-run']) + '; chgrp 101 /state/webroot /state/php-run; chmod 2770 /state/webroot /state/php-run; printf \'%s\\n\' \'[www]\' \'listen = /run/php-fpm/webminai.sock\' \'listen.owner = www-data\' \'listen.group = 101\' \'listen.mode = 0660\' > /state/config/php-fpm.conf; printf \'%s\\n\' \'server {\' \'  listen 8080;\' \'  root /var/www/html;\' \'  index index.php index.html;\' \'  location = /webminai-health { default_type text/plain; try_files /webminai-health =503; }\' \'  location / { try_files $uri $uri/ /index.php?$args; }\' \'  location ~ \\.php$ { include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_pass unix:/run/php-fpm/webminai.sock; }\' \'}\' > /state/config/nginx.conf; chmod 0644 /state/config/php-fpm.conf /state/config/nginx.conf'
  const sharedEnvironment = [{ name: 'WORDPRESS_DB_HOST', value: '127.0.0.1:3306' }, { name: 'WORDPRESS_DB_NAME', value: database }, { name: 'WORDPRESS_DB_USER', value: database }, { name: 'WORDPRESS_DB_PASSWORD_FILE', value: '/state/credentials/database_password' }]
  const initialize = [
    'password=$(cat /state/credentials/database_password)',
    'admin=$(cat /state/credentials/admin_password)',
    'export WORDPRESS_DB_PASSWORD="$password"',
    'ready=',
    'for attempt in $(seq 1 180); do if test -f /var/www/html/wp-settings.php && wp db check --allow-root --path=/var/www/html >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done',
    'test "$ready" = yes',
    `if ! wp core is-installed --allow-root --path=/var/www/html >/dev/null 2>&1; then wp core install --allow-root --path=/var/www/html --url=http://${resourceName(task)} --title=${task.applicationId} --admin_user=webminai_admin --admin_password="$admin" --admin_email=${shellWord(adminEmail)} --skip-email; fi`,
    ...(wooCommerce ? [`wp plugin install woocommerce --allow-root --version=${task.version} --activate --path=/var/www/html`] : []),
    `printf '%s\\n' '${marker}' > /var/www/html/webminai-health`,
    'while :; do sleep 3600; done'
  ].join('; ')
  return {
    port: 8080,
    path: '/webminai-health',
    initScript,
    containers: [
      databaseContainer(wordpress.images[3], 'mysql', {
        env: [{ name: 'MARIADB_DATABASE', value: database }, { name: 'MARIADB_USER', value: database }, { name: 'MARIADB_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MARIADB_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }],
        port: 3306,
        mountPath: '/var/lib/mysql'
      }),
      {
        name: 'wordpress',
        image: wordpress.images[0],
        env: sharedEnvironment,
        volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }, { name: 'state', mountPath: '/run/php-fpm', subPath: 'php-run' }, { name: 'state', mountPath: '/usr/local/etc/php-fpm.d/zz-webminai.conf', subPath: 'config/php-fpm.conf', readOnly: true }]
      },
      {
        name: 'initializer',
        image: wordpress.images[1],
        command: ['/bin/sh', '-ceu'],
        args: [initialize],
        env: sharedEnvironment,
        securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
        volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/www/html', subPath: 'webroot' }]
      },
      {
        name: 'nginx',
        image: wordpress.images[2],
        volumeMounts: [{ name: 'state', mountPath: '/var/www/html', subPath: 'webroot', readOnly: true }, { name: 'state', mountPath: '/run/php-fpm', subPath: 'php-run' }, { name: 'state', mountPath: '/etc/nginx/conf.d/default.conf', subPath: 'config/nginx.conf', readOnly: true }]
      }
    ]
  }
}

function ghostProfile (task) {
  return {
    port: 2368,
    path: '/blog/',
    deploymentAttempts: 1200,
    initScript: credentialInit(['database_password', 'database_root_password'], ['mysql', 'ghost'], ['999:999:mysql', '1000:1000:ghost']),
    containers: [
      databaseContainer(task.images[1], 'mysql', {
        env: [{ name: 'MYSQL_DATABASE', value: 'webminai_ghost' }, { name: 'MYSQL_USER', value: 'webminai_ghost' }, { name: 'MYSQL_PASSWORD_FILE', value: '/state/credentials/database_password' }, { name: 'MYSQL_ROOT_PASSWORD_FILE', value: '/state/credentials/database_root_password' }],
        port: 3306,
        mountPath: '/var/lib/mysql'
      }),
      {
        name: 'ghost',
        image: task.images[0],
        command: ['/bin/sh', '-ceu'],
        args: ['export database__connection__password="$(cat /state/credentials/database_password)"; exec docker-entrypoint.sh node current/index.js'],
        env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'url', value: 'http://localhost:2368/blog' }, { name: 'database__client', value: 'mysql' }, { name: 'database__connection__host', value: '127.0.0.1' }, { name: 'database__connection__user', value: 'webminai_ghost' }, { name: 'database__connection__database', value: 'webminai_ghost' }],
        volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath: '/var/lib/ghost/content', subPath: 'ghost' }]
      }
    ]
  }
}

function mattermostProfile (task) {
  const directories = ['postgres', 'mattermost-config', 'mattermost-data', 'mattermost-logs', 'mattermost-plugins', 'mattermost-client-plugins', 'mattermost-bleve']
  const owners = ['999:999:postgres', ...directories.slice(1).map(directory => `2000:2000:${directory}`)]
  return {
    port: 8065,
    path: '/api/v4/system/ping',
    initScript: credentialInit(['database_password'], directories, owners) + "; password=$(cat /state/credentials/database_password); printf '%s\\n' \"{\\\"SqlSettings\\\":{\\\"DriverName\\\":\\\"postgres\\\",\\\"DataSource\\\":\\\"postgres://webminai_mattermost:$password@127.0.0.1:5432/webminai_mattermost?sslmode=disable&connect_timeout=10\\\"},\\\"ServiceSettings\\\":{\\\"ListenAddress\\\":\\\":8065\\\"},\\\"FileSettings\\\":{\\\"Directory\\\":\\\"/mattermost/data\\\"},\\\"LogSettings\\\":{\\\"EnableFile\\\":false}}\" > /state/mattermost-config/config.json; chown 2000:2000 /state/mattermost-config/config.json; chmod 0600 /state/mattermost-config/config.json",
    containers: [
      databaseContainer(task.images[1], 'postgres', {
        env: [{ name: 'POSTGRES_DB', value: 'webminai_mattermost' }, { name: 'POSTGRES_USER', value: 'webminai_mattermost' }, { name: 'POSTGRES_PASSWORD_FILE', value: '/state/credentials/database_password' }],
        port: 5432,
        mountPath: '/var/lib/postgresql/data'
      }),
      {
        name: 'mattermost',
        image: task.images[0],
        volumeMounts: [
          { name: 'state', mountPath: '/mattermost/config', subPath: 'mattermost-config' },
          { name: 'state', mountPath: '/mattermost/data', subPath: 'mattermost-data' },
          { name: 'state', mountPath: '/mattermost/logs', subPath: 'mattermost-logs' },
          { name: 'state', mountPath: '/mattermost/plugins', subPath: 'mattermost-plugins' },
          { name: 'state', mountPath: '/mattermost/client/plugins', subPath: 'mattermost-client-plugins' },
          { name: 'state', mountPath: '/mattermost/bleve-indexes', subPath: 'mattermost-bleve' }
        ]
      }
    ]
  }
}

function odooProfile (task) {
  return {
    port: 8069,
    path: '/web/login',
    initScript: credentialInit(['database_password', 'admin_password'], ['postgres', 'odoo', 'odoo-data'], ['999:999:postgres', '100:101:odoo', '100:101:odoo-data']) + "; password=$(cat /state/credentials/database_password); admin=$(cat /state/credentials/admin_password); printf '%s\\n' '[options]' \"admin_passwd = $admin\" 'db_host = 127.0.0.1' 'db_port = 5432' 'db_user = webminai_odoo' \"db_password = $password\" 'db_name = webminai_odoo' 'dbfilter = ^webminai_odoo$' 'list_db = False' 'proxy_mode = True' 'data_dir = /var/lib/odoo' > /state/odoo/odoo.conf; chown 100:101 /state/odoo/odoo.conf; chmod 0600 /state/odoo/odoo.conf",
    containers: [
      databaseContainer(task.images[1], 'postgres', {
        env: [{ name: 'POSTGRES_DB', value: 'webminai_odoo' }, { name: 'POSTGRES_USER', value: 'webminai_odoo' }, { name: 'POSTGRES_PASSWORD_FILE', value: '/state/credentials/database_password' }],
        port: 5432,
        mountPath: '/var/lib/postgresql/data'
      }),
      {
        name: 'odoo',
        image: task.images[0],
        args: ['odoo', '--config=/etc/odoo/odoo.conf', '--database=webminai_odoo', '--init=base', '--without-demo=all'],
        volumeMounts: [{ name: 'state', mountPath: '/etc/odoo/odoo.conf', subPath: 'odoo/odoo.conf', readOnly: true }, { name: 'state', mountPath: '/var/lib/odoo', subPath: 'odoo-data' }]
      }
    ]
  }
}

function databaseContainer (image, name, { env, port, mountPath }) {
  return {
    name,
    image,
    ...(name === 'mysql' ? { args: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci'] } : {}),
    env,
    ports: [{ name: `${name}-db`, containerPort: port }],
    volumeMounts: [{ name: 'state', mountPath: '/state' }, { name: 'state', mountPath, subPath: name }],
    resources: { requests: { cpu: '25m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
    securityContext: { allowPrivilegeEscalation: false }
  }
}

function credentialInit (credentials, directories, owners) {
  return [
    'umask 077',
    `mkdir -p /state/credentials ${directories.map(directory => `/state/${directory}`).join(' ')}`,
    ...credentials.map(name => `test -s /state/credentials/${name} || { head -c 48 /dev/urandom | base64 | tr '/+' 'AZ' | tr -d '\\n=' > /state/credentials/${name}; }`),
    'chown root:2000 /state/credentials',
    'chmod 0750 /state/credentials',
    `chown root:2000 ${credentials.map(name => `/state/credentials/${name}`).join(' ')}`,
    `chmod 0640 ${credentials.map(name => `/state/credentials/${name}`).join(' ')}`,
    ...owners.map(value => {
      const parts = value.split(':')
      const owner = parts[0]
      const directory = parts[2]
      return `chown -R ${owner}:2000 /state/${directory}; chmod 0770 /state/${directory}`
    })
  ].join('; ')
}

function deployment (task, profile, namespace) {
  const name = resourceName(task)
  const labels = resourceLabels(task)
  const containers = profile.containers.map((candidate, index) => ({
    imagePullPolicy: 'IfNotPresent',
    resources: { requests: { cpu: '25m', memory: '128Mi' }, limits: { cpu: '2', memory: '2Gi' } },
    securityContext: { allowPrivilegeEscalation: false },
    ...candidate,
    ...(index === profile.containers.length - 1
      ? {
          ports: [{ name: 'http', containerPort: profile.port }],
          startupProbe: { httpGet: { path: profile.path, port: 'http' }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: Math.max(180, Math.ceil((profile.deploymentAttempts ?? 360) / 5)) },
          readinessProbe: { httpGet: { path: profile.path, port: 'http' }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 6 }
        }
      : {})
  }))
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      progressDeadlineSeconds: Math.max(600, (profile.deploymentAttempts ?? 360) + 60),
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'webminai.io/workload': name } },
      template: {
        metadata: { labels: { ...labels, 'webminai.io/workload': name } },
        spec: {
          securityContext: { fsGroup: 2000, fsGroupChangePolicy: 'OnRootMismatch' },
          initContainers: [{
            name: 'initialize-state',
            image: 'busybox:1.37.0',
            command: ['/bin/sh', '-ceu'],
            args: [profile.initScript],
            securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] } },
            volumeMounts: [{ name: 'state', mountPath: '/state' }],
            resources: { requests: { cpu: '5m', memory: '8Mi' }, limits: { cpu: '100m', memory: '32Mi' } }
          }, ...(profile.initContainers ?? []).map(container => ({
            resources: { requests: { cpu: '5m', memory: '16Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
            securityContext: { runAsUser: 0, allowPrivilegeEscalation: false },
            ...container
          }))],
          containers,
          volumes: [{ name: 'state', persistentVolumeClaim: { claimName: name } }]
        }
      }
    }
  }
}

function persistentVolumeClaim (task, namespace) {
  const name = resourceName(task)
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace, labels: resourceLabels(task) }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } } } }
}

function service (task, profile, namespace) {
  const name = resourceName(task)
  return { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels: resourceLabels(task) }, spec: { selector: { 'webminai.io/workload': name }, ports: [{ name: 'http', port: task.port, targetPort: 'http' }] } }
}

function validationJob (task, profile, namespace, name, nodeName) {
  const marker = validationMarker(task, nodeName)
  const checks = (profile.validationPaths ?? [profile.path]).map(path => {
    const url = `http://${resourceName(task)}.${namespace}.svc.cluster.local:${task.port}${path}`
    return profile.httpMarker ? `wget -qO "$response" --timeout=10 ${shellWord(url)} && grep -F ${shellWord(profile.httpMarker)} "$response" >/dev/null` : `wget -qO- --timeout=10 ${shellWord(url)} >/dev/null`
  }).join(' && ')
  const output = profile.httpMarker ? 'ulimit -f 4096\nresponse=$(mktemp)\ntrap \'rm -f "$response"\' EXIT\n' : ''
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace, labels: resourceLabels(task) },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: resourceLabels(task) },
        spec: {
          nodeName,
          restartPolicy: 'Never',
          containers: [{
            name: 'validator',
            image: 'busybox:1.37.0',
            command: ['/bin/sh', '-ceu'],
            args: [`${output}ready=\nfor attempt in $(seq 1 30); do\n  if ${checks}; then ready=yes; break; fi\n  sleep 2\ndone\ntest "$ready" = yes\nprintf '%s\\n' '${marker}'`],
            securityContext: { runAsNonRoot: true, runAsUser: 65534, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
            resources: { requests: { cpu: '5m', memory: '8Mi' }, limits: { cpu: '100m', memory: '32Mi' } }
          }]
        }
      }
    }
  }
}

async function readyNodeNames (netdata) {
  const nodes = await gatewayJson(netdata, { method: 'GET', path: '/api/v1/nodes' })
  return nodes.items.filter(node => node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')).map(node => node.metadata.name)
}

async function waitForDeployment (netdata, namespace, name, attempts, expectedUid, shouldContinue = () => true) {
  const deadline = Date.now() + attempts * 1000
  for (let attempt = 1; attempt <= attempts && Date.now() < deadline; attempt++) {
    if (!await shouldContinue()) throw new Error('Readiness observation paused; the workload was not cancelled')
    const current = await gatewayJson(netdata, { method: 'GET', path: `/apis/apps/v1/namespaces/${namespace}/deployments/${name}` })
    if (current.metadata?.uid !== expectedUid) throw new Error('Deployment identity changed; no verification Jobs were dispatched')
    const desired = current.spec?.replicas ?? 1
    if (current.status?.observedGeneration >= current.metadata.generation && current.status?.availableReplicas === desired) return
    if (current.status?.conditions?.some(condition => condition.type === 'Progressing' && condition.status === 'False')) throw new Error(`${name} Deployment stopped progressing`)
    await delay(1000)
  }
  throw new Error(`${name} Deployment did not become ready`)
}

async function waitForJob (netdata, namespace, name, attempts, expectedUid, shouldContinue = () => true) {
  const deadline = Date.now() + attempts * 1000
  for (let attempt = 1; attempt <= attempts && Date.now() < deadline; attempt++) {
    if (!await shouldContinue()) throw new Error('Validation observation paused; the Job was not cancelled')
    const current = await gatewayJson(netdata, { method: 'GET', path: `/apis/batch/v1/namespaces/${namespace}/jobs/${name}` })
    if (expectedUid && current.metadata?.uid !== expectedUid) throw new Error('Validation Job identity changed')
    if (current.status?.succeeded === 1) return
    if (current.status?.failed > 0) throw new Error(`Kubernetes validation Job failed: ${name}`)
    await delay(1000)
  }
  throw new Error(`Kubernetes validation Job timed out: ${name}`)
}

async function gatewayJson (netdata, request) {
  return netdata.kubernetesJson({ ...request, timeoutSeconds: 30 })
}

async function gatewayText (netdata, request) {
  const result = await netdata.runApiRequest({ ...request, timeoutSeconds: 30 })
  if (result.exitCode !== 0) throw new Error(`Kubernetes gateway request failed: ${result.stderr.trim()}`)
  return result.stdout
}

async function readResource (netdata, path) {
  const result = await netdata.runApiRequest({ method: 'GET', path, timeoutSeconds: 30 })
  let object
  try { object = JSON.parse(result.stdout) } catch { throw new Error('Resource identity response unavailable; no mutation permitted') }
  if (result.exitCode !== 0 && object?.kind === 'Status' && object.code === 404) return null
  if (result.exitCode !== 0 || result.recoveryRequired || !object?.metadata?.uid) throw new Error('Resource identity could not be verified; no mutation permitted')
  return object
}

async function gatewayDeleteIgnoringMissing (netdata, path, uid) {
  const result = await netdata.runApiRequest({ method: 'DELETE', path, body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', preconditions: { uid } }, timeoutSeconds: 30 })
  if (result.exitCode === 0) {
    await waitForDeletion(netdata, path, uid)
    return
  }
  let status
  try { status = JSON.parse(result.stdout) } catch {}
  if (status?.code === 404 || status?.reason === 'NotFound') return
  throw new Error(`Kubernetes gateway delete failed: ${result.stderr.trim() || result.stdout.trim()}`)
}

async function waitForDeletion (netdata, path, uid) {
  for (let attempt = 1; attempt <= 120; attempt++) {
    const result = await netdata.runApiRequest({ method: 'GET', path, timeoutSeconds: 30 })
    if (result.exitCode !== 0) {
      let status
      try { status = JSON.parse(result.stdout) } catch {}
      if (status?.code === 404 || status?.reason === 'NotFound') return
      throw new Error(`Kubernetes gateway deletion probe failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    let current
    try {
      current = JSON.parse(result.stdout)
    } catch (cause) {
      throw new Error(`Kubernetes gateway deletion probe returned invalid JSON: ${cause.message}`, { cause })
    }
    if (current.metadata?.uid !== uid) throw new Error('Resource identity changed while observing deletion; replacement preserved')
    await delay(500)
  }
  throw new Error(`Kubernetes resource deletion timed out: ${path}`)
}

function resourceLabels (task) {
  return { 'app.kubernetes.io/managed-by': 'webminai', 'app.kubernetes.io/name': resourceName(task), 'webminai.io/catalog-id': task.id }
}

function resourceName (task) {
  return `webminai-${task.applicationId}`
}

function validationJobName (task, nodeName) {
  const suffix = nodeName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
  return `${resourceName(task)}-check-${suffix}`.slice(0, 63).replace(/-+$/u, '')
}

function validationMarker (task, nodeName) {
  return `WEBMINAI_${task.applicationId.toUpperCase().replaceAll('-', '_')}_OK node=${nodeName}`
}

function shellWord (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function kubernetesFpm (value) {
  return value.replace('listen.group = www-data', 'listen.group = 101')
}

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
