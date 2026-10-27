#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { KubernetesClient } from '../src/kubernetes-client.js'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { listKubernetesCommonTasks } from '../src/kubernetes-common-task-catalog.js'
import { validateKubernetesApplication, verifyKubernetesApplication, revertKubernetesApplication } from '../src/kubernetes-application-validation.js'
import { validateNginxFromAllNodes, revertNginxValidation } from '../src/kubernetes-nginx-validation.js'
import { SettingsStore } from '../src/settings-store.js'
import { KubernetesLabCheckpoint, assertLabResources, labResources } from './kubernetes-lab-checkpoint.js'
import { redactDiagnosticText } from '../src/error-details.js'
import { withHostMutation } from '../src/host-mutation-ownership.js'
import { resolveDefaultDataRoot } from '../src/cli.js'
import os from 'node:os'

const directory = fileURLToPath(new URL('.', import.meta.url))
const kubeconfigPath = process.env.WEBMINAI_KUBECONFIG || `${directory}kubeconfig.container`
const keyPath = process.env.WEBMINAI_K8S_ACTION_KEY_FILE || `${directory}.kubernetes-stage2-action-key`
const args = process.argv.slice(2).filter(argument => argument !== '--approve-live-tests')
const action = args[0] || 'all'
const selected = args[1]

if (['--help', '-h'].includes(action)) {
  console.log('Usage: validate-kubernetes-common-tasks.js [list|all|run <catalog-id>|resume <catalog-id>|revert <catalog-id>] [--approve-live-tests]')
} else if (!['all', 'list', 'run', 'resume', 'revert'].includes(action) || (['run', 'resume', 'revert'].includes(action) && !selected)) {
  console.error('Usage: validate-kubernetes-common-tasks.js [list|all|run <catalog-id>|resume <catalog-id>|revert <catalog-id>] [--approve-live-tests]')
  process.exitCode = 2
} else {
  try { await main() } catch (error) {
    const message = process.env.VAULT_TEST ? String(error.message).replaceAll(process.env.VAULT_TEST, '[redacted]') : String(error.message)
    console.error(redactDiagnosticText(message))
    process.exitCode = 1
  }
}

