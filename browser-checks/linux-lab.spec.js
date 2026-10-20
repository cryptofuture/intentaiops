import { test, expect } from '@playwright/test'
import { launchLabCli } from './lab-cli.js'

const hostId = process.env.INTENT_WEB_HOST
const dataRoot = process.env.INTENT_WEB_DATA_ROOT
const enabled = Boolean(hostId && dataRoot && process.env.VAULT_TEST)
let cli, launch, hostSnapshot
const errors = new WeakMap()

test.describe('opt-in existing Linux lab, actual CLI and read-only browser', () => {
  test.skip(!enabled, 'Requires INTENT_WEB_HOST, existing INTENT_WEB_DATA_ROOT and VAULT_TEST')
  test.beforeAll(async () => {
    test.setTimeout(120000)
    if (!/^[a-z0-9_-]{1,128}$/u.test(hostId)) throw new Error('Invalid lab host identifier')
    cli = await launchLabCli()
    launch = cli.url
  })
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90000)
    const list = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message))
    await page.goto(launch)
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
    hostSnapshot = await page.evaluate(async () => (await (await fetch('workspace')).json()).hosts)
    expect(hostSnapshot.some(host => host.id === hostId)).toBe(true)
    await page.getByRole('textbox', { name: 'Search hosts' }).fill(hostId)
  })
  test.afterEach(async ({ page }, info) => {
    if (!errors.has(page)) return
    const screenshot = info.outputPath('linux-lab.png')
    await page.screenshot({ path: screenshot, fullPage: true, maskColor: '#808080', mask: [page.locator('pre:visible'), page.locator('code:visible'), page.locator('.tree-task:visible'), page.locator('.task-tabs:visible')] })
    expect(errors.get(page)).toEqual([])
  })
  test.afterAll(async () => {
    await cli?.close()
  })

  test('saved lab host is navigable and changing controls stay disabled', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
    await expect(page.getByRole('heading', { name: hostId, exact: true })).toBeVisible()
    for (const label of ['Connect', 'Disconnect', 'Activate Stage 2', 'Update plugin only', 'Deactivate Stage 2']) await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Remove local configuration$/u })).toBeDisabled()
  })

  test('actual Netdata CPU, RAM and filesystem measurements render with timestamps', async ({ page }) => {
    const observed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/metrics'))
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
    const response = await observed
    expect(response.ok()).toBe(true)
    const metrics = await response.json()
    expect(metrics.state).toBe('available')
    expect(metrics.sourceNode).toMatch(/^[a-f0-9-]{36}$/iu)
    for (const context of ['system.cpu', 'system.ram', 'disk.space']) {
      const value = metrics.values.find(value => value.context === context)
      expect(value.state).toBe('available')
      expect(Number.isFinite(Date.parse(value.observedAt))).toBe(true)
      await expect(page.getByRole('heading', { name: context, exact: true })).toBeVisible()
    }
    await expect(page.locator('.metrics meter')).toHaveCount(2)
    await expect(page.locator('.page .status-connected')).toBeVisible()
  })

  test('explicit inventory refresh reads the real host without dispatching work', async ({ page }) => {
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
    await page.getByRole('button', { name: 'inventory', exact: true }).click()
    const observation = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/inventory'))
    await page.getByRole('button', { name: 'Refresh inventory explicitly' }).click()
    const response = await observation
    expect(response.ok()).toBe(true)
    const value = await response.json()
    expect(Object.keys(value.info ?? {}).length).toBeGreaterThan(0)
    await expect(page.locator('.page pre')).toContainText('info')
  })

  test('existing CLI task history and recorded results open inside a browser pane', async ({ page }) => {
    const task = hostSnapshot.find(host => host.id === hostId).tasks[0]
    expect(task, 'Selected lab host must contain existing CLI history').toBeTruthy()
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
    await page.getByRole('button', { name: 'tasks', exact: true }).click()
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: '#' + task.id, exact: true }) }).getByRole('button', { name: 'Inspect', exact: true }).click()
    const pane = page.locator('.task-pane').last()
    await expect(pane.locator('header strong')).toHaveText('#' + task.id)
    await pane.getByRole('button', { name: 'execution', exact: true }).click()
    await expect(pane.getByRole('heading', { name: 'Recorded results and diagnostic evidence' })).toBeVisible()
    await expect(pane.getByRole('button', { name: 'Review and resume', exact: true })).toBeDisabled()
  })

  test('read-only server rejects a forged approved mutation from browser JavaScript', async ({ page }) => {
    const status = await page.evaluate(async hostId => {
      const session = await (await fetch('session')).json()
      const response = await fetch('operation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }, body: JSON.stringify({ action: 'host-remove', hostId, approved: true, requestKey: 'live-readonly-forgery-01' }) })
      return response.status
    }, hostId)
    expect(status).toBe(403)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
  })
})
