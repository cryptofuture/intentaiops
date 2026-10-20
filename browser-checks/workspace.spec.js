import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startOperatorConsole } from '../src/operator-console.js'
import { OperatorController } from '../src/operator-controller.js'
import { OperatorWorkspace } from '../src/operator-workspace.js'
import { AdminService } from '../src/admin-service.js'
import { TaskStore } from '../src/task-store.js'
import { palettes } from '../web/themes/index.js'
import { withHostMutation } from '../src/host-mutation-ownership.js'

let server, root, tasks, settings, controller, commandGate, browserShells
const command = { id: 'inspect', command: 'printf harmless-fixture', purpose: 'Read fixture state', risk: 'read', requiresSudo: false, timeoutMs: 1000, dependsOn: [] }
const plan = { summary: 'Inspect fixture', changeOverview: 'Read-only fixture', modifiedFiles: [], commands: [command], revertCommands: [] }
const browserErrors = new WeakMap()
test.beforeEach(async ({ page }) => { const errors = []; browserErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)) })
test.afterEach(async ({ page }, info) => {
  const screenshot = info.outputPath('workspace.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  expect(browserErrors.get(page)).toEqual([])
})
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'intent-web-browser-'))
  settings = { servers: { fixture: {}, other: {} }, clusters: {} }
  tasks = new TaskStore(root)
  const admin = new AdminService({ dataRoot: root, tasks, workspace: { loadRules: async () => ({ policy: {} }) } })
  admin.serverSecrets = async () => ({})
  admin.settings.decryptApplicationDefaults = async () => ({})
  admin.capabilities = async () => ({ platform: { os: 'linux' } })
  admin.refreshInventory = async () => ({})
  admin.routeTask = async () => ({ decision: 'ordinary_planning', relevantCatalogIds: [], foundationIds: [], foundationMode: 'none' })
  admin.plan = async () => plan
  admin.consult = async () => ({ answer: 'The fixture is healthy. No changes were requested.', contextSummary: 'Read-only fixture consultation' })
  admin.netdata = () => ({ runCommand: async () => { if (commandGate) await commandGate; return { exitCode: 0, stdout: 'fixture output', stderr: '' } } })
  controller = new OperatorController({ dataRoot: root, settings, tasks, adminFor: async () => admin })
  const shellProgram = "process.stdin.setRawMode(true);process.stdout.write('FIXTURE_SHELL_READY\\r\\n');let line='';process.stdin.on('data',data=>{for(const ch of data.toString()){if(ch==='\\r'){process.stdout.write('\\r\\nFIXTURE_RESULT:'+line+'\\r\\n');if(line==='exit')process.exit(0);line=''}else{line+=ch;process.stdout.write(ch)}}})"
  const hosts = { states: new Map(), close: async () => {}, configure: (_host, operation) => withHostMutation({ dataRoot: root, identity: 'fixture' }, operation), lease: async () => ({ close: async () => {} }), terminal: async (_host, operation) => operation(), sessions: new Map([['fixture', { server: { connectionUrl: 'ssh://fixture.invalid' }, ssh: { interactiveShell: async (_url, { runner }) => runner(process.execPath, ['-e', shellProgram]) } }]]) }
  const workspace = new OperatorWorkspace({ controller, hosts, metrics: { get: async () => ({ state: 'unavailable', reason: 'No fixture collector' }), close () {} } })
  browserShells = workspace.shells
  server = await startOperatorConsole({ controller, workspace, actions: true })
})
test.afterAll(async () => { await server?.close(); await rm(root, { recursive: true, force: true }) })

