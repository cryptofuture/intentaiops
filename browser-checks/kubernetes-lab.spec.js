import { test, expect } from '@playwright/test'
import { launchLabCli } from './lab-cli.js'

const clusterId = process.env.INTENT_WEB_CLUSTER
const enabled = Boolean(clusterId && process.env.INTENT_WEB_DATA_ROOT && process.env.VAULT_TEST)
let cli

test.describe('opt-in Kubernetes lab, actual CLI and read-only workspace', () => {
  test.skip(!enabled, 'Requires INTENT_WEB_CLUSTER, INTENT_WEB_DATA_ROOT and VAULT_TEST')
  test.beforeAll(async () => { test.setTimeout(120000); cli = await launchLabCli() })
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90000)
    await page.goto(cli.url)
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
    await page.locator('.sidebar > button').filter({ hasText: clusterId }).click()
    await expect(page.getByRole('heading', { name: 'Cluster inspection' })).toBeVisible()
  })
  test.afterEach(async ({ page }, info) => {
    await page.screenshot({ path: info.outputPath('kubernetes-lab.png'), fullPage: true, mask: [page.locator('.tree-task')] })
  })
  test.afterAll(async () => { await cli?.close() })

  test('real cluster API and signed gateway inspection shows all three ready nodes', async ({ page }) => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/cluster'))
    await page.getByRole('button', { name: 'Inspect API and gateway' }).click()
    const value = await (await response).json()
    expect(value.clusterId).toBe(clusterId)
    expect(value.version).toBe('v1.36.1')
    expect(value.stage2).toBe('active')
    expect(value.nodeCount).toBe(3)
    expect(value.nodes.every(node => node.ready === 'True')).toBe(true)
    expect(JSON.stringify(value)).not.toMatch(/client-key-data|certificate-authority-data|actionKey|BEGIN .*PRIVATE KEY/u)
    await expect(page.locator('.page pre')).toContainText('webminai-k8s-worker2')
    await expect(page.getByText(/Tasks use persisted reviews and the separate signed Kubernetes gateway/u)).toBeVisible()
  })

  test('authenticated refresh restores access without retaining the launch token', async ({ page }) => {
    expect(new URL(page.url()).hash).toBe('')
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
    const result = await page.evaluate(async id => {
      const session = await (await fetch('session')).json()
      const cluster = await fetch('cluster?id=' + encodeURIComponent(id))
      return { csrf: typeof session.csrf, status: cluster.status }
    }, clusterId)
    expect(result).toEqual({ csrf: 'string', status: 200 })
  })

  test('read-only mode rejects an explicitly approved forged cluster mutation', async ({ page }) => {
    const status = await page.evaluate(async id => {
      const session = await (await fetch('session')).json()
      const response = await fetch('operation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }, body: JSON.stringify({ action: 'stage2-deactivate', clusterId: id, approved: true, requestKey: 'readonly-cluster-forgery' }) })
      return response.status
    }, clusterId)
    expect(status).toBe(403)
    await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeDisabled()
  })

  test('cross-origin reads cannot subscribe to or inspect cluster state', async ({ page }) => {
    for (const endpoint of ['session', 'cluster?id=' + encodeURIComponent(clusterId), 'events']) {
      const response = await page.request.get(new URL(endpoint, page.url()).href, { headers: { Origin: 'https://untrusted.invalid' }, timeout: 10000 })
      expect(response.status()).toBe(403)
    }
  })
})
