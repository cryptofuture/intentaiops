import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { palettes, appearance, resolveTheme, selectTheme, tokens, shiftLightness } from '../web/themes/index.js'
import { UiPreferences } from '../src/ui-preferences.js'
import { OperatorController } from '../src/operator-controller.js'
import { OperatorWorkspace } from '../src/operator-workspace.js'
import { startOperatorConsole } from '../src/operator-console.js'
import { AdminService } from '../src/admin-service.js'
import { TaskStore } from '../src/task-store.js'
import { withHostMutation } from '../src/host-mutation-ownership.js'
import { OperatorHosts } from '../src/operator-hosts.js'
import { normalizeMetrics, OperatorMetrics } from '../src/operator-metrics.js'
import { runCli } from '../src/cli.js'

const ids = 'graphite dusk macos-dark gruvbox-dark catppuccin-mocha catppuccin-macchiato catppuccin-frappe tokyo-night nord rose-pine solarized-dark dracula everforest-dark kanagawa-wave github-dark paper dawn macos-light gruvbox-light catppuccin-latte tokyo-night-day nord-light rose-pine-dawn solarized-light everforest-light kanagawa-lotus github-light'.split(' ')
const command = { id: 'read', command: 'printf fixture', risk: 'read', requiresSudo: false, purpose: 'Inspect fixture', timeoutMs: 1000, dependsOn: [] }
const plan = { summary: 'Inspect fixture', changeOverview: 'Read fixture', modifiedFiles: [], commands: [command], revertCommands: [] }
async function fixture (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-workspace-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskStore(root)
  const settings = { servers: { host: {}, other: {} }, clusters: {} }
  const calls = []
  const admin = new AdminService({ dataRoot: root, tasks, workspace: { loadRules: async () => ({ policy: {} }) } })
  admin.settings.decryptApplicationDefaults = async () => ({})
  admin.capabilities = async () => ({ platform: { os: 'linux' } })
  admin.refreshInventory = async () => ({})
  admin.routeTask = async () => ({ decision: 'ordinary_planning', relevantCatalogIds: [], foundationIds: [], foundationMode: 'none' })
  admin.plan = async () => plan
  admin.serverSecrets = async () => ({})
  admin.netdata = () => ({ runCommand: async value => { calls.push(value); return { exitCode: 0, stdout: 'withheld fixture', stderr: '' } } })
  const controller = new OperatorController({ dataRoot: root, settings, tasks, adminFor: async () => ({ admin, close: () => {} }) })
  const workspace = new OperatorWorkspace({ controller, hosts: { states: new Map(), close () {} }, metrics: { close () {} } })
  t.after(() => workspace.close())
  return { root, tasks, settings, admin, controller, workspace, calls }
}

test('27 exact canonical palettes match an independent pinned upstream JSON fixture', async () => {
  assert.deepEqual(palettes.map(p => p.id).sort(), [...ids].sort())
  assert.equal(palettes.filter(p => p.dark).length, 15)
  assert.equal(palettes.filter(p => !p.dark).length, 12)
  const reference = JSON.parse(await readFile(new URL('./fixtures/theme-palettes.json', import.meta.url), 'utf8'))
  assert.equal(reference.source.revision, '5a86e1d43ca49c434bd47f4a75d5b0aed0a19b0b')
  assert.deepEqual(palettes.map(({ name, ...palette }) => palette), reference.palettes)
  for (const palette of palettes) {
    const derived = tokens(palette)
    assert.equal(derived.border_focused, palette.accent)
    assert.equal(derived.text_accent, palette.accent2)
    assert.match(derived.element, new RegExp(` / ${palette.dark ? '0.05' : '0.035'}\\)`))
    for (const [role, opacity] of Object.entries({ element_hover: palette.dark ? 0.09 : 0.065, element_selected: palette.dark ? 0.18 : 0.13, ghost_hover: palette.dark ? 0.06 : 0.05, selection: 0.3, scrim: palette.dark ? 0.55 : 0.22, track: palette.dark ? 0.1 : 0.08 })) assert.ok(derived[role].endsWith(` / ${opacity})`), palette.id + ':' + role)
    for (const [index, role] of [[1, 'error'], [2, 'success'], [3, 'warning'], [4, 'info']]) assert.equal(derived[`ansi-${index}`], palette[role])
  }
  assert.equal(palettes.find(p => p.id === 'dusk').accent2, '#e8734a')
  assert.equal(palettes.find(p => p.id === 'dawn').accent2, '#c0501a')
  assert.equal(shiftLightness('#808080', 0.08), '#949494')
  assert.equal(shiftLightness('#808080', -0.06), '#717171')
  assert.equal(shiftLightness('#ff0000', 0.08), '#ff2929')
  assert.equal(tokens(palettes.find(p => p.id === 'nord')).accent_text, '#1c1f26')
  assert.match(tokens(palettes.find(p => p.id === 'macos-dark')).ui_font, /-apple-system/u)
})

