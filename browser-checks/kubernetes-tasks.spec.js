import { test, expect } from '@playwright/test'
import { mkdir, mkdtemp, copyFile, chmod, rm, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { launchLabCli } from './lab-cli.js'
import { KubernetesClient } from '../src/kubernetes-client.js'
import { SettingsStore } from '../src/settings-store.js'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { RemoteRecoveryTransport } from '../src/remote-recovery-transport.js'

const applications = process.env.INTENT_KUBERNETES_APP ? [process.env.INTENT_KUBERNETES_APP] : process.env.INTENT_KUBERNETES_RESUME_TASK ? ['n8n-kubernetes'] : ['n8n-kubernetes', 'nginx-static-site-kubernetes']

for (const catalogId of applications) {
  test(`opt-in live cluster review, restart and fresh-install recovery: ${catalogId}`, async ({ page }, info) => {
    test.skip(process.env.INTENT_KUBERNETES_TASK_LIVE !== '1' || !process.env.VAULT_TEST || !process.env.INTENT_WEB_DATA_ROOT || !process.env.INTENT_WEB_CLUSTER, 'Requires explicit disposable Kubernetes mutation approval')
    test.setTimeout(300000)
    page.setDefaultTimeout(15000)
    const originalRoot = process.env.INTENT_WEB_DATA_ROOT
    const clusterId = process.env.INTENT_WEB_CLUSTER
    const store = new SettingsStore(originalRoot)
    const saved = await store.decryptKubernetesCluster({ settings: await store.load(), passphrase: process.env.VAULT_TEST, clusterId })
    const kubernetes = KubernetesClient.fromKubeconfigSource(saved.kubeconfig)
    expect(kubernetes.contextName).toBe('kind-webminai-k8s')
    const client = new KubernetesNetdataClient({ kubernetes, actionKey: saved.actionKey })
    const transport = new RemoteRecoveryTransport({ client, platform: 'kubernetes' })
    const fingerprint = (await transport.key()).fingerprint
    const initial = await kubernetes.request('/api/v1/namespaces/webminai-tasks/pods')
    const resumeTask = Number(process.env.INTENT_KUBERNETES_RESUME_TASK ?? 0)
    if (!resumeTask) expect(initial.items).toHaveLength(0)
    const roles = async () => {
      const results = await Promise.all(['/apis/rbac.authorization.k8s.io/v1/namespaces/webminai-tasks/roles/webminai-stage2-tasks', '/apis/rbac.authorization.k8s.io/v1/clusterroles/webminai-stage2-node-reader'].map(resource => kubernetes.request(resource)))
      return createHash('sha256').update(JSON.stringify(results.map(role => role.rules))).digest('hex')
    }
    const rbac = await roles()
    let cli
    let freshDirectory
    let complete = false
    let executionId
    const openCluster = async () => {
      await page.goto(cli.url)
      await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
      await page.locator('.sidebar > button').filter({ hasText: clusterId }).click()
      await expect(page.getByRole('button', { name: 'Prepare cluster plan', exact: true })).toBeEnabled()
    }
    const screenshot = name => page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true, mask: [page.locator('.tree-task')] })
    try {
      cli = await launchLabCli({ actions: true })
      await openCluster()
      if (resumeTask) await page.getByRole('button', { name: 'Review task #' + resumeTask, exact: true }).click()
      else {
        await page.getByLabel('Application', { exact: true }).selectOption(catalogId)
        await page.getByRole('button', { name: 'Prepare cluster plan', exact: true }).click()
      }
      await expect(page.getByRole('button', { name: 'Approve and continue cluster task', exact: true })).toBeVisible({ timeout: 30000 })
      if (!resumeTask) await expect(page.getByRole('button', { name: 'Approve and continue cluster task', exact: true })).toBeEnabled()
      const taskHeading = await page.getByRole('heading', { name: /^Task #\d+:/u }).innerText()
      const taskId = Number(/Task #(\d+)/u.exec(taskHeading)[1])
      executionId = /Execution: ([a-f0-9]{32})/u.exec(await page.locator('.page').innerText())[1]
      if (!resumeTask) {
        expect((await kubernetes.request('/api/v1/namespaces/webminai-tasks/persistentvolumeclaims')).items).toHaveLength(0)
        await screenshot('01-awaiting-review-no-remote-mutation')
      }
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
      await page.locator('.sidebar > button').filter({ hasText: clusterId }).click()
      await page.getByRole('button', { name: 'Review task #' + taskId, exact: true }).click()
      await expect(page.getByRole('button', { name: 'Approve and continue cluster task', exact: true })).toBeVisible()
      if (!resumeTask) {
        page.once('dialog', dialog => dialog.accept())
        await page.getByRole('button', { name: 'Approve and continue cluster task', exact: true }).click()
      }
      const taskCard = page.locator('section.card').filter({ has: page.getByRole('heading', { name: /^Task #\d+:/u }) })
      await expect(taskCard.locator('.badge').first()).toHaveText('completed', { timeout: 120000 })
      await expect(page.getByRole('button', { name: 'Approve and continue cluster task', exact: true })).toBeDisabled()
      await screenshot('02-confirmed-cluster-execution')
      await cli.close(); cli = null
      const deploymentPath = '/apis/apps/v1/namespaces/webminai-system/deployments/webminai-stage2'
      const gateway = await kubernetes.request(deploymentPath)
      await kubernetes.request(deploymentPath, { method: 'PATCH', contentType: 'application/merge-patch+json', body: { metadata: { uid: gateway.metadata.uid, resourceVersion: gateway.metadata.resourceVersion }, spec: { template: { metadata: { annotations: { 'webminai.io/recovery-restart-probe': randomUUID() } } } } } })
      await expect.poll(async () => {
        try { return (await transport.key()).fingerprint } catch { return 'restarting' }
      }, { timeout: 90000, intervals: [1000, 2000] }).toBe(fingerprint)
      await mkdir('artifacts/kubernetes-common', { recursive: true, mode: 0o700 })
      freshDirectory = await mkdtemp(path.resolve('artifacts/kubernetes-common/fresh-profile-'))
      await copyFile(store.settingsPath, path.join(freshDirectory, 'settings.json'))
      await chmod(path.join(freshDirectory, 'settings.json'), 0o600)
      process.env.INTENT_WEB_DATA_ROOT = freshDirectory
      cli = await launchLabCli({ actions: true })
      process.env.INTENT_WEB_DATA_ROOT = originalRoot
      await openCluster()
      await expect(page.getByText('No saved cluster tasks.', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Discover remote records', exact: true }).click()
      await page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Fresh-install signed recovery', exact: true }) }).getByRole('combobox').selectOption(executionId)
      await page.getByRole('button', { name: 'Verify and prepare recovery', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Approve recovery plan', exact: true })).toBeEnabled({ timeout: 60000 })
      expect((await kubernetes.request('/apis/apps/v1/namespaces/webminai-tasks/deployments')).items).toHaveLength(1)
      await expect(page.getByRole('heading', { name: /^Task #1:/u })).toBeVisible()
      await screenshot('03-fresh-install-verified-recovery-review')
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: 'Approve recovery plan', exact: true }).click()
      await expect(page.locator('section.card').filter({ has: page.getByRole('heading', { name: /^Task #1:/u }) }).locator('.badge').first()).toHaveText('completed', { timeout: 90000 })
      await expect(page.getByRole('button', { name: 'Approve recovery plan', exact: true })).toBeDisabled()
      for (const resource of ['/api/v1/namespaces/webminai-tasks/pods', '/api/v1/namespaces/webminai-tasks/persistentvolumeclaims', '/apis/apps/v1/namespaces/webminai-tasks/deployments', '/apis/batch/v1/namespaces/webminai-tasks/jobs']) expect((await kubernetes.request(resource)).items).toHaveLength(0)
      expect((await transport.key()).fingerprint).toBe(fingerprint)
      expect(await roles()).toBe(rbac)
      await screenshot('04-reviewed-recovery-complete')
      await appendFile('docs/kubernetes-lab-validation-status.md', `\n- ${new Date().toISOString()} PASS actual CLI/browser: persisted ${catalogId} plan review/reload, all-node execution, gateway restart with unchanged signing key, fresh-profile signature discovery/reconstruction and explicitly approved UID-checked recovery. Execution ${executionId}; task resources absent; RBAC unchanged.\n`)
      complete = true
    } finally {
      process.env.INTENT_WEB_DATA_ROOT = originalRoot
      await cli?.close()
      if (complete && freshDirectory) await rm(freshDirectory, { recursive: true, force: true })
      else if (freshDirectory) await appendFile('docs/kubernetes-lab-validation-status.md', `\n- ${new Date().toISOString()} Browser recovery check needs inspection. Preserved isolated encrypted profile: ${freshDirectory}. Execution ${executionId ?? 'not yet prepared'}. No automatic cleanup or replay.\n`)
    }
  })
}
