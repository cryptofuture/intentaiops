import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'
import { KubernetesClient } from '../src/kubernetes-client.js'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { createKubernetesApiCommand } from '../src/netdata-client.js'
import { executeApprovedPlan } from '../src/plan-validator.js'
import { planFingerprint } from '../src/execution-journal.js'
import { resolveDefaultDataRoot } from '../src/cli.js'

test('opt-in Kubernetes signed reads, durable journal and safe reviewed continuation', {
  skip: !process.env.INTENT_KUBERNETES_LIVE || !process.env.VAULT_TEST,
  timeout: 120000
}, async t => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? await resolveDefaultDataRoot(os.homedir()))
  const cluster = await store.decryptKubernetesCluster({ settings: await store.load(), passphrase: process.env.VAULT_TEST, clusterId: process.env.INTENT_WEB_CLUSTER ?? 'webminai-k8s' })
  const kubernetes = KubernetesClient.fromKubeconfigSource(cluster.kubeconfig)
  assert.equal(kubernetes.contextName, 'kind-webminai-k8s', 'Only the explicitly scoped disposable lab is supported')
  const client = new KubernetesNetdataClient({ kubernetes, actionKey: cluster.actionKey })
  assert.equal((await client.health()).platform, 'kubernetes')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-kubernetes-journal-'))
  const identity = 'kubernetes-lab'
  const tasks = new TaskStore(directory)
  const commands = ['nodes', 'pods'].map((id, index) => ({ id, purpose: 'Read lab resource identities', risk: 'read', requiresSudo: false, timeoutMs: 15000, command: createKubernetesApiCommand({ method: 'GET', path: index ? '/api/v1/namespaces/webminai-tasks/pods' : '/api/v1/nodes' }) }))
  const plan = { summary: 'Read-only cluster journal probe', changeOverview: 'No remote mutations', modifiedFiles: [], commands, revertCommands: [] }
  const task = tasks.create(identity, 'Inspect lab nodes and task pod identities')
  tasks.savePlan(identity, task.id, plan)
  let calls = 0
  const netdata = { runCommand: (...args) => { calls++; return client.runCommand(...args) } }
  try {
    await t.test('signed gateway denies Secrets and out-of-scope reads', async () => {
      for (const resource of ['/api/v1/namespaces/webminai-tasks/secrets', '/api/v1/namespaces/kube-system/pods']) {
        const result = await client.runCommand(createKubernetesApiCommand({ method: 'GET', path: resource }))
        assert.notEqual(result.exitCode, 0)
        assert.doesNotMatch(result.stdout, /client-key-data|certificate-authority-data|BEGIN .*PRIVATE KEY/u)
      }
      const rejected = new KubernetesNetdataClient({ kubernetes, actionKey: '0'.repeat(64) })
      await assert.rejects(rejected.runCommand(commands[0].command), error => error.kubernetesHttpStatus === 403 && error.recoveryRequired === false)
    })
    await t.test('rejected approval dispatches nothing', async () => {
      const results = await executeApprovedPlan({ plan, policy: {}, netdata, approve: async () => false })
      assert.ok(results.every(result => result.status === 'rejected'))
      assert.equal(calls, 0)
    })
    await t.test('one execution owner and pause at a confirmed command boundary', async () => {
      const lease = tasks.acquireExecution(identity, task.id, plan)
      try {
        assert.throws(() => new TaskStore(directory).acquireExecution(identity, task.id, plan), /another operator/u)
        const results = await executeApprovedPlan({
          plan,
          policy: {},
          netdata,
          approve: async () => true,
          beforeCommand: async () => tasks.control(identity, task.id).action === 'run',
          onExecutionEvent: event => tasks.appendExecutionEvent(identity, task.id, lease.owner, event),
          onResult: result => {
            tasks.appendResult(identity, task.id, result)
            tasks.setControl(identity, task.id, 'pause', 0)
          }
        })
        assert.deepEqual(results.map(result => result.status), ['completed'])
        assert.equal(calls, 1)
        const metadata = JSON.parse(results[0].result.stdout)
        assert.equal(metadata.items.length, 3)
        assert.ok(metadata.items.every(item => item.metadata.uid))
        assert.equal(metadata.contentPolicy, 'metadata-status-only')
      } finally { tasks.releaseExecution(identity, task.id, lease.owner) }
    })
    await t.test('reopened history preserves completed commands and rejects stale revisions', async () => {
      const reopened = new TaskStore(directory)
      const state = reopened.executionState(identity, task.id)
      assert.equal(state.find(command => command.commandId === 'nodes').status, 'completed')
      const version = reopened.stateVersion(identity, task.id)
      assert.throws(() => reopened.proposeRevision(identity, task.id, { ...plan, commands: [commands[1]] }, version), /immutable/u)
      assert.throws(() => reopened.proposeRevision(identity, task.id, plan, 'stale'), /stale/u)
      assert.throws(() => reopened.acquireExecution(identity, task.id, { ...plan, summary: 'Changed without approval' }), /differs/u)
      assert.equal(calls, 1)
      assert.equal(planFingerprint(reopened.get(identity, task.id).plan), planFingerprint(plan))
    })
    await t.test('explicit continuation skips completed work and journals the remaining read', async () => {
      const reopened = new TaskStore(directory)
      reopened.setControl(identity, task.id, 'run', 1)
      const lease = reopened.acquireExecution(identity, task.id, plan)
      try {
        const results = await executeApprovedPlan({
          plan,
          policy: {},
          netdata,
          approve: async () => true,
          completedCommandIds: reopened.executionState(identity, task.id).filter(command => command.status === 'completed').map(command => command.commandId),
          beforeCommand: async () => reopened.control(identity, task.id).action === 'run',
          onExecutionEvent: event => reopened.appendExecutionEvent(identity, task.id, lease.owner, event),
          onResult: result => reopened.appendResult(identity, task.id, result)
        })
        assert.deepEqual(results.map(result => result.id), ['pods'])
        assert.equal(results[0].status, 'completed')
        assert.equal(calls, 2)
        assert.equal(reopened.allExecutionEvents(identity, task.id).filter(event => event.type === 'command_dispatched').length, 2)
        assert.doesNotMatch(JSON.stringify(reopened.allExecutionEvents(identity, task.id)), /client-key-data|certificate-authority-data|BEGIN .*PRIVATE KEY/u)
      } finally { reopened.releaseExecution(identity, task.id, lease.owner) }
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
