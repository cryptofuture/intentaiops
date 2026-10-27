import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OperatorShells } from '../src/operator-shells.js'
import { SystemSsh } from '../src/system-ssh.js'
import { withHostMutation } from '../src/host-mutation-ownership.js'
import { planFingerprint } from '../src/execution-journal.js'
import { OperatorController } from '../src/operator-controller.js'
import { OperatorWorkspace } from '../src/operator-workspace.js'
import { startOperatorConsole } from '../src/operator-console.js'

async function fixture (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-shell-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = { servers: { host: { historyId: 'host' } } }
  const writes = []; const sizes = []; const launches = []
  let output; let exit; let leases = 0
  let kills = 0
  const hosts = {
    states: new Map(),
    sessions: new Map([['host', { server: { connectionUrl: 'ssh://operator@example.invalid' }, ssh: new SystemSsh({ terminalCheck: () => false, controlPath: '/owned/control' }) }]]),
    configure: (_id, operation) => withHostMutation({ dataRoot: root, identity: 'host' }, operation),
    terminal: async (_id, operation) => operation(),
    lease: async () => { leases++; return { close: async () => { leases-- } } },
    close: async () => {}
  }
  const shells = new OperatorShells({
    hosts,
    settings,
    spawn: (binary, args, options) => {
      launches.push({ binary, args, options })
      return { onData: listener => { output = listener }, onExit: listener => { exit = listener }, write: value => writes.push(value), resize: (cols, rows) => sizes.push([cols, rows]), kill: () => { kills++; exit({ exitCode: 0 }) } }
    }
  })
  t.after(() => shells.close())
  const body = { action: 'open', hostId: 'host', hostVersion: planFingerprint(settings.servers.host), requestKey: 'shell-test-request-01', approved: true, cols: 80, rows: 24 }
  return { root, settings, hosts, shells, body, writes, sizes, launches, output: data => output(data), exit: code => exit({ exitCode: code }), leases: () => leases, kills: () => kills }
}