test('all 27 component galleries render without horizontal overflow or browser errors', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  for (const theme of palettes) {
    await page.goto(server.origin + `/?gallery=1&theme=${theme.id}`)
    await expect(page.locator('h1')).toHaveText(theme.name)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
    await page.screenshot({ path: path.resolve(`artifacts/browser-screenshots/gallery-${theme.id}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.locator('body').evaluate(el => window.getComputedStyle(el).visibility)).toBe('visible')
  }
  expect(errors).toEqual([])
})

test('real browser restores session, previews without writes, cancels and persists all themes', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
  const logo = page.getByRole('img', { name: 'Intent AI Ops logo', exact: true })
  await expect(logo).toBeVisible()
  const image = await page.request.get(new URL(await logo.getAttribute('src'), page.url()).href)
  expect(image.headers()['content-type']).toBe('image/png')
  expect(await image.body()).toEqual(await readFile(new URL('../public/logo.png', import.meta.url)))
  expect(new URL(page.url()).hash).toBe('')
  const posts = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/preferences')) posts.push(request.postDataJSON()) })
  const before = await page.locator('html').getAttribute('data-theme')
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByPlaceholder('Search palettes…').fill('Graphite')
  await page.getByPlaceholder('Search palettes…').press('ArrowDown')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite')
  expect(posts.length).toBe(0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', before)
  expect(posts.length).toBe(0)
  for (const theme of palettes) {
    await page.getByRole('button', { name: 'Appearance' }).click()
    await page.getByPlaceholder('Search palettes…').fill(theme.name)
    await page.locator('.theme').filter({ has: page.getByText(theme.name, { exact: true }) }).click()
    await page.getByRole('button', { name: 'Use selected palette' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
  }
  expect(posts.length).toBe(27)
})

test('durable browser preparation requires review, survives reload and appears in shared history', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: 'New task' }).click()
  await page.getByRole('checkbox', { name: 'fixture', exact: true }).check()
  await page.getByPlaceholder('Describe the intended outcome, constraints and verification…').fill('Inspect fixture from browser')
  await page.getByRole('button', { name: 'Prepare for review' }).click()
  await expect.poll(() => tasks.list('fixture').length).toBe(1)
  await expect.poll(() => tasks.get('fixture', 1).status).toBe('planned')
  expect(tasks.allExecutionEvents('fixture', 1)).toEqual([])
  await page.reload()
  await page.getByRole('button', { name: /#1 Inspect fixture from browser/ }).click()
  await expect(page.getByRole('heading', { name: 'Inspect fixture', exact: true })).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Review and execute plan', exact: true }).click()
  await expect.poll(() => tasks.get('fixture', 1).status).toBe('completed')
  expect(tasks.allExecutionEvents('fixture', 1).filter(e => e.type === 'command_dispatched')).toHaveLength(1)
})

test('representative responsive light and dark layouts', async ({ page }) => {
  for (const theme of ['dawn', 'dusk']) {
    for (const width of [390, 850]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(server.origin + `/?gallery=1&theme=${theme}`)
      await expect(page.locator('h1')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: path.resolve(`artifacts/browser-screenshots/responsive-${theme}-${width}.png`), fullPage: true })
    }
  }
})

test('actual workspace navigation and host search fit narrow viewports', async ({ page }) => {
  await page.goto(server.url)
  await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
  for (const name of ['Overview', 'Multi-host runs', 'Activity', 'Settings', 'Appearance', 'New task']) {
    const button = page.getByRole('button', { name, exact: true })
    await expect(button.locator('svg')).toHaveCount(1)
    await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true')
    await expect(button).toHaveCSS('column-gap', '8px')
    expect(await button.evaluate(button => {
      const icon = button.querySelector('svg').getBoundingClientRect()
      const text = [...button.childNodes].find(node => node.nodeType === window.Node.TEXT_NODE && node.textContent.trim())
      const range = document.createRange(); range.selectNodeContents(text)
      return range.getBoundingClientRect().left - icon.right
    })).toBeGreaterThanOrEqual(7)
  }
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to workspace' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#workspace-content')).toBeFocused()
  await expect(page.locator('.cards > .card').first()).toHaveCSS('margin-bottom', '0px')
  for (const width of [390, 850]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('textbox', { name: 'Search hosts' }).fill('missing-host')
    await expect(page.getByRole('button', { name: 'Open workspace', exact: true })).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Search hosts' }).fill('FIXTURE')
    await expect(page.getByRole('button', { name: 'Open workspace', exact: true })).toBeVisible()
    await page.screenshot({ path: path.resolve(`artifacts/browser-screenshots/workspace-${width}.png`), fullPage: true })
  }
})

test('System mode follows OS changes while independent choices survive preview cancellation', async ({ page }) => {
  await page.goto(server.url)
  for (const name of ['macOS Dark', 'macOS Light']) {
    await page.getByRole('button', { name: 'Appearance' }).click()
    await page.getByPlaceholder('Search palettes…').fill(name)
    await page.locator('.theme').filter({ has: page.getByText(name, { exact: true }) }).click()
    await page.getByRole('button', { name: 'Use selected palette' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('combobox').selectOption('system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'macos-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'macos-light')
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByPlaceholder('Search palettes…').fill('Graphite')
  await page.getByPlaceholder('Search palettes…').press('ArrowDown')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite')
  await page.getByPlaceholder('Search palettes…').press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'macos-light')
  await expect(page.getByRole('combobox')).toHaveValue('system')
})

test('closing an active task pane never cancels or repeats its command', async ({ page }) => {
  const dialogs = []
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.accept() })
  const created = tasks.create('fixture', 'CLI-created long inspection')
  tasks.savePlan('fixture', created.id, plan)
  let release
  commandGate = new Promise(resolve => { release = resolve })
  try {
    await page.goto(server.url)
    await page.getByRole('button', { name: new RegExp(`#${created.id} CLI-created`) }).click()
    await expect(page.locator('.task-pane').last().locator('header').first()).toContainText('#' + created.id)
    await expect(page.getByRole('button', { name: 'Review and execute plan', exact: true }).last()).toBeEnabled()
    await page.getByRole('button', { name: 'Review and execute plan', exact: true }).last().click()
    await expect.poll(() => tasks.get('fixture', created.id).status).toBe('running')
    await page.getByRole('button', { name: 'Close task view only' }).last().click()
    expect(tasks.get('fixture', created.id).status).toBe('running')
    release()
    await expect.poll(() => tasks.get('fixture', created.id).status).toBe('completed')
    expect(tasks.allExecutionEvents('fixture', created.id).filter(e => e.type === 'command_dispatched')).toHaveLength(1)
    expect(dialogs).toEqual(['confirm'])
  } finally { release(); commandGate = null }
})

async function openRecordedTask (page, request, savedPlan = plan) {
  const task = tasks.create('fixture', request)
  tasks.savePlan('fixture', task.id, savedPlan)
  await page.goto(server.url)
  await page.getByRole('button', { name: new RegExp(`#${task.id} ${request.slice(0, 20)}`) }).click()
  const pane = page.locator('.task-pane').last()
  await expect(pane.locator('header strong')).toHaveText('#' + task.id)
  await expect(pane.getByRole('button', { name: 'Review and execute plan', exact: true })).toBeVisible()
  return { task, pane }
}

test('composer requires explicit targets and cancellation creates no work', async ({ page }) => {
  const before = tasks.list('fixture').length
  await page.goto(server.url)
  await page.getByRole('button', { name: 'New task' }).click()
  await page.getByPlaceholder('Describe the intended outcome, constraints and verification…').fill('Do not execute this request')
  await expect(page.getByRole('button', { name: 'Prepare for review' })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'fixture', exact: true }).check()
  await expect(page.getByRole('button', { name: 'Prepare for review' })).toBeEnabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(tasks.list('fixture').length).toBe(before)
})

test('dismissing execution approval dispatches no remote command', async ({ page }) => {
  const { task, pane } = await openRecordedTask(page, 'Cancelled approval inspection')
  page.once('dialog', dialog => dialog.dismiss())
  await pane.getByRole('button', { name: 'Review and execute plan', exact: true }).click()
  expect(tasks.get('fixture', task.id).status).toBe('planned')
  expect(tasks.allExecutionEvents('fixture', task.id)).toEqual([])
})

test('stale browser approval is rejected after the saved plan changes', async ({ page }) => {
  const { task, pane } = await openRecordedTask(page, 'Stale approval inspection')
  tasks.savePlan('fixture', task.id, { ...plan, summary: 'Changed after review', commands: [{ ...command, command: 'printf changed-fixture' }] })
  page.once('dialog', dialog => dialog.accept())
  await pane.getByRole('button', { name: 'Review and execute plan', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'stale operator decision' })).toBeVisible()
  expect(tasks.allExecutionEvents('fixture', task.id)).toEqual([])
})

