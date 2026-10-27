import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const hostId = process.env.INTENT_WEB_HOST
const dataRoot = process.env.INTENT_WEB_DATA_ROOT
if (!hostId || !dataRoot || !process.env.VAULT_TEST || !existsSync(path.join(dataRoot, 'settings.json'))) throw new Error('Opt in with INTENT_WEB_HOST, existing INTENT_WEB_DATA_ROOT and VAULT_TEST')
if (!/^[a-z0-9_-]{1,128}$/u.test(hostId)) throw new Error('Invalid host identifier')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const child = spawn('script', ['-qefc', `${quote(process.execPath)} ${quote(path.resolve('bin/intentaiops.js'))} --web --no-debug --data-root ${quote(path.resolve(dataRoot))}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
let sent = false
let buffer = ''
let stopping = false
const deadline = setTimeout(() => { child.kill('SIGTERM') }, 120000)
try {
  const launch = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Read-only CLI ended before startup completed; inspect the launch environment')))
    child.stdout.on('data', chunk => {
      buffer = (buffer + chunk.toString()).slice(-16384)
      if (!sent && buffer.includes('Vault passphrase:')) { sent = true; child.stdin.write(process.env.VAULT_TEST + '\r') }
      const match = /http:\/\/127\.0\.0\.1:\d+\/workspace\/[a-f0-9]+\/#([a-f0-9]{64})/u.exec(buffer)
      if (match && !stopping) resolve(new URL(match[0]))
    })
  })
  const login = await fetch(new URL('session', launch), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch.hash.slice(1) }) })
  if (!login.ok) throw new Error('Session exchange failed')
  const session = await login.json()
  if (session.actions !== false) throw new Error('Expected read-only launch')
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] }
  const get = async route => { const response = await fetch(new URL(route, launch), { headers, signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error('Read-only observation failed'); return response.json() }
  const snapshot = await get('workspace')
  if (!snapshot.hosts.some(host => host.id === hostId)) throw new Error('Selected host is not configured')
  const metrics = await get('metrics?host=' + encodeURIComponent(hostId))
  const inventory = await get('inventory?host=' + encodeURIComponent(hostId))
  process.stdout.write(JSON.stringify({ hostId, actions: session.actions, hostCount: snapshot.hosts.length, metrics, infoKeys: Object.keys(inventory.info ?? {}), infoAgentKeys: Object.keys(inventory.info?.agents?.[0] ?? {}) }) + '\n')
} finally {
  stopping = true
  clearTimeout(deadline)
  child.stdin.write('\u0003')
  await new Promise(resolve => { if (child.exitCode !== null) return resolve(); const timeout = setTimeout(() => child.kill('SIGTERM'), 10000); child.once('exit', () => { clearTimeout(timeout); resolve() }) })
}