test('Windows natural terminal exit releases ConPTY once without replacing its original status', async t => {
  const f = await fixture(t)
  const shell = await f.shells.open(f.body)
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    f.exit(7)
    await f.shells.get(shell.id).done
    assert.equal(f.kills(), 1)
    assert.equal(f.shells.get(shell.id).exitCode, 7)
    assert.equal(f.leases(), 0)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

test('browser SSH uses strict system OpenSSH, owns the host and never duplicates input or session creation', async t => {
  const f = await fixture(t)
  await assert.rejects(f.shells.open({ ...f.body, approved: false }), /approval/u)
  await assert.rejects(f.shells.open({ ...f.body, hostVersion: 'stale' }), /settings changed/u)
  const shell = await f.shells.open(f.body)
  assert.equal((await f.shells.open(f.body)).id, shell.id)
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0].binary, 'ssh')
  assert.ok(f.launches[0].args.includes('StrictHostKeyChecking=yes'))
  assert.ok(f.launches[0].args.includes('BatchMode=yes'))
  for (const option of ['EscapeChar=none', 'PermitLocalCommand=no', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes']) assert.ok(f.launches[0].args.includes(option))
  assert.ok(f.launches[0].args.includes('ControlPath=/owned/control'))
  assert.equal(f.launches[0].options.env.VAULT_TEST, undefined)
  assert.equal(f.leases(), 1)
  await assert.rejects(withHostMutation({ dataRoot: f.root, identity: 'host' }, async () => {}), /Another operator/u)
  await assert.rejects(f.shells.open({ ...f.body, requestKey: 'shell-test-request-02' }), /already has/u)
  const input = { id: shell.id, sequence: 1, data: 'uptime\r' }
  f.shells.input(input); f.shells.input(input)
  assert.deepEqual(f.writes, ['uptime\r'])
  assert.throws(() => f.shells.input({ ...input, data: 'different\r' }), /conflict/u)
  assert.throws(() => f.shells.input({ ...input, sequence: 3 }), /conflict/u)
  f.shells.resize({ id: shell.id, cols: 100, rows: 35 })
  assert.deepEqual(f.sizes, [[100, 35]])
  await f.shells.end(shell.id)
  assert.equal(f.leases(), 0)
  await withHostMutation({ dataRoot: f.root, identity: 'host' }, async () => {})
})

test('private terminal output has bounded reconnectable history and is not persisted as task history', async t => {
  const f = await fixture(t)
  const shell = await f.shells.open(f.body)
  f.output('PRIVATE_TERMINAL_MARKER')
  assert.equal(f.shells.events(shell.id, 0).events[0].data, 'PRIVATE_TERMINAL_MARKER')
  for (let i = 0; i < 100; i++) f.output('x'.repeat(16000))
  assert.equal(f.shells.events(shell.id, 0).gap, true)
  assert.ok(f.shells.get(shell.id).bytes <= 512 * 1024)
  assert.ok(f.shells.events(shell.id, 0).events.length <= 32)
  assert.ok(!JSON.stringify(f.shells.list()).includes('PRIVATE_TERMINAL_MARKER'))
  assert.throws(() => f.shells.resize({ id: shell.id, cols: 10000, rows: 24 }), /size/u)
  await f.shells.close()
  assert.equal(f.leases(), 0)
  await assert.rejects(f.shells.open(f.body), /shutting down/u)
})

test('SSH disconnect ends observation without replaying input or opening a replacement channel', async t => {
  const f = await fixture(t)
  const shell = await f.shells.open(f.body)
  f.shells.input({ id: shell.id, sequence: 1, data: 'uptime\r' })
  f.exit(255)
  await f.shells.get(shell.id).done
  assert.equal(f.shells.get(shell.id).status, 'closed')
  assert.equal(f.launches.length, 1)
  assert.deepEqual(f.writes, ['uptime\r'])
  assert.equal(f.leases(), 0)
  const events = f.shells.events(shell.id, 0).events
  assert.equal(events.at(-1).type, 'closed')
  assert.equal(events.at(-1).exitCode, 255)
})

test('shell HTTP routes require actions mode, authenticated cookies and CSRF', async t => {
  const f = await fixture(t)
  const controller = new OperatorController({ dataRoot: f.root, settings: f.settings })
  const workspace = new OperatorWorkspace({ controller, hosts: f.hosts })
  workspace.shells = f.shells
  const server = await startOperatorConsole({ controller, workspace, actions: true })
  t.after(() => server.close())
  assert.equal((await fetch(server.origin + '/shells')).status, 401)
  const login = await fetch(server.origin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
  const session = await login.json()
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Intent-CSRF': session.csrf }
  assert.equal((await fetch(server.origin + '/shell', { method: 'POST', headers: { ...headers, 'X-Intent-CSRF': '' }, body: JSON.stringify(f.body) })).status, 403)
  assert.equal((await fetch(server.origin + '/shell', { method: 'POST', headers, body: JSON.stringify({ ...f.body, command: 'unauthorized endpoint' }) })).status, 409)
  const opened = await fetch(server.origin + '/shell', { method: 'POST', headers, body: JSON.stringify(f.body) })
  assert.equal(opened.status, 200)
  const shell = await opened.json()
  f.output('PRIVATE_TERMINAL_MARKER')
  assert.ok(!JSON.stringify(controller.snapshot()).includes('PRIVATE_TERMINAL_MARKER'))
  const subscription = await fetch(server.origin + '/shell-events?id=' + shell.id, { headers })
  const reader = subscription.body.getReader()
  const value = await reader.read()
  assert.match(new TextDecoder().decode(value.value), /PRIVATE_TERMINAL_MARKER/u)
  await reader.cancel()
  const readonly = await startOperatorConsole({ controller, actions: false, workspace })
  const login2 = await fetch(readonly.origin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(readonly.url).hash.slice(1) }) })
  assert.equal((await fetch(readonly.origin + '/shells', { headers: { Cookie: login2.headers.get('set-cookie').split(';')[0] } })).status, 403)
  await readonly.close()
})