test('per-command review executes only the explicitly selected command', async ({ page }) => {
  const two = { ...plan, commands: [command, { ...command, id: 'second', command: 'printf second-fixture' }] }
  const { task, pane } = await openRecordedTask(page, 'Selective command inspection', two)
  await pane.getByRole('button', { name: 'Per-command review' }).click()
  await pane.getByRole('checkbox', { name: 'Approve this command' }).first().check()
  page.once('dialog', dialog => dialog.accept())
  await pane.getByRole('button', { name: 'Review and execute selected commands', exact: true }).click()
  await expect.poll(() => tasks.get('fixture', task.id).status).toBe('partial')
  expect(tasks.allExecutionEvents('fixture', task.id).filter(event => event.type === 'command_dispatched').map(event => event.commandId)).toEqual(['inspect'])
  const remaining = controller.inspect('fixture', task.id)
  await controller.resume('fixture', task.id, remaining.stateVersion, remaining.fingerprint)
})

test('recorded results paginate while withholding output and rendering hostile content as text', async ({ page }) => {
  const { task, pane } = await openRecordedTask(page, 'Paginated evidence inspection', { ...plan, summary: '<img src=x onerror=alert(1)>' })
  for (let i = 0; i < 25; i++) tasks.appendResult('fixture', task.id, { id: 'recorded-' + i, status: 'completed', result: { exitCode: 0, stdout: 'PRIVATE_OUTPUT_MARKER', stderr: 'PRIVATE_ERROR_MARKER' } })
  await expect(pane.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true })).toBeVisible()
  await expect(pane.locator('img')).toHaveCount(0)
  await pane.getByRole('button', { name: 'execution', exact: true }).click()
  const results = pane.locator('.card').filter({ has: page.getByRole('heading', { name: 'Recorded results and diagnostic evidence', exact: true }) })
  await expect(results.locator('details')).toHaveCount(20)
  await results.getByRole('button', { name: 'Load next result page' }).click()
  await expect(results.locator('details')).toHaveCount(25)
  await results.locator('details').first().locator('summary').click()
  await expect(results).not.toContainText('PRIVATE_OUTPUT_MARKER')
  await expect(results).not.toContainText('PRIVATE_ERROR_MARKER')
})

