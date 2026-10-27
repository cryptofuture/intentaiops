import assert from 'node:assert/strict'
import test from 'node:test'
import { SshSessionManager, normalizeSshTransport } from '../src/ssh-session-manager.js'

function fixture (t) {
  const sessions = []
  const diagnostics = []
  const ssh = {
    transport: normalizeSshTransport(),
    attempts: 0,
    failures: 0,
    connectionIdentity: async url => url,
    async openInteractiveSession (url, options) {
      this.attempts++
      if (this.opening) await this.opening
      if (this.failures-- > 0) throw new Error('authentication failed')
      const session = {
        closed: false,
        multiplexed: true,
        checks: 0,
        reconnects: 0,
        closes: 0,
        async check () { this.checks++; return this.healthy !== false },
        async reconnect () { this.reconnects++; this.healthy = true },
        async close () { this.closed = true; this.closes++ },
        ssh: { execute: async () => { options.onDiagnostic({ type: 'channel', kind: 'ssh' }); if (ssh.command) await ssh.command; return { code: 0 } }, copy: async () => ({ code: 0 }) }
      }
      sessions.push(session)
      options.onDiagnostic({ type: 'master-established', durationMs: 2 })
      return session
    }
  }
  const manager = new SshSessionManager({ ssh, onDiagnostic: event => diagnostics.push(event) })
  t.after(() => manager.close())
  return { ssh, manager, sessions, diagnostics }
}

test('sequential and concurrent leases reuse one master and preserve active ownership', async t => {
  const { ssh, manager, sessions } = fixture(t)
  let established
  ssh.opening = new Promise(resolve => { established = resolve })
  const first = manager.acquire('ssh://host')
  const second = manager.acquire('ssh://host')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ssh.attempts, 1)
  established()
  const [a, b] = await Promise.all([first, second])
  await Promise.all([a.ssh.execute('ssh://host', 'true'), b.ssh.execute('ssh://host', 'true')])
  await a.close()
  assert.equal(sessions[0].closes, 0)
  await b.ssh.copy('ssh://host', 'local', 'remote')
  await b.close()
  const c = await manager.acquire('ssh://host')
  assert.equal(ssh.attempts, 1)
  assert.equal(sessions[0].checks, 1)
  assert.equal(manager.diagnostics().channels, 2)
  await c.close()
  assert.equal(manager.diagnostics().idleMasters, 1)
})

test('hosts, identities, credentials, authentication and compression cannot share incompatible masters', async t => {
  const { ssh, manager, diagnostics } = fixture(t)
  const requests = [
    ['ssh://a', {}], ['ssh://b', {}], ['ssh://a?identity=/key', {}],
    ['ssh://a', { credential: 'secret-one' }], ['ssh://a', { credential: 'secret-two' }],
    ['ssh://a', { authentication: 'key' }], ['ssh://a', { transport: { compression: true } }]
  ]
  const leases = await Promise.all(requests.map(([url, options]) => manager.acquire(url, options)))
  assert.equal(ssh.attempts, requests.length)
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-one|secret-two/u)
  assert.ok([...manager.entries.keys()].every(key => /^[a-f0-9]{64}$/u.test(key)))
  await Promise.all(leases.map(lease => lease.close()))
})

test('a failed opening is not cached and unrelated hosts remain independent', async t => {
  const { ssh, manager } = fixture(t)
  ssh.failures = 1
  await assert.rejects(manager.acquire('ssh://a'), /authentication failed/u)
  const leases = await Promise.all([manager.acquire('ssh://a'), manager.acquire('ssh://b')])
  assert.equal(ssh.attempts, 3)
  await Promise.all(leases.map(lease => lease.close()))
})

test('idle masters expire and closed sessions are recreated', async t => {
  const { ssh, manager, sessions } = fixture(t)
  const lease = await manager.acquire('ssh://host', { transport: { idleTimeoutSeconds: 1 } })
  await lease.close()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(sessions[0].closes, 1)
  const next = await manager.acquire('ssh://host', { transport: { idleTimeoutSeconds: 1 } })
  sessions[1].closed = true
  const recreated = await manager.acquire('ssh://host', { transport: { idleTimeoutSeconds: 1 } })
  assert.equal(ssh.attempts, 3)
  await next.close()
  await recreated.close()
})

test('unusable idle masters reconnect before new work and concurrent health checks coalesce', async t => {
  const { manager, sessions } = fixture(t)
  const first = await manager.acquire('ssh://host')
  await first.close()
  sessions[0].healthy = false
  const leases = await Promise.all([manager.acquire('ssh://host'), manager.acquire('ssh://host')])
  assert.equal(sessions[0].checks, 1)
  assert.equal(sessions[0].reconnects, 1)
  await Promise.all(leases.map(lease => lease.close()))
})

test('releasing a lease and application shutdown wait for its active channels', async t => {
  const { ssh, manager, sessions } = fixture(t)
  const lease = await manager.acquire('ssh://host')
  let finish
  ssh.command = new Promise(resolve => { finish = resolve })
  const command = lease.ssh.execute('ssh://host', 'true')
  const released = lease.close()
  const shutdown = manager.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sessions[0].closes, 0)
  finish()
  await Promise.all([command, released, shutdown])
  assert.equal(sessions[0].closes, 1)
  await assert.rejects(lease.ssh.execute('ssh://host', 'true'), /lease is closed/u)
})

test('shutdown during establishment closes the eventual session and rejects waiting leases', async t => {
  const { ssh, manager, sessions } = fixture(t)
  let finish
  ssh.opening = new Promise(resolve => { finish = resolve })
  const opening = manager.acquire('ssh://host')
  const rejected = assert.rejects(opening, /manager is closed/u)
  await new Promise(resolve => setImmediate(resolve))
  const shutdown = manager.close()
  finish()
  await Promise.all([rejected, shutdown])
  assert.equal(sessions[0].closes, 1)
  assert.equal(manager.entries.size, 0)
})

test('cancelled waiters do not cancel another compatible lease or retain rejected state', async t => {
  const { ssh, manager } = fixture(t)
  let finish
  ssh.opening = new Promise(resolve => { finish = resolve })
  const abort = new AbortController()
  const cancelled = manager.acquire('ssh://host', { signal: abort.signal })
  const rejected = assert.rejects(cancelled, /cancelled/u)
  const waiting = manager.acquire('ssh://host')
  await new Promise(resolve => setImmediate(resolve))
  abort.abort(new Error('cancelled'))
  finish()
  await rejected
  const lease = await waiting
  assert.equal(ssh.attempts, 1)
  await lease.close()
})

test('unknown compatibility and nonmultiplexed sessions are not retained', async t => {
  const { ssh, manager, sessions } = fixture(t)
  ssh.connectionIdentity = async () => null
  const a = await manager.acquire('ssh://host')
  const b = await manager.acquire('ssh://host')
  assert.equal(ssh.attempts, 2)
  await a.close(); await b.close()
  assert.equal(sessions[0].closes, 1)
  assert.equal(manager.entries.size, 0)
  ssh.connectionIdentity = async url => url
  const originalOpen = ssh.openInteractiveSession.bind(ssh)
  ssh.openInteractiveSession = async (...args) => {
    const session = await originalOpen(...args)
    session.multiplexed = false
    return session
  }
  const direct = await manager.acquire('ssh://host')
  await direct.close()
  assert.equal(manager.entries.size, 0)
  assert.equal(sessions[2].closes, 1)
})
