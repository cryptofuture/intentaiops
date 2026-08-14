#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { KubernetesClient } from '../src/kubernetes-client.js'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { listKubernetesCommonTasks } from '../src/kubernetes-common-task-catalog.js'
import { validateKubernetesApplication, revertKubernetesApplication } from '../src/kubernetes-application-validation.js'
import { validateNginxFromAllNodes, revertNginxValidation } from '../src/kubernetes-nginx-validation.js'

const directory = fileURLToPath(new URL('.', import.meta.url))
const kubeconfigPath = process.env.WEBMINAI_KUBECONFIG || `${directory}kubeconfig.container`
const keyPath = process.env.WEBMINAI_K8S_ACTION_KEY_FILE || `${directory}.kubernetes-stage2-action-key`
const action = process.argv[2] || 'all'
const selected = process.argv[3]

if (['--help', '-h'].includes(action)) {
  console.log('Usage: validate-kubernetes-common-tasks.js [list|all|run <catalog-id>|revert <catalog-id>]')
} else if (!['all', 'list', 'run', 'revert'].includes(action) || ((action === 'run' || action === 'revert') && !selected)) {
  console.error('Usage: validate-kubernetes-common-tasks.js [list|all|run <catalog-id>|revert <catalog-id>]')
  process.exitCode = 2
} else {
  await main()
}

async function main () {
  const tasks = listKubernetesCommonTasks()
  if (action === 'list') {
    for (const task of tasks) console.log(`${task.id}\t${task.sourceCatalogId}`)
    return
  }
  if (selected && !tasks.some(task => task.id === selected)) throw new Error(`unknown Kubernetes common task: ${selected}`)
  const kubernetes = await KubernetesClient.fromKubeconfig(kubeconfigPath)
  const actionKey = (await readFile(keyPath, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/iu.test(actionKey)) throw new Error('saved Kubernetes action key is invalid')
  const netdata = new KubernetesNetdataClient({ kubernetes, actionKey })
  const targets = action === 'all' ? tasks : tasks.filter(task => task.id === selected)
  for (const task of targets) {
    if (action === 'revert') {
      await revertOne(netdata, task)
      console.log(`PASS ${task.id}: reverted`)
      continue
    }
    try {
      const report = await applyOne(netdata, task)
      console.log(`PASS ${task.id}: ${report.nodes.length} nodes`)
    } finally {
      await revertOne(netdata, task)
    }
  }
}

function applyOne (netdata, task) {
  const onProgress = ({ phase, message }) => console.log(`[${task.id}][${phase}] ${message}`)
  if (task.id === 'nginx-static-site-kubernetes') return validateNginxFromAllNodes({ netdata, onProgress })
  return validateKubernetesApplication({ netdata, catalogId: task.id, onProgress })
}

function revertOne (netdata, task) {
  const onProgress = ({ phase, message }) => console.log(`[${task.id}][${phase}] ${message}`)
  if (task.id === 'nginx-static-site-kubernetes') return revertNginxValidation({ netdata, onProgress })
  return revertKubernetesApplication({ netdata, catalogId: task.id, onProgress })
}