test('SSE reconnect catches up without duplicating recorded activity', async ({ page, context }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: 'Activity' }).click()
  await expect(page.locator('.sidebar-bottom .status-live')).toBeVisible()
  await context.setOffline(true)
  server.server.closeAllConnections()
  await expect(page.locator('.sidebar-bottom .status-reconnecting')).toBeVisible({ timeout: 15000 })
  controller.record({ type: 'browser_reconnect_fixture', hostId: 'fixture' })
  await context.setOffline(false)
  await page.getByRole('textbox', { name: 'Filter activity' }).fill('browser_reconnect_fixture')
  await expect(page.locator('.event-row')).toHaveCount(1, { timeout: 15000 })
  await page.locator('.event-row').click()
  await expect(page.getByRole('heading', { name: 'Recorded detail' }).locator('..')).toContainText('browser_reconnect_fixture')
})

test('read-only consultation displays its saved answer without execution controls', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: 'New task' }).click()
  await page.getByRole('checkbox', { name: 'fixture', exact: true }).check()
  await page.getByRole('combobox').selectOption('consultation')
  await page.getByPlaceholder('Describe the intended outcome, constraints and verification…').fill('Explain fixture health')
  await page.getByRole('button', { name: 'Prepare for review' }).click()
  await expect.poll(() => tasks.list('fixture').find(task => task.request.includes('Explain fixture health'))?.status).toBe('consulted')
  const task = tasks.list('fixture').find(task => task.request.includes('Explain fixture health'))
  await page.route(/\/task\?/u, async route => {
    if (new URL(route.request().url()).searchParams.get('task') !== String(task.id)) await new Promise(resolve => setTimeout(resolve, 500))
    await route.continue()
  })
  await page.reload()
  await page.getByRole('button', { name: new RegExp(`#${task.id} .*Explain fixture health`) }).click()
  const pane = page.locator('.task-pane').last()
  await expect(pane).toContainText('The fixture is healthy. No changes were requested.')
  await expect(pane.getByRole('heading', { name: 'Read-only consultation', exact: true })).toBeInViewport()
  await expect(pane.getByRole('button', { name: /Review and execute/u })).toHaveCount(0)
  expect(tasks.allExecutionEvents('fixture', task.id)).toEqual([])
})

