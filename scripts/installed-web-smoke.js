export function installedWebSmoke (packageRoot, databaseRoot) {
  return String.raw`
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = ${JSON.stringify(packageRoot)}
const { recoveryBaselineCommand } = await import(pathToFileURL(path.join(root, 'src/remote-recovery-baseline.js')).href)
assert.match(recoveryBaselineCommand('intent-ai-ops-windows', 1), /IntentCliRecoveryFile/)
if (process.platform === 'win32') {
  const native = spawnSync(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(nativeWindowsPtySmoke(packageRoot))}], { encoding: 'utf8', timeout: 20000 })
  assert.equal(native.status, 0, 'Native Windows ConPTY smoke failed: ' + (native.error?.code ?? '') + '\n' + native.stdout + native.stderr)
}
const { startOperatorConsole } = await import(pathToFileURL(path.join(root, 'src/operator-console.js')).href)
const { OperatorController } = await import(pathToFileURL(path.join(root, 'src/operator-controller.js')).href)
const controller = new OperatorController({ dataRoot: ${JSON.stringify(databaseRoot)}, settings: { servers: {}, clusters: {} } })
const server = await startOperatorConsole({ controller })
try {
  const response = await fetch(server.url)
  const html = await response.text()
  assert.match(html, /Intent AI Ops Workspace/)
  const script = /src="([^"]+\.js)"/.exec(html)?.[1]
  assert.ok(script)
  assert.equal((await fetch(server.origin + script)).status, 200)
  assert.match(response.headers.get('content-security-policy'), /wasm-unsafe-eval/)
  const engine = readdirSync(path.join(root, 'src/operator-web/assets')).find(name => name.endsWith('.wasm'))
  assert.ok(engine)
  const wasm = await fetch(server.origin + '/assets/' + engine)
  assert.equal(wasm.status, 200)
  assert.equal(wasm.headers.get('content-type'), 'application/wasm')
  assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer()).slice(0, 4)], [0, 97, 115, 109])
  assert.equal((await fetch(server.origin + '/fonts/geist-400.ttf')).status, 200)
  assert.match(await (await fetch(server.origin + '/licenses/OFL.txt')).text(), /SIL OPEN FONT LICENSE/i)
  const session = await fetch(server.origin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(server.url).hash.slice(1) }) })
  assert.equal(session.status, 200)
} finally { await server.close() }
`
}

export function nativeWindowsPtySmoke (packageRoot) {
  return String.raw`
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = ${JSON.stringify(packageRoot)}
  const { OperatorShells } = await import(pathToFileURL(path.join(root, 'src/operator-shells.js')).href)
  const { planFingerprint } = await import(pathToFileURL(path.join(root, 'src/execution-journal.js')).href)
  const require = createRequire(path.join(root, 'package.json'))
  const pty = require('node-pty')
  console.log('NATIVE_PTY_START')
  const settings = { servers: { native: { historyId: 'native' } } }
  const hosts = {
    configure: (_id, operation) => operation(),
    terminal: (_id, operation) => operation(),
    lease: async () => ({ close: async () => {} }),
    sessions: new Map([['native', { server: { connectionUrl: 'ssh://fixture.invalid' }, ssh: {
      interactiveShell: (_url, { runner }) => runner(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/q'])
    } }]])
  }
  const shells = new OperatorShells({ hosts, settings, spawn: pty.spawn })
  try {
    const shell = await shells.open({ hostId: 'native', hostVersion: planFingerprint(settings.servers.native), requestKey: 'native-windows-pty-smoke', approved: true, cols: 80, rows: 24 })
    console.log('NATIVE_PTY_SPAWNED')
    shells.resize({ id: shell.id, cols: 100, rows: 35 })
    const input = { id: shell.id, sequence: 1, data: 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::WriteLine((\'NATIVE_\'+\'PTY_OK\'));[Console]::WriteLine((\'SIZE_\'+[Console]::WindowWidth+\'x\'+[Console]::WindowHeight))"\r' }
    shells.input(input); shells.input(input)
    const deadline = Date.now() + 10000
    for (;;) {
      const output = shells.events(shell.id, 0).events.map(event => event.data ?? '').join('')
      if (output.includes('NATIVE_PTY_OK') && output.includes('SIZE_100x35')) break
      if (Date.now() >= deadline) throw new Error('Native Windows ConPTY output/resize failed')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    shells.input({ id: shell.id, sequence: 2, data: 'exit\r' })
    await shells.get(shell.id).done
    if (shells.get(shell.id).exitCode !== 0 || shells.get(shell.id).status !== 'closed') throw new Error('Native Windows ConPTY exit failed')
    console.log('NATIVE_PTY_EXITED')
  } finally { await shells.close() }
  console.log('NATIVE_PTY_OK')
`
}