test('appearance normalization, System resolution and opposite-kind selection preserve independent choices', () => {
  assert.deepEqual(appearance({ mode: 'bad', dark: 'paper', light: 'dusk' }), { mode: 'system', dark: 'dusk', light: 'dawn' })
  const preferences = { mode: 'system', dark: 'graphite', light: 'paper' }
  assert.equal(resolveTheme(preferences, true).id, 'graphite')
  assert.equal(resolveTheme(preferences, false).id, 'paper')
  assert.equal(selectTheme(preferences, 'nord', true).mode, 'system')
  assert.deepEqual(selectTheme(preferences, 'nord-light', true), { mode: 'light', dark: 'graphite', light: 'nord-light' })
})

test('web aliases require a foreground TTY and reject invalid launch combinations before unlocking', async () => {
  for (const argv of [['--web'], ['console'], ['--web', '--console-actions', '--web-port', '4317']]) await assert.rejects(runCli({ argv, input: { isTTY: false }, output: { isTTY: false } }), /requires a TTY/u)
  for (const argv of [['--web-port', '4317'], ['--console-actions'], ['--web', '--update'], ['--web', '--lab-tasks'], ['--web', '--web-port', '-1'], ['--web', '--web-port', '65536']]) await assert.rejects(runCli({ argv }), /require|cannot/u)
})

test('operation projections retain canonical approvals without exposing secret-shaped fields', async t => {
  const { workspace } = await fixture(t)
  const fingerprint = 'a'.repeat(64)
  workspace.perform = async () => ({ fingerprint, stateVersion: fingerprint + ':1:2', password: 'b'.repeat(64) })
  const accepted = workspace.submit({ action: 'prepare', requestKey: 'projection-request-01', hostId: 'host', request: 'Inspect fixture' })
  await workspace.pending.get(accepted.id).promise
  const result = workspace.operation(accepted.id).result
  assert.equal(result.fingerprint, fingerprint)
  assert.equal(result.stateVersion, fingerprint + ':1:2')
  assert.ok(!JSON.stringify(result).includes('b'.repeat(64)))
})

test('failed host inspection releases its session and permits a fresh connection', async () => {
  let opened = 0; let closed = 0
  const hosts = new OperatorHosts({
    settings: { servers: { host: {} } },
    settingsStore: { temporaryServerIds: [] },
    factory: {
      open: async () => {
        opened++
        return { session: { close: async () => { closed++ } }, admin: { capabilities: async () => { if (opened === 1) throw new Error('Disconnected'); return {} } }, stage2: { probe: async () => ({ status: 'inactive' }) } }
      }
    }
  })
  await assert.rejects(hosts.connect('host'), /connection failed/u)
  assert.equal(closed, 1)
  await hosts.connect('host')
  assert.equal(opened, 2)
  await hosts.close()
  assert.equal(closed, 2)
})