test('multi-host browser preparation persists separate unapproved plans and canary continuation halts safely', async ({ page }) => {
  await page.goto(server.url)
  await page.getByRole('button', { name: 'New task' }).click()
  await page.getByRole('checkbox', { name: 'fixture', exact: true }).check()
  await page.getByRole('checkbox', { name: 'other', exact: true }).check()
  await page.getByPlaceholder('Describe the intended outcome, constraints and verification…').fill('Inspect both browser fixture hosts')
  await page.getByRole('button', { name: 'Prepare for review' }).click()
  await expect.poll(() => controller.runs.list().find(run => run.request === 'Inspect both browser fixture hosts')?.status).toBe('planned')
  const run = controller.runs.list().find(run => run.request === 'Inspect both browser fixture hosts')
  for (const host of run.hosts) expect(tasks.allExecutionEvents(host.serverId, host.taskId)).toEqual([])
  await page.reload()
  await page.getByRole('button', { name: 'Multi-host runs' }).click()
  const card = page.locator('.page > .card').filter({ has: page.getByRole('heading', { name: `Run #${run.id} · ${run.request}`, exact: true }) })
  await expect(card.getByRole('checkbox', { name: 'Select after reviewing this plan' })).toHaveCount(2)
  for (const checkbox of await card.getByRole('checkbox', { name: 'Select after reviewing this plan' }).all()) await checkbox.check()
  await card.getByRole('combobox').selectOption('fixture')
  page.once('dialog', dialog => dialog.accept())
  await card.getByRole('button', { name: 'Approve and continue selected hosts' }).click()
  await expect.poll(() => tasks.get('fixture', run.hosts.find(host => host.serverId === 'fixture').taskId).status).toBe('completed')
  await expect(card).toContainText('rollout-halted')
  expect(tasks.get('other', run.hosts.find(host => host.serverId === 'other').taskId).status).toBe('planned')
  expect(tasks.allExecutionEvents('other', run.hosts.find(host => host.serverId === 'other').taskId)).toEqual([])
  page.once('dialog', dialog => dialog.accept())
  await card.getByRole('button', { name: 'Approve and continue selected hosts' }).click()
  await expect.poll(() => tasks.get('other', run.hosts.find(host => host.serverId === 'other').taskId).status).toBe('completed')
  expect(tasks.allExecutionEvents('fixture', run.hosts.find(host => host.serverId === 'fixture').taskId).filter(event => event.type === 'command_dispatched')).toHaveLength(1)
})

