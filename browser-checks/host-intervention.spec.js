import { test, expect } from '@playwright/test'
import { launchLabCli } from './lab-cli.js'

const platform = process.env.INTENT_INTERVENTION_PLATFORM ?? 'macos'
if (!['macos', 'windows'].includes(platform)) throw new Error('Unsupported intervention platform')
const hostId = `${platform}-lab`
let cli
async function api (page, route, body) {
  return page.evaluate(async ({ route, body }) => {
    const session = await (await fetch('session')).json()
    const response = await fetch(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }, body: JSON.stringify(body) } : {})
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`)
    return result
  }, { route, body })
}
async function operation (page, body) {
  const accepted = await api(page, 'operation', { ...body, requestKey: crypto.randomUUID() })
  return waitOperation(page, accepted.id)
}
async function waitOperation (page, id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await api(page, `operation?id=${id}`)
    if (current.status !== 'running') {
      expect(current.status, current.error ?? 'Inspect saved operation history').toBe('completed')
      return current.result
    }
    await page.waitForTimeout(1000)
  }
  throw new Error('Observation deadline exceeded; inspect history without replay')
}

test.describe(`opt-in ${platform} browser intervention with actual CLI and Codex`, () => {
  test.skip(process.env[platform === 'windows' ? 'INTENT_WINDOWS_INTERVENTION' : 'INTENT_MACOS_INTERVENTION'] !== '1' || !process.env.VAULT_TEST || !process.env.INTENT_WEB_DATA_ROOT)
  test.beforeAll(async () => { test.setTimeout(120000); cli = await launchLabCli({ actions: true }) })
  test.afterAll(async () => { await cli?.close() })
  test.beforeEach(async ({ page }) => {
    test.setTimeout(660000)
    await page.goto(cli.url)
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
  })

  test('abort blocks remaining work, reviewed revision preserves completed history', async ({ page }) => {
    const prepared = await operation(page, { action: 'prepare', hostId, catalogId: `host-health-${platform}`, request: `Read-only ${platform} intervention verification` })
    const taskId = prepared.results[0].taskId
    const inspect = () => api(page, `task?host=${hostId}&task=${taskId}`)
    let view = await inspect()
    expect(view.task.plan.commands.every(command => command.risk === 'read')).toBe(true)
    await operation(page, { action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true, commandIds: [view.commands[0].commandId] })
    view = await inspect()
    const completed = view.commands[0]
    expect(completed.status).toBe('completed')
    await operation(page, { action: 'abort', hostId, taskId, expectedVersion: view.stateVersion })
    view = await inspect()
    expect(view.control.action).toBe('abort')
    expect(view.commands.slice(1).every(command => command.status === 'pending')).toBe(true)
    const remaining = view.commands
    await expect(operation(page, { action: 'resume', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })).rejects.toThrow(/aborted/u)
    expect((await inspect()).commands).toEqual(remaining)
    const oldFingerprint = view.fingerprint
    const proposal = await operation(page, { action: 'propose', hostId, taskId, expectedVersion: view.stateVersion, instructions: `Replace remaining work with a single read-only ${platform === 'windows' ? 'PowerShell LastBootUpTime query' : 'uptime command'} with a new command ID. Preserve the completed collector unchanged. Do not install, edit, restart or remove anything. There are no changes requiring rollback.` })
    expect(proposal.proposed.commands.every(command => command.risk === 'read')).toBe(true)
    view = await inspect()
    expect(view.fingerprint).toBe(oldFingerprint)
    expect(view.commands[0]).toEqual(completed)
    await expect(operation(page, { action: 'approve', hostId, taskId, revisionId: proposal.revisionId, expectedVersion: view.stateVersion, fingerprint: '0'.repeat(64), approved: true })).rejects.toThrow()
    await operation(page, { action: 'approve', hostId, taskId, revisionId: proposal.revisionId, expectedVersion: view.stateVersion, fingerprint: proposal.fingerprint, approved: true })
    view = await inspect()
    expect(view.fingerprint).toBe(proposal.fingerprint)
    expect(view.commands.find(command => command.commandId === completed.commandId)).toEqual(completed)
    expect(view.control.action).toBe('pause')
    await operation(page, { action: 'abort', hostId, taskId, expectedVersion: view.stateVersion })
    expect((await inspect()).control.action).toBe('abort')
  })

  test('actual Codex consultation persists advice without an executable plan', async ({ page }) => {
    const prepared = await operation(page, { action: 'prepare', hostId, consultation: true, request: `Using only collected inventory, briefly explain the ${platform} ${platform === 'windows' ? 'Docker Desktop' : 'Colima'} readiness and any observation limits. Do not propose or execute commands or changes.` })
    const taskId = prepared.results[0].taskId
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
    const view = await api(page, `task?host=${hostId}&task=${taskId}`)
    expect(view.task.kind).toBe('consultation')
    expect(view.task.status).toBe('consulted')
    expect(view.task.consultationAnswer.trim().length).toBeGreaterThan(0)
    expect(view.task.plan).toBeFalsy()
    expect(view.commands).toEqual([])
  })

  test('in-flight pause and browser reload preserve the durable health job', async ({ page }, info) => {
    const prepared = await operation(page, { action: 'prepare', hostId, catalogId: `host-health-${platform}`, request: 'Read-only durable job pause and reload verification' })
    const taskId = prepared.results[0].taskId
    const inspect = () => api(page, `task?host=${hostId}&task=${taskId}`)
    let view = await inspect()
    expect(view.task.plan.commands.every(command => command.risk === 'read')).toBe(true)
    const jobIndex = view.task.plan.commands.findLastIndex(command => command.executionMode === 'job')
    expect(jobIndex).toBeGreaterThanOrEqual(0)
    expect(jobIndex).toBeLessThan(view.commands.length - 1)
    if (jobIndex > 0) {
      await operation(page, { action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true, commandIds: view.commands.slice(0, jobIndex).map(command => command.commandId) })
      view = await inspect()
    }
    const completed = view.commands.slice(0, jobIndex)
    const executing = await api(page, 'operation', { action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true, requestKey: crypto.randomUUID() })
    let running
    for (let attempt = 0; attempt < 240; attempt++) {
      view = await inspect()
      running = view.commands[jobIndex]
      if (running.status === 'uncertain' && running.jobId) break
      if (running.status === 'completed') break
      await page.waitForTimeout(250)
    }
    expect(running.status).toBe('uncertain')
    expect(running.jobId).toBeTruthy()
    await expect(operation(page, { action: 'execute', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })).rejects.toThrow()
    view = await inspect()
    await operation(page, { action: 'pause', hostId, taskId, expectedVersion: view.stateVersion })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
    await waitOperation(page, executing.id)
    view = await inspect()
    expect(view.commands[jobIndex]).toMatchObject({ status: 'completed', attemptId: running.attemptId, jobId: running.jobId })
    expect(view.commands.slice(0, jobIndex)).toEqual(completed)
    expect(view.commands.slice(jobIndex + 1).every(command => command.status === 'pending')).toBe(true)
    await page.getByRole('textbox', { name: 'Search hosts' }).fill(hostId)
    await page.locator('.tree-task').filter({ hasText: new RegExp(`^#${taskId} `, 'u') }).click()
    const pane = page.locator('.task-pane').last()
    await pane.getByRole('button', { name: 'execution', exact: true }).click()
    const mask = [page.locator('pre'), page.locator('code')]
    await page.screenshot({ path: info.outputPath(`${platform}-paused-durable-job.png`), fullPage: true, mask })
    await operation(page, { action: 'resume', hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })
    view = await inspect()
    expect(view.commands.every(command => command.status === 'completed')).toBe(true)
    expect(view.commands[jobIndex]).toMatchObject({ attemptId: running.attemptId, jobId: running.jobId })
    expect(view.commands.slice(0, jobIndex)).toEqual(completed)
    await expect(pane.locator('header .status-completed')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${platform}-completed-durable-job.png`), fullPage: true, mask })
  })
})