test('concurrent host leases wait for capability and readiness inspection', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let inspecting
  const started = new Promise(resolve => { inspecting = resolve })
  const hosts = new OperatorHosts({ settings: { servers: { host: {} } }, settingsStore: { temporaryServerIds: [] }, factory: { open: async () => ({ session: { close: async () => {} }, admin: { capabilities: async () => { inspecting(); await gate; return {} } }, stage2: { probe: async () => ({ status: 'inactive' }) } }) } })
  const first = hosts.lease('host')
  await started
  let ready = false
  const second = hosts.lease('host').then(value => { ready = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ready, false)
  release()
  const leases = await Promise.all([first, second])
  for (const lease of leases) await lease.close()
  await hosts.close()
})

test('staged controller continuation halts after canary failure and skips completed hosts', async t => {
  const { workspace, controller, tasks, admin, calls } = await fixture(t)
  const accepted = workspace.submit({ action: 'prepare', requestKey: 'canary-prepare-001', serverIds: ['host', 'other'], request: 'Inspect both' })
  await workspace.pending.get(accepted.id).promise
  const run = controller.runs.list()[0]
  const decisions = run.hosts.map(host => { const view = controller.inspect(host.serverId, host.taskId); return { hostId: host.serverId, taskId: host.taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint } })
  admin.netdata = () => ({ runCommand: async () => { calls.push('failed canary'); return { exitCode: 1, stdout: '', stderr: 'failure' } } })
  await workspace.resumeRun({ runId: run.id, decisions, rollout: { canaryHost: 'host', batchSize: 1 } })
  assert.equal(calls.length, 1)
  assert.equal(tasks.get('other', 1).status, 'planned')
  controller.runs.updateHost(run.id, 'host', { status: 'completed' })
  await workspace.resumeRun({ runId: run.id, decisions: [decisions[0]] })
  assert.equal(calls.length, 1)
})

test('profile preferences survive new instances and reject stale or privileged writes', async t => {
  const { root } = await fixture(t)
  const store = new UiPreferences(root)
  let version = 0
  for (const theme of palettes) {
    const value = store.save(version++, { appearance: selectTheme(store.get().value.appearance, theme.id, true) })
    assert.equal(resolveTheme(new UiPreferences(root).get().value.appearance, true).id, theme.id)
    assert.equal(value.version, version)
  }
  assert.throws(() => store.save(0, { favorites: [] }), /Stale/u)
  assert.throws(() => store.save(version, { actionKey: 'secret' }), /Invalid/u)
  assert.throws(() => store.save(version, { panes: [{ hostId: '../escape', taskId: 1 }] }), /Invalid/u)
})

test('catalog refresh is an idempotent proposal operation and never implicitly executes', async t => {
  const { workspace, controller, calls } = await fixture(t)
  let proposals = 0
  controller.proposeCatalogRefresh = async (hostId, taskId, version) => {
    assert.deepEqual([hostId, taskId, version], ['host', 1, 'current-version'])
    proposals++
    return { revisionId: 2, fingerprint: 'a'.repeat(64) }
  }
  const request = { action: 'refresh-catalog', requestKey: 'catalog-refresh-0001', hostId: 'host', taskId: 1, expectedVersion: 'current-version' }
  const accepted = workspace.submit(request)
  assert.equal(workspace.submit(request).id, accepted.id)
  await workspace.pending.get(accepted.id).promise
  assert.equal(proposals, 1)
  assert.deepEqual(calls, [])
})