test('browser terminal uses a real PTY, survives refresh, preserves output on theme changes and closes explicitly', async ({ page }) => {
  const engine = page.waitForResponse(response => response.url().endsWith('.wasm'))
  await page.goto(server.url)
  await page.getByRole('textbox', { name: 'Search hosts' }).fill('fixture')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await page.getByRole('button', { name: 'terminal', exact: true }).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Open SSH shell', exact: true }).click()
  await expect(page.locator('.browser-terminal')).toContainText('FIXTURE_SHELL_READY')
  const response = await engine
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('application/wasm')
  expect(new URL(response.url()).origin).toBe(server.origin)
  await expect(page.locator('.browser-terminal canvas')).toHaveCount(1)
  const themeId = await page.locator('html').getAttribute('data-theme')
  const foreground = palettes.find(theme => theme.id === themeId).text
  await expect.poll(() => page.locator('.browser-terminal canvas').evaluate((canvas, color) => {
    const rgb = color.slice(1).match(/../g).map(value => parseInt(value, 16))
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 0; i < pixels.length; i += 4) if (rgb.every((value, channel) => Math.abs(value - pixels[i + channel]) < 5)) return true
    return false
  }, foreground)).toBe(true)
  await page.locator('.browser-terminal textarea').focus()
  await page.keyboard.type('uptime')
  await page.keyboard.press('Enter')
  await expect(page.locator('.browser-terminal')).toContainText('FIXTURE_RESULT:uptime')
  const id = browserShells.list().find(shell => shell.status === 'running').id
  for (const id of ['dusk', 'dawn', 'dusk']) {
    const theme = palettes.find(theme => theme.id === id)
    await page.getByRole('button', { name: 'Appearance' }).click()
    await page.getByPlaceholder('Search palettes…').fill(id)
    await page.locator('.theme').filter({ has: page.getByText(theme.name, { exact: true }) }).click()
    await page.getByRole('button', { name: 'Use selected palette' }).click()
    await expect(page.locator('.browser-terminal')).toContainText('FIXTURE_RESULT:uptime')
    await expect.poll(() => page.locator('.browser-terminal canvas').evaluate((canvas, theme) => {
      const rgb = value => value.slice(1).match(/../g).map(value => parseInt(value, 16))
      const background = rgb(theme.canvas); const foreground = rgb(theme.text)
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let matchingBackground = 0; let matchingForeground = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (background.every((value, channel) => value === pixels[i + channel])) matchingBackground++
        if (foreground.every((value, channel) => Math.abs(value - pixels[i + channel]) < 5)) matchingForeground++
      }
      return matchingBackground / (pixels.length / 4) > 0.9 && matchingForeground > 0
    }, theme)).toBe(true)
  }
  await page.screenshot({ path: path.resolve('artifacts/browser-screenshots/ghostty-terminal-dusk.png'), fullPage: true })
  await page.reload()
  expect(browserShells.get(id).status).toBe('running')
  await page.getByRole('textbox', { name: 'Search hosts' }).fill('fixture')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await page.getByRole('button', { name: 'terminal', exact: true }).click()
  await page.getByRole('button', { name: /^Attach fixture · running/u }).click()
  await expect(page.locator('.browser-terminal')).toContainText('FIXTURE_RESULT:uptime')
  expect(browserShells.list().filter(shell => shell.status === 'running')).toHaveLength(1)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: /End SSH session$/u }).click()
  await expect.poll(() => browserShells.get(id).status).toBe('closed')
  await expect(page.locator('.browser-terminal')).toContainText('SSH exited:')
})

test('declining direct shell approval does not create a session', async ({ page }) => {
  const before = browserShells.list().length
  await page.goto(server.url)
  await page.getByRole('textbox', { name: 'Search hosts' }).fill('fixture')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await page.getByRole('button', { name: 'terminal', exact: true }).click()
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Open SSH shell', exact: true }).click()
  expect(browserShells.list().length).toBe(before)
})