async function main () {
  const tasks = listKubernetesCommonTasks()
  if (action === 'list') {
    for (const task of tasks) console.log(`${task.id}\t${task.sourceCatalogId}`)
    return
  }
  if (!process.argv.includes('--approve-live-tests')) throw new Error('Disposable live mutations require --approve-live-tests')
  const dataRoot = process.env.WEBMINAI_DATA_ROOT ?? await resolveDefaultDataRoot(os.homedir())
  if (selected && !tasks.some(task => task.id === selected)) throw new Error(`unknown Kubernetes common task: ${selected}`)
  let kubernetes
  let actionKey
  if (process.env.WEBMINAI_K8S_VAULT_CLUSTER) {
    if (!process.argv.includes('--approve-live-tests') || !process.env.VAULT_TEST) throw new Error('Vault lab validation requires --approve-live-tests and VAULT_TEST')
    const store = new SettingsStore(dataRoot)
    const settings = await store.load()
    const cluster = await store.decryptKubernetesCluster({ settings, passphrase: process.env.VAULT_TEST, clusterId: process.env.WEBMINAI_K8S_VAULT_CLUSTER })
    kubernetes = KubernetesClient.fromKubeconfigSource(cluster.kubeconfig)
    actionKey = cluster.actionKey
  } else {
    kubernetes = await KubernetesClient.fromKubeconfig(kubeconfigPath)
    actionKey = (await readFile(keyPath, 'utf8')).trim()
  }
  if (!/^[a-f0-9]{64}$/iu.test(actionKey)) throw new Error('saved Kubernetes action key is invalid')
  const netdata = new KubernetesNetdataClient({ kubernetes, actionKey })
  if (kubernetes.contextName !== 'kind-webminai-k8s') throw new Error('This destructive validation script requires the explicit disposable kind-webminai-k8s lab')
  const identity = await kubernetes.request('/api/v1/namespaces/kube-system')
  return withHostMutation({ dataRoot, identity: `kubernetes:${identity.metadata.uid}` }, async () => {
    const checkpoint = await new KubernetesLabCheckpoint('artifacts/kubernetes-common', identity.metadata.uid, 'docs/kubernetes-lab-validation-status.md').load()
    const health = await netdata.health()
    if (health.platform !== 'kubernetes') throw new Error('Kubernetes signed gateway is unavailable')
    const targets = action === 'all' ? tasks : tasks.filter(task => task.id === selected)
    for (const task of targets) {
      const prior = checkpoint.state.tasks[task.id]
      if (action === 'revert') {
        if (!prior) throw new Error('No recorded lab ownership; inspect existing resources before cleanup')
        assertLabResources(await labResources(netdata), prior.receipts)
        await checkpoint.record(task.id, { status: 'cleanup-in-progress', cleanupOfStatus: prior.cleanupOfStatus ?? prior.status }, 'Separately approved ownership-checked cleanup; existing resources and mutation receipts retained')
        const restore = checkpoint.observe(netdata, task.id)
        try {
          await revertOne(netdata, task, prior.receipts)
          assertLabResources(await labResources(netdata))
          await checkpoint.record(task.id, { status: 'cleaned-after-failure', intents: {}, historicalUncertainty: Object.entries(prior.intents ?? {}).map(([id, intent]) => ({ id, ...intent, originalOutcome: 'unknown', currentObservation: 'task resources absent after reviewed cleanup' })) }, 'Reviewed cleanup completed; this is not an application pass, and earlier uncertainty remains recorded')
        } catch (error) {
          await checkpoint.record(task.id, { status: Object.keys(checkpoint.state.tasks[task.id].intents ?? {}).length ? 'outcome-unknown' : 'cleanup-observation-required' }, 'Cleanup not yet confirmed; inspect current deletion state, without force deletion or automatic replay')
          throw error
        } finally { restore() }
        console.log(`PASS ${task.id}: reverted`)
        continue
      }
      if (action === 'all' && prior?.status === 'passed-and-reverted') {
        assertLabResources(await labResources(netdata))
        console.log(`SKIP ${task.id}: recorded pass and empty task namespace confirmed`)
        continue
      }
      let expectedDeploymentUid
      if (action === 'resume') {
        if (!task.applicationId || prior?.status !== 'inspection-required' || Object.keys(prior.intents ?? {}).length || prior.receipts?.length !== 3 || prior.receipts.some(resource => resource.path.includes('/jobs/'))) throw new Error('Verification resume requires confirmed workload creation, no unresolved mutations and no prior validation Jobs')
        assertLabResources(await labResources(netdata), prior.receipts)
        expectedDeploymentUid = prior.receipts.find(resource => resource.path === `/apis/apps/v1/namespaces/webminai-tasks/deployments/webminai-${task.applicationId}`)?.uid
        if (!expectedDeploymentUid) throw new Error('Recorded Deployment identity unavailable')
        await checkpoint.record(task.id, { status: 'verifying-existing' }, 'Separately approved verification of the existing Deployment UID; no workload or storage creation will be repeated')
      } else {
        if (prior && prior.status !== 'passed-and-reverted' && prior.status !== 'cleaned-after-failure') throw new Error(`Inspect incomplete ${task.id} before any new apply; no uncertain request will be replayed`)
        assertLabResources(await labResources(netdata))
        await checkpoint.begin(task.id)
      }
      const restore = checkpoint.observe(netdata, task.id)
      try {
        const report = action === 'resume'
          ? await verifyKubernetesApplication({ netdata, catalogId: task.id, expectedDeploymentUid, onProgress: ({ phase, message }) => console.log(`[${task.id}][${phase}] ${message}`) })
          : await applyOne(netdata, task)
        console.log(`PASS ${task.id}: ${report.nodes.length} nodes`)
        await checkpoint.record(task.id, { status: 'applied', nodes: report.nodes.map(node => node.node) }, 'Application and all-node health checks passed; rollback pending')
        assertLabResources(await labResources(netdata), checkpoint.state.tasks[task.id].receipts)
        await revertOne(netdata, task, checkpoint.state.tasks[task.id].receipts)
        assertLabResources(await labResources(netdata))
        await checkpoint.record(task.id, { status: 'passed-and-reverted', intents: {} }, 'PASS application/all-node health and UID-checked rollback; task namespace empty')
      } catch (error) {
        await checkpoint.record(task.id, { status: Object.keys(checkpoint.state.tasks[task.id].intents ?? {}).length ? 'outcome-unknown' : 'inspection-required' }, 'Stopped without automatic retry or cleanup; inspect existing resources and recorded mutation intent')
        throw error
      } finally { restore() }
    }
  })
}

function applyOne (netdata, task) {
  const onProgress = ({ phase, message }) => console.log(`[${task.id}][${phase}] ${message}`)
  if (task.id === 'nginx-static-site-kubernetes') return validateNginxFromAllNodes({ netdata, onProgress })
  return validateKubernetesApplication({ netdata, catalogId: task.id, onProgress })
}

function revertOne (netdata, task, expectedResources) {
  const onProgress = ({ phase, message }) => console.log(`[${task.id}][${phase}] ${message}`)
  if (task.id === 'nginx-static-site-kubernetes') return revertNginxValidation({ netdata, onProgress })
  return revertKubernetesApplication({ netdata, catalogId: task.id, expectedResources, onProgress })
}