test('browser preparation is durable, idempotent and distinct from explicit canonical execution', async t => {
  const { workspace, controller, tasks, calls } = await fixture(t)
  const request = { action: 'prepare', requestKey: 'prepare-request-0001', hostId: 'host', request: 'Inspect fixture' }
  const accepted = workspace.submit(request)
  assert.equal(workspace.submit(request).id, accepted.id)
  assert.throws(() => workspace.submit({ ...request, request: 'different work' }), /different work/u)
  await workspace.pending.get(accepted.id).promise
  assert.equal(tasks.list('host').length, 1)
  assert.equal(tasks.get('host', 1).status, 'planned')
  assert.deepEqual(calls, [])
  const view = controller.inspect('host', 1)
  assert.throws(() => workspace.submit({ action: 'execute', requestKey: 'execute-request-001', hostId: 'host', taskId: 1, expectedVersion: view.stateVersion, fingerprint: view.fingerprint }), /approval/u)
  const invalid = workspace.submit({ action: 'execute', requestKey: 'execute-request-002', hostId: 'host', taskId: 1, expectedVersion: view.stateVersion, fingerprint: 'a'.repeat(64), approved: true })
  await workspace.pending.get(invalid.id).promise
  assert.equal(workspace.operations().find(o => o.id === invalid.id).status, 'failed')
  assert.deepEqual(calls, [])
  const valid = workspace.submit({ action: 'execute', requestKey: 'execute-request-003', hostId: 'host', taskId: 1, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true })
  await workspace.pending.get(valid.id).promise
  assert.deepEqual(calls, ['printf fixture'])
  assert.equal(tasks.get('host', 1).status, 'completed')
  assert.equal(workspace.submit({ action: 'execute', requestKey: 'execute-request-003', hostId: 'host', taskId: 1, expectedVersion: view.stateVersion, fingerprint: view.fingerprint, approved: true }).id, valid.id)
  assert.equal(tasks.allExecutionEvents('host', 1).filter(e => e.type === 'command_dispatched').length, 1)
})

test('multi-host preparation waits durably for separate per-host decisions', async t => {
  const { workspace, tasks, calls, controller } = await fixture(t)
  const accepted = workspace.submit({ action: 'prepare', requestKey: 'multi-prepare-0001', serverIds: ['host', 'other'], request: 'Inspect both' })
  await workspace.pending.get(accepted.id).promise
  const run = controller.runs.list()[0]
  assert.equal(run.status, 'planned')
  assert.ok(run.hosts.every(h => h.status === 'planned'))
  assert.deepEqual(calls, [])
  assert.equal(tasks.get('host', 1).status, 'planned')
  await assert.rejects(workspace.resumeRun({ runId: run.id, decisions: [{ hostId: 'host', taskId: 2, expectedVersion: 'bad' }] }), /Wrong/u)
  const view = controller.inspect('host', 1)
  await assert.rejects(controller.resume('other', 1, view.stateVersion, view.fingerprint), /stale/u)
  assert.deepEqual(calls, [])
  await workspace.resumeRun({ runId: run.id, decisions: [{ hostId: 'host', taskId: 1, expectedVersion: view.stateVersion, fingerprint: view.fingerprint }], rollout: { batchSize: 1 } })
  assert.equal(calls.length, 1)
  assert.equal(tasks.get('other', 1).status, 'planned')
})

test('host mutation ownership excludes concurrent operators but allows unrelated hosts and nested calls', async t => {
  const { root } = await fixture(t)
  let release
  const running = withHostMutation({ dataRoot: root, identity: 'same' }, () => new Promise(resolve => { release = resolve }))
  await assert.rejects(withHostMutation({ dataRoot: root, identity: 'same' }, async () => {}), /Another operator/u)
  await withHostMutation({ dataRoot: root, identity: 'other' }, async () => {})
  release(); await running
  await withHostMutation({ dataRoot: root, identity: 'same' }, () => withHostMutation({ dataRoot: root, identity: 'same' }, async () => {}))
})

