import { test, expect } from '@playwright/test'
import { launchLabCli } from './lab-cli.js'

let cli
test.describe('opt-in Windows browser SSH shell', () => {
  test.skip(process.env.INTENT_WINDOWS_SHELL !== '1' || !process.env.VAULT_TEST || !process.env.INTENT_WEB_DATA_ROOT)
  test.beforeAll(async () => { test.setTimeout(120000); cli = await launchLabCli({ actions: true }) })
  test.afterAll(async () => { await cli?.close() })

  test('native output, resize, reload and close preserve the shared host connection', async ({ page }, info) => {
    test.setTimeout(180000)
    await page.goto(cli.url)
    const open = async () => {
      await page.getByRole('textbox', { name: 'Search hosts' }).fill('windows-lab')
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
      await expect(page.locator('.page .status-connected')).toBeVisible({ timeout: 60000 })
      await page.getByRole('button', { name: 'terminal', exact: true }).click()
    }
    await open()
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Open SSH shell', exact: true }).click()
    const terminal = page.locator('.browser-terminal')
    await expect(terminal.locator('textarea')).toHaveCount(1, { timeout: 60000 })
    await terminal.locator('textarea').focus()
    await page.keyboard.type('powershell.exe -NoProfile -NonInteractive -Command "[Console]::WriteLine((\'INTENT_WINDOWS_BROWSER_\'+\'SHELL_OK\'));[Console]::WriteLine([Environment]::OSVersion.Platform)"')
    await page.keyboard.press('Enter')
    await expect(terminal).toContainText('INTENT_WINDOWS_BROWSER_SHELL_OK', { timeout: 30000 })
    await expect(terminal).toContainText('Win32NT')
    const resized = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/shell') && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'resize')
    await page.setViewportSize({ width: 1100, height: 850 })
    expect((await resized).ok()).toBe(true)
    await page.reload()
    await open()
    await page.getByRole('button', { name: /^Attach .* · running/u }).click()
    await expect(terminal).toContainText('INTENT_WINDOWS_BROWSER_SHELL_OK')
    expect(((await terminal.innerText()).match(/INTENT_WINDOWS_BROWSER_SHELL_OK/gu) ?? []).length).toBe(1)
    await page.screenshot({ path: info.outputPath('windows-ssh-shell.png'), fullPage: true, maskColor: '#808080', mask: [page.locator('.tree-task:visible'), page.locator('.task-tabs:visible')] })
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: /End SSH session$/u }).click()
    await expect(page.getByRole('status', { exact: false })).toContainText('closed')
    const metrics = await page.evaluate(async () => (await fetch('metrics?host=windows-lab')).json())
    expect(metrics.state).toBe('available')
    const inventory = await page.evaluate(async () => (await fetch('inventory?host=windows-lab')).json())
    expect(inventory.webminaiExecution.platform).toBe('windows')
  })
})
