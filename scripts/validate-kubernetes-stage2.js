#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { KubernetesClient } from '../src/kubernetes-client.js'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { validateNginxFromAllNodes, revertNginxValidation } from '../src/kubernetes-nginx-validation.js'
import { KubernetesStage2Service } from '../src/kubernetes-stage2-service.js'

const directory = fileURLToPath(new URL('.', import.meta.url))
const kubeconfigPath = process.env.WEBMINAI_KUBECONFIG || `${directory}kubeconfig.container`
const keyPath = process.env.WEBMINAI_K8S_ACTION_KEY_FILE || `${directory}.kubernetes-stage2-action-key`
const action = process.argv[2] || 'all'

if (['--help', '-h'].includes(action)) {
  console.log('Usage: validate-kubernetes-stage2.js [activate|test|revert|deactivate|all]')
} else if (!['activate', 'test', 'revert', 'deactivate', 'all'].includes(action)) {
  console.error('Usage: validate-kubernetes-stage2.js [activate|test|revert|deactivate|all]')
  process.exitCode = 2
} else {
  await main()
}

async function main () {
  const kubernetes = await KubernetesClient.fromKubeconfig(kubeconfigPath)
  const actionKey = action === 'deactivate' ? null : await loadOrCreateActionKey()
  const progress = ({ phase, message }) => console.log(`[${phase}] ${message}`)
  const stage2 = new KubernetesStage2Service({ kubernetes, onProgress: progress })

  if (action === 'deactivate') {
    await stage2.deactivate()
    console.log('PASS: Kubernetes Stage 2 resources were removed.')
    return
  }

  let netdata = new KubernetesNetdataClient({ kubernetes, actionKey })
  if (action === 'activate' || action === 'all') {
    const result = await stage2.activate({ actionKey })
    netdata = result.netdata
    console.log(`PASS: Stage 2 v${result.pluginVersion} is active for ${result.nodes.length} nodes.`)
    if (action === 'activate') return
  }

  if (action === 'revert') {
    await revertNginxValidation({ netdata, onProgress: progress })
    console.log('PASS: nginx validation resources were reverted.')
    return
  }

  const report = await validateNginxFromAllNodes({ netdata, onProgress: progress })
  console.log('Nginx all-node report:')
  for (const result of report.nodes) console.log(`  ${result.node}: reachable`)
  if (action === 'all') {
    await revertNginxValidation({ netdata, onProgress: progress })
    console.log('PASS: nginx was reachable from every node and the task was reverted.')
  }
}

async function loadOrCreateActionKey () {
  try {
    const key = (await readFile(keyPath, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('saved Kubernetes action key is invalid')
    await chmod(keyPath, 0o600)
    return key
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const key = randomBytes(32).toString('hex')
    await writeFile(keyPath, `${key}\n`, { mode: 0o600, flag: 'wx' })
    return key
  }
}