test('host ownership excludes a separate CLI process and is released when that process exits', async t => {
  const { root } = await fixture(t)
  const module = pathToFileURL(path.resolve('src/host-mutation-ownership.js')).href
  const code = `import {withHostMutation} from ${JSON.stringify(module)};await withHostMutation({dataRoot:${JSON.stringify(root)},identity:'cross-process'},()=>new Promise(resolve=>{console.log('owned');process.stdin.once('data',resolve)}))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  const ended = new Promise(resolve => child.once('exit', resolve))
  t.after(() => { if (child.exitCode === null) child.kill() })
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error('Child ownership failed')) }) })
  await assert.rejects(withHostMutation({ dataRoot: root, identity: 'cross-process' }, async () => {}), /Another operator/u)
  child.stdin.end('finish')
  assert.equal(await ended, 0)
  await withHostMutation({ dataRoot: root, identity: 'cross-process' }, async () => {})
})

test('stale host configuration approvals cannot reach lifecycle actions', async t => {
  const { workspace, controller } = await fixture(t)
  let called = false
  workspace.hosts.action = async () => { called = true }
  await assert.rejects(workspace.perform({ action: 'stage2-activate', hostId: 'host', hostVersion: 'stale' }), /settings changed/u)
  assert.equal(called, false)
  assert.equal(controller.snapshot().hosts[0].hostVersion.length, 64)
})

test('shutdown rejects new actions and waits for accepted work without replay', async t => {
  const { workspace } = await fixture(t)
  let release
  let finished = false
  workspace.perform = async () => { await new Promise(resolve => { release = resolve }); finished = true; return {} }
  const accepted = workspace.submit({ action: 'prepare', requestKey: 'shutdown-request-01', hostId: 'host', request: 'Fixture' })
  await new Promise(resolve => setImmediate(resolve))
  const closing = workspace.close()
  assert.throws(() => workspace.submit({ action: 'prepare', requestKey: 'shutdown-request-02' }), /shutting down/u)
  assert.equal(finished, false)
  release(); await closing
  assert.equal(workspace.operations().find(o => o.id === accepted.id).status, 'completed')
})

test('host sessions deduplicate connection attempts and serialize terminal authentication', async () => {
  let opened = 0; let prompts = 0; let max = 0; let closed = 0
  const hosts = new OperatorHosts({
    settings: { servers: { first: {}, second: {} } },
    settingsStore: { temporaryServerIds: [] },
    factory: {
      open: async () => {
        opened++; prompts++; max = Math.max(max, prompts)
        await new Promise(resolve => setTimeout(resolve, 10)); prompts--
        return { admin: { capabilities: async () => ({ platform: { os: 'linux' } }) }, stage2: { probe: async () => ({ status: 'inactive' }) }, session: { close: async () => { closed++ } } }
      }
    }
  })
  const [first, second, other] = await Promise.all([hosts.lease('first'), hosts.lease('first'), hosts.lease('second')])
  assert.equal(opened, 2); assert.equal(max, 1)
  await first.close()
  await assert.rejects(hosts.disconnect('first'), /active work/u)
  await second.close(); await other.close(); await hosts.close()
  assert.equal(closed, 2)
})

test('FreeBSD RAM uses Netdata in-use categories and refuses incomplete or ambiguous gauges', () => {
  const labels = ['time', 'free', 'active', 'inactive', 'wired', 'cache', 'laundry', 'buffers']
  const row = [Math.floor(Date.now() / 1000), 20, 20, 30, 10, 10, 5, 5]
  const metric = normalizeMetrics('system.ram', { units: 'MiB' }, { result: { labels, data: [row] } })
  assert.equal(metric.percentage, 40)
  assert.match(metric.aggregation, /FreeBSD RAM in use/u)
  for (const [names, values] of [[labels.slice(0, -1), row.slice(0, -1)], [labels, [...row.slice(0, -1), null]], [labels, [...row.slice(0, -1), -1]], [[...labels, 'active'], [...row, 5]], [labels.map(name => name === 'laundry' ? 'unknown' : name), row]]) {
    assert.equal(normalizeMetrics('system.ram', { units: 'MiB' }, { result: { labels: names, data: [values] } }).percentage, null)
  }
})

test('normalized metrics retain source, units, missing evidence and shared bounded sampling', async t => {
  const { controller } = await fixture(t)
  const at = Math.floor(Date.now() / 1000)
  const cpu = normalizeMetrics('system.cpu', { units: '%' }, { result: { labels: ['time', 'user', 'system'], data: [[at, 10, 20]] } })
  assert.equal(cpu.percentage, 30)
  assert.equal(normalizeMetrics('system.cpu', { units: 'unknown' }, { result: { labels: ['time', 'user'], data: [[at, 30]] } }).percentage, null)
  assert.equal(normalizeMetrics('system.ram', { units: 'MiB' }, { result: { labels: ['time', 'used', 'free'], data: [[at, 40, 60]] } }).percentage, 40)
  assert.equal(normalizeMetrics('disk.space', {}, {}).state, 'unavailable')
  let queries = 0
  controller.withAdmin = async (_host, op) => op({ serverSecrets: async () => ({}), netdata: () => ({ info: async () => ({ agents: [{ ai: 0, mg: '12345678-1234-1234-1234-123456789abc' }] }), contexts: async () => ({ contexts: { 'system.cpu': { units: '%' } } }), getJson: async url => { assert.match(url, /scope_nodes=12345678-1234-1234-1234-123456789abc/u); queries++; return { result: { labels: ['time', 'user'], data: [[at, 20]] } } } }) })
  const metrics = new OperatorMetrics(controller)
  const results = await Promise.all([metrics.get('host'), metrics.get('host'), metrics.get('host')])
  assert.equal(queries, 1); assert.deepEqual(results[0], results[2])
  assert.equal(results[0].values.filter(v => v.state === 'unavailable').length, 2)
  metrics.close()
})

test('read-only UI preferences and session restoration retain CSRF and instance isolation', async t => {
  const { controller, workspace } = await fixture(t)
  const first = await startOperatorConsole({ controller, workspace, actions: false })
  t.after(() => first.close())
  await assert.rejects(startOperatorConsole({ controller, port: Number(new URL(first.origin).port) }), /already occupied/u)
  const login = await fetch(first.origin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(first.url).hash.slice(1) }) })
  const session = await login.json()
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const headers = { Cookie: cookie, Origin: first.origin, 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }
  assert.equal((await (await fetch(first.origin + '/session', { headers })).json()).csrf, session.csrf)
  const value = { version: 0, patch: { appearance: { mode: 'dark', dark: 'nord', light: 'dawn' } } }
  assert.equal((await fetch(first.origin + '/preferences', { method: 'POST', headers, body: JSON.stringify(value) })).status, 200)
  assert.equal((await fetch(first.origin + '/preferences', { method: 'POST', headers: { ...headers, 'X-Intent-CSRF': '' }, body: JSON.stringify(value) })).status, 403)
  assert.equal((await fetch(first.origin + '/operation', { method: 'POST', headers, body: JSON.stringify({ action: 'prepare', requestKey: 'readonly-prepare-01', hostId: 'host', request: 'Inspect' }) })).status, 403)
  assert.equal((await fetch(first.origin + '/preferences', { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403)
  const task = controller.tasks.create('host', 'Inspect paginated fixture')
  for (let i = 0; i < 25; i++) controller.tasks.appendResult('host', task.id, { id: 'result-' + i, status: 'completed', result: { exitCode: 0, stdout: 'private-output-marker', stderr: 'private-error-marker' } })
  const results = await (await fetch(first.origin + `/task-results?host=host&task=${task.id}`, { headers })).json()
  assert.equal(results.items.length, 20)
  assert.equal(results.nextCursor, 20)
  assert.ok(!JSON.stringify(results).includes('private-output-marker'))
  assert.ok(!JSON.stringify(results).includes('private-error-marker'))
  assert.throws(() => new OperatorWorkspace({ controller }), /already owns/u)
  const second = await startOperatorConsole({ controller, actions: false })
  t.after(() => second.close())
  assert.equal((await fetch(second.origin + '/session', { headers: { Cookie: cookie } })).status, 401)
})
