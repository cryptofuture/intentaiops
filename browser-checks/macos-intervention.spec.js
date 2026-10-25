import { test, expect } from '@playwright/test'
import { launchLabCli } from './lab-cli.js'

const hostId = 'macos-lab'
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
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await api(page, `operation?id=${accepted.id}`)
    if (current.status !== 'running') {
      expect(current.status, current.error ?? 'Inspect saved operation history').toBe('completed')
      return current.result
    }
    await page.waitForTimeout(1000)
  }
  throw new Error('Observation deadline exceeded; inspect history without replay')
}

test.describe('opt-in macOS browser intervention with actual CLI and Codex', () => {
  test.skip(process.env.INTENT_MACOS_INTERVENTION !== '1' || !process.env.VAULT_TEST || !process.env.INTENT_WEB_DATA_ROOT)
  test.beforeAll(async () => { test.setTimeout(120000); cli = await launchLabCli({ actions: true }) })
  test.afterAll(async () => { await cli?.close() })
  test.beforeEach(async ({ page }) => {
    test.setTimeout(660000)
    await page.goto(cli.url)
    await expect(page.getByRole('heading', { name: 'Your infrastructure' })).toBeVisible()
  })

  test('abort blocks remaining work, reviewed revision preserves completed history', async ({ page }) => {
    const prepared = await operation(page, { action: 'prepare', hostId, catalogId: 'host-health-macos', request: 'Read-only macOS intervention verification' })
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
    const proposal = await operation(page, { action: 'propose', hostId, taskId, expectedVersion: view.stateVersion, instructions: 'Replace remaining work with a single read-only uptime command with a new command ID. Preserve the completed collector unchanged. Do not install, edit, restart or remove anything. There are no changes requiring rollback.' })
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
    const prepared = await operation(page, { action: 'prepare', hostId, consultation: true, request: 'Using only collected inventory, briefly explain the macOS Colima readiness and any observation limits. Do not propose or execute commands or changes.' })
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
})
