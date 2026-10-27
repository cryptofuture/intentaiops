import assert from 'node:assert/strict'
import test from 'node:test'
import { listKubernetesCommonTasks } from '../src/kubernetes-common-task-catalog.js'
import { validateKubernetesApplication, verifyKubernetesApplication, revertKubernetesApplication, buildKubernetesApplicationPlan } from '../src/kubernetes-application-validation.js'
import { createKubernetesApiCommand } from '../src/netdata-client.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, access, stat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateCommandPlan } from '../src/plan-validator.js'

test('all fourteen workspace catalog plans carry bounded API-only requests and ordered verified provenance', () => {
  for (const task of listKubernetesCommonTasks()) {
    const plan = buildKubernetesApplicationPlan({ catalogId: task.id, executionId: 'a'.repeat(32), nodes: ['node-a', 'node-b'] })
    assert.equal(plan.commands.length, 8)
    assert.doesNotThrow(() => validateCommandPlan(plan, { maxCommands: 64, maxTimeoutMs: 1260000 }))
    assert.ok(plan.commands.every(command => command.source.id === task.id && command.command.startsWith('v=1\nmethod=')))
    assert.ok(plan.revertCommands.every(command => command.risk === 'destructive'))
  }
})

test('every Kubernetes application common task composes API-only resources and validates every ready node', async () => {
  for (const task of listKubernetesCommonTasks().filter(task => task.applicationId)) {
    const posted = []
    const netdata = fakeNetdata(posted)
    const result = await validateKubernetesApplication({ netdata, catalogId: task.id })
    assert.equal(result.nodes.length, 2, task.id)
    assert.equal(posted.some(item => item.kind === 'Deployment'), true, task.id)
    assert.equal(posted.some(item => item.kind === 'Service'), true, task.id)
    assert.equal(posted.some(item => item.kind === 'PersistentVolumeClaim'), true, task.id)
    assert.equal(posted.some(item => item.kind === 'Secret'), false, task.id)
    if (['moodle', 'magento', 'ghost'].includes(task.applicationId)) {
      const resource = posted.find(item => item.kind === 'Deployment')
      assert.equal(resource.spec.progressDeadlineSeconds, 1260)
      assert.equal(resource.spec.template.spec.containers.at(-1).startupProbe.failureThreshold, 240)
    }
    for (const body of posted) assert.doesNotThrow(() => createKubernetesApiCommand({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/pods', body }), `${task.id}/${body.kind} must fit the signed gateway protocol`)
    const serialized = JSON.stringify(posted)
    assert.doesNotMatch(serialized, /kind":"Secret/u, task.id)
    if (!['jellyfin', 'home-assistant'].includes(task.applicationId)) assert.match(serialized, /\/state\/credentials/u, task.id)
  }
})

test('verification resumes the exact existing Deployment without recreating its workload or storage', async () => {
  const posted = []
  const netdata = fakeNetdata(posted)
  await verifyKubernetesApplication({ netdata, catalogId: 'moodle-kubernetes', expectedDeploymentUid: 'fixture-webminai-moodle' })
  assert.equal(posted.length, 2)
  assert.ok(posted.every(item => item.kind === 'Job'))
  posted.length = 0
  await assert.rejects(verifyKubernetesApplication({ netdata, catalogId: 'moodle-kubernetes', expectedDeploymentUid: 'replaced' }), /identity changed/u)
  assert.deepEqual(posted, [])
  await assert.rejects(verifyKubernetesApplication({ netdata, catalogId: 'moodle-kubernetes' }), /UID is required/u)
})

test('Kubernetes application revert leaves absent resources alone', async () => {
  const requests = []
  await revertKubernetesApplication({ netdata: fakeNetdata([], requests), catalogId: 'wordpress-kubernetes' })
  assert.equal(requests.every(request => request.method === 'GET'), true)
  assert.equal(requests.length, 3)
})

test('application cleanup validates every target before deleting individual immutable UIDs', async () => {
  for (const scenario of ['owned', 'wrong-owner', 'wrong-uid', 'replacement']) {
    const labels = { 'app.kubernetes.io/managed-by': 'webminai', 'webminai.io/catalog-id': 'wordpress-kubernetes' }
    const jobs = '/apis/batch/v1/namespaces/webminai-tasks/jobs'
    const resources = new Map([
      [jobs + '/check', { kind: 'Job', metadata: { name: 'check', uid: 'job', labels } }],
      ['/apis/apps/v1/namespaces/webminai-tasks/deployments/webminai-wordpress', { kind: 'Deployment', metadata: { name: 'webminai-wordpress', uid: 'deployment', labels } }],
      ['/api/v1/namespaces/webminai-tasks/services/webminai-wordpress', { kind: 'Service', metadata: { name: 'webminai-wordpress', uid: 'service', labels } }],
      ['/api/v1/namespaces/webminai-tasks/persistentvolumeclaims/webminai-wordpress', { kind: 'PersistentVolumeClaim', metadata: { name: 'webminai-wordpress', uid: 'claim', labels } }]
    ])
    const expectedResources = [...resources].map(([path, value]) => ({ path, uid: value.metadata.uid }))
    const calls = []
    if (scenario === 'wrong-owner') resources.get(expectedResources[2].path).metadata.labels = { ...labels, 'app.kubernetes.io/managed-by': 'someone-else' }
    if (scenario === 'wrong-uid') expectedResources[2].uid = 'stale'
    const netdata = {
      async kubernetesJson () { return { items: resources.has(jobs + '/check') ? [resources.get(jobs + '/check')] : [] } },
      async runApiRequest (request) {
        calls.push(request)
        const resource = resources.get(request.path)
        if (request.method === 'DELETE') {
          assert.equal(request.body.preconditions.uid, resource.metadata.uid)
          resources.delete(request.path)
          if (scenario === 'replacement') resources.set(request.path, { ...resource, metadata: { ...resource.metadata, uid: 'replacement' } })
          return { exitCode: 0, stdout: JSON.stringify({ kind: 'Status', status: 'Success' }) }
        }
        return resource ? { exitCode: 0, stdout: JSON.stringify(resource) } : { exitCode: 1, stdout: JSON.stringify({ kind: 'Status', code: 404 }) }
      }
    }
    if (scenario === 'owned') {
      await assert.rejects(validateKubernetesApplication({ netdata, catalogId: 'wordpress-kubernetes' }), /Existing application resource/u)
      assert.ok(calls.every(request => request.method === 'GET'))
      calls.length = 0
      await revertKubernetesApplication({ netdata, catalogId: 'wordpress-kubernetes', expectedResources })
      assert.equal(resources.size, 0)
      assert.equal(calls.filter(request => request.method === 'DELETE').length, 4)
      assert.ok(calls.filter(request => request.method === 'DELETE').every(request => !request.path.includes('?')))
    } else {
      await assert.rejects(revertKubernetesApplication({ netdata, catalogId: 'wordpress-kubernetes', expectedResources }), /Unowned or replaced|identity changed/u)
      assert.equal(calls.filter(request => request.method === 'DELETE').length, scenario === 'replacement' ? 1 : 0)
      assert.equal(resources.size, 4)
    }
  }
})

test('Magento cannot publish health after partial setup or silently replay an interrupted initializer', async () => {
  const posted = []
  await validateKubernetesApplication({ netdata: fakeNetdata(posted), catalogId: 'magento-kubernetes' })
  const deployment = posted.find(item => item.kind === 'Deployment')
  const initializer = deployment.spec.template.spec.containers.find(item => item.name === 'initializer').args[0]
  const initializeState = deployment.spec.template.spec.initContainers[0].args[0]
  assert.match(initializeState, /chmod 0755 \/state\/config/u)
  assert.doesNotMatch(initializer, /setup:install[^\n]*\|\| test -f/u)
  assert.match(initializer, /webminai-magento[.]webminai-tasks[.]svc[.]cluster[.]local:18108/u)
  assert.equal(deployment.spec.template.spec.containers.find(item => item.name === 'cron').securityContext.runAsUser, 82)
  assert.match(initializeState, /chown -R 82:2000 \/state\/webroot/u)
  assert.match(deployment.spec.template.spec.initContainers[1].args[0], /chown -R www-data:101/u)
  for (const name of ['initializer', 'magento', 'cron']) assert.ok(deployment.spec.template.spec.containers.find(item => item.name === name).env.some(variable => variable.name === 'MAGE_MODE' && variable.value === 'developer'))
  assert.match(posted.find(item => item.kind === 'Job').spec.template.spec.containers[0].args[0], /grep -F 'WEBMINAI_MAGENTO_OK'/u)
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', initializer]).status, 0)
  for (const scenario of ['setup-failed', 'schema-failed', 'index-failed', 'preexisting', 'success']) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kubernetes-magento-'))
    try {
      const app = path.join(directory, 'app')
      const state = path.join(directory, 'state')
      for (const sub of [app + '/bin', app + '/app/etc', app + '/var', state + '/config', directory + '/run']) await mkdir(sub, { recursive: true, mode: 0o700 })
      const preparation = initializeState.replaceAll('/state/', state + '/')
      const prepared = spawnSync('/bin/sh', ['-ceu', 'chown() { :; }; chgrp() { :; }; ' + preparation], { encoding: 'utf8', timeout: 2000 })
      assert.equal(prepared.status, 0, prepared.stderr)
      assert.equal((await stat(state + '/config')).mode & 0o777, 0o755)
      await writeFile(app + '/bin/magento', '')
      await writeFile(app + '/var/.webminai-cron-ok', '')
      if (scenario === 'preexisting') await writeFile(app + '/app/etc/env.php', '')
      const body = initializer.replaceAll('/var/www/html', app).replaceAll('/state/', state + '/').replaceAll('/run/webminai', directory + '/run')
      assert.doesNotMatch(body, /(?:^|[\s"'=])\/(?:var\/www\/html|state\/config|run\/webminai)/u)
      const mocks = `
curl() { return 0; }
install() { return 0; }
chmod() { return 0; }
chown() { return 0; }
sleep() { exit 0; }
timeout() { shift; "$@"; }
su() { while [ "$1" != -c ]; do shift; done; shift; eval "$1"; }
php() {
  for arg do
    case "$arg" in
      setup:install) printf 'setup\\n' >> "$LAB_ROOT/calls"; touch "$LAB_ROOT/app/app/etc/env.php"; [ "$LAB_CASE" != setup-failed ] || return 1 ;;
      setup:db:status) [ "$LAB_CASE" != schema-failed ] || return 2 ;;
      indexer:reindex) [ "$LAB_CASE" != index-failed ] || return 3 ;;
    esac
  done
  return 0
}
`
      const run = () => spawnSync('/bin/sh', ['-ceu', mocks + body], { env: { ...process.env, LAB_ROOT: directory, LAB_CASE: scenario }, encoding: 'utf8', timeout: 2000 })
      const first = run()
      assert.equal(first.status, scenario === 'success' ? 0 : scenario === 'preexisting' ? 78 : scenario === 'schema-failed' ? 2 : scenario === 'index-failed' ? 3 : 1, first.stderr)
      const stage = { 'setup-failed': 'setup', 'schema-failed': 'schema', 'index-failed': 'index' }[scenario]
      let failure
      if (stage) {
        const file = `${state}/config/magento-${stage}-failure.json`
        failure = await readFile(file, 'utf8')
        assert.deepEqual(JSON.parse(failure), { version: 1, stage, exitCode: first.status, reason: 'unknown' })
        assert.equal((await stat(file)).mode & 0o777, 0o600)
        assert.ok((await stat(`${state}/config/magento-${stage}.log`)).size <= 65536)
      }
      if (scenario === 'success') await access(app + '/webminai-health')
      else await assert.rejects(access(app + '/webminai-health'))
      assert.equal(run().status, scenario === 'success' ? 0 : 78)
      if (stage) assert.equal(await readFile(`${state}/config/magento-${stage}-failure.json`, 'utf8'), failure)
      if (scenario !== 'preexisting') assert.equal((await readFile(path.join(directory, 'calls'), 'utf8')).trim(), 'setup')
      else await assert.rejects(access(path.join(directory, 'calls')))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

function fakeNetdata (posted, requests = []) {
  const markers = listKubernetesCommonTasks().filter(task => task.applicationId).flatMap(task => ['node-a', 'node-b'].map(node => `WEBMINAI_${task.applicationId.toUpperCase().replaceAll('-', '_')}_OK node=${node}`)).join('\n')
  return {
    async kubernetesJson ({ method, path, body }) {
      if (method === 'POST') {
        posted.push(body)
        return { ...body, metadata: { ...body.metadata, uid: 'fixture-' + body.metadata.name } }
      }
      if (path === '/api/v1/nodes') return { items: ['node-a', 'node-b'].map(name => ({ metadata: { name }, status: { conditions: [{ type: 'Ready', status: 'True' }] } })) }
      if (path.includes('/deployments/')) return { metadata: { generation: 1, uid: 'fixture-' + path.split('/').at(-1) }, spec: { replicas: 1 }, status: { observedGeneration: 1, availableReplicas: 1 } }
      if (path.includes('/jobs?')) return { items: posted.filter(item => item.kind === 'Job').map(item => ({ ...item, metadata: { ...item.metadata, uid: 'fixture-' + item.metadata.name } })) }
      if (path.includes('/jobs/') && !path.includes('/pods?')) return { status: { succeeded: 1 } }
      if (path.includes('/pods?')) return { items: [{ metadata: { name: 'validator-pod' } }] }
      throw new Error(`unexpected Kubernetes JSON request: ${method} ${path}`)
    },
    async runApiRequest (request) {
      requests.push(request)
      if (request.method === 'DELETE') return { exitCode: 1, stdout: '{"code":404,"reason":"NotFound"}', stderr: '' }
      if (request.method === 'GET' && request.path.endsWith('/log')) return { exitCode: 0, stdout: markers, stderr: '' }
      if (request.method === 'GET') {
        const item = posted.find(item => item.metadata.name === request.path.split('/').at(-1))
        return item ? { exitCode: 0, stdout: JSON.stringify({ ...item, metadata: { ...item.metadata, uid: 'fixture-' + item.metadata.name } }), stderr: '' } : { exitCode: 1, stdout: JSON.stringify({ kind: 'Status', code: 404 }), stderr: '' }
      }
      throw new Error(`unexpected Kubernetes request: ${request.method} ${request.path}`)
    }
  }
}
