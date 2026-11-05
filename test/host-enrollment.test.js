import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, mkdir, chmod, lstat, rm, symlink, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hostIdentityFingerprint, hostEnrollmentRequest, readHostEnrollment, replaceHostEnrollment } from '../src/host-enrollment.js'
import { prepareHostIdentity } from '../src/host-identity-setup.js'
import { SystemSsh } from '../src/system-ssh.js'
import { OperatorHosts } from '../src/operator-hosts.js'
import { runProcess } from '../src/process-runner.js'

const nativeUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test('enrollment fingerprints preserve legacy identity and separate clones without changing native IDs', () => {
  for (const platform of ['linux', 'freebsd', 'macos', 'windows']) {
    const native = `${platform}:${nativeUuid}`
    assert.equal(hostIdentityFingerprint(native), `SHA256:${createHash('sha256').update(native).digest('hex')}`)
    if (['macos', 'windows'].includes(platform)) {
      assert.notEqual(hostIdentityFingerprint(native, id), hostIdentityFingerprint(native))
      assert.notEqual(hostIdentityFingerprint(native, id), hostIdentityFingerprint(native, next))
      assert.notEqual(hostIdentityFingerprint(native, id), hostIdentityFingerprint(`${platform}:${next}`, id))
    } else assert.throws(() => hostIdentityFingerprint(native, id))
  }
  for (const value of ['', 'invalid', '00000000-0000-0000-0000-000000000000', 'X'.repeat(1000)]) assert.throws(() => hostIdentityFingerprint(`macos:${nativeUuid}`, value))
})

test('read-only enrollment lookup never falls back after malformed, denied or unsafe evidence', async () => {
  for (const platform of ['macos', 'windows']) {
    const ssh = { execute: async () => ({ stdout: 'MISSING\n' }) }
    assert.equal(await readHostEnrollment(ssh, 'ssh://fixture', platform), null)
    ssh.execute = async () => ({ stdout: `${id}\n` })
    assert.equal(await readHostEnrollment(ssh, 'ssh://fixture', platform), id)
    ssh.execute = async () => ({ stdout: 'invalid private payload' })
    await assert.rejects(readHostEnrollment(ssh, 'ssh://fixture', platform), error => !error.message.includes('private payload') && error.message.includes('fallback refused'))
    ssh.execute = async () => { throw new Error('permission denied') }
    await assert.rejects(readHostEnrollment(ssh, 'ssh://fixture', platform), /permission denied/u)
  }
})

test('enrollment transport is bounded, fixed and carries no program in a request field', () => {
  for (const platform of ['macos', 'windows']) {
    const request = hostEnrollmentRequest(platform, 'replace', { next, previous: id, native: nativeUuid })
    assert.ok(request.command.length < 8192)
    assert.ok(!request.command.includes('\n'))
    assert.ok(request.input.includes('intentaiops-host-enrollment-v1:'))
    assert.throws(() => hostEnrollmentRequest(platform, 'replace', { next, previous: id, native: nativeUuid, code: 'arbitrary' }))
    assert.throws(() => hostEnrollmentRequest(platform, 'replace', { next, previous: id, native: "'; reboot" }))
    assert.throws(() => hostEnrollmentRequest(platform, 'replace', { next, previous: id }))
  }
  assert.throws(() => hostEnrollmentRequest('linux', 'replace'))
})

function fakeHost (platform, previous = null) {
  let enrollment = previous
  const native = `${platform}:${nativeUuid}`
  let writes = 0
  const ssh = {
    nativeHostIdentity: async () => native,
    hostIdentity: async () => ({ platform, enrollmentId: enrollment, fingerprint: hostIdentityFingerprint(native, enrollment) }),
    hostFingerprint: async () => hostIdentityFingerprint(native, enrollment),
    execute: async (_url, command, options) => {
      if (command === 'hostname') return { stdout: 'cloned-hostname\n' }
      if (command.includes("printf 'uid=%s")) return { stdout: `system=${platform === 'macos' ? 'Darwin' : 'Windows_NT'}\nmachine=amd64\nuid=0\nadministrator=yes\n` }
      if (options?.input?.includes('INTENTAI_OPS_HOST_ENROLLED')) {
        if (platform === 'macos' && command.includes(' replace ')) {
          writes++; enrollment = command.match(/replace '([a-f0-9-]+)'/u)[1]
          return { code: 0, stdout: 'INTENTAI_OPS_HOST_ENROLLED\n' }
        }
        if (platform === 'windows') {
          const bootstrap = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
          const payload = bootstrap.match(/'replace' '([A-Za-z0-9+/=]+)'/u)
          if (payload) {
            const request = JSON.parse(Buffer.from(payload[1], 'base64').toString())
            assert.equal(request.native, nativeUuid)
            writes++; enrollment = request.next
            return { code: 0, stdout: 'INTENTAI_OPS_HOST_ENROLLED\n' }
          }
        }
        return { code: 0, stdout: enrollment ?? 'MISSING' }
      }
      throw new Error('Unexpected identity operation')
    }
  }
  return { ssh, writes: () => writes, enrollment: () => enrollment }
}

for (const platform of ['macos', 'windows']) {
  for (const previous of [null, id]) {
    test(`${platform} enrollment creation/rotation verifies its fingerprint: previous=${previous}`, async () => {
      const host = fakeHost(platform, previous)
      const result = await replaceHostEnrollment({ ssh: host.ssh, platform, connectionUrl: 'ssh://fixture', expectedFingerprint: await host.ssh.hostFingerprint(), runElevated: request => host.ssh.execute('ssh://fixture', request.command, { input: request.input }) })
      assert.equal(host.writes(), 1)
      assert.notEqual(host.enrollment(), previous)
      assert.equal(result, await host.ssh.hostFingerprint())
      assert.equal(await host.ssh.nativeHostIdentity(), `${platform}:${nativeUuid}`)
    })
  }
}

test('stale enrollment and lost write acknowledgment never trigger automatic replay', async () => {
  const host = fakeHost('macos')
  let writes = 0
  const args = { ssh: host.ssh, platform: 'macos', connectionUrl: 'ssh://fixture', expectedFingerprint: hostIdentityFingerprint(`macos:${nativeUuid}`, id), runElevated: async () => { writes++; throw new Error('lost connection') } }
  await assert.rejects(replaceHostEnrollment(args), /changed before enrollment/u)
  assert.equal(writes, 0)
  await assert.rejects(replaceHostEnrollment({ ...args, expectedFingerprint: await host.ssh.hostFingerprint() }), /no automatic retry/u)
  assert.equal(writes, 1)
})

for (const platform of ['macos', 'windows']) {
  for (const approved of [false, true]) {
    test(`${platform} copied enrollment rotation requires different-machine confirmation: ${approved}`, async () => {
      const host = fakeHost(platform, id)
      const originalFingerprint = await host.ssh.hostFingerprint()
      const settings = { servers: { original: { hostFingerprint: originalFingerprint } } }
      let question
      const result = await prepareHostIdentity({
        ui: { warn () {}, line () {}, success () {}, confirm: async value => { question = value; return approved } },
        ssh: host.ssh,
        connectionUrl: 'ssh://mac@new-fixture',
        serverId: 'new-host',
        settings,
        settingsStore: { decryptServer: async () => ({ connectionUrl: 'ssh://mac@original-fixture' }) },
        chooseElevation: async () => ({ elevation: platform === 'windows' ? 'windows-admin' : 'root' })
      })
      assert.match(question, /different VPS from original/u)
      assert.equal(host.writes(), approved ? 1 : 0)
      assert.equal(settings.servers.original.hostFingerprint, originalFingerprint)
      if (approved) assert.notEqual(result.hostFingerprint, originalFingerprint)
      else assert.equal(result, null)
    })
  }
  for (const approved of [false, true]) {
    test(`${platform} enrollment setup requires explicit terminal confirmation: ${approved}`, async () => {
      const host = fakeHost(platform)
      let prompted = 0
      const settings = { servers: {} }
      const ui = { warn () {}, line () {}, success () {}, confirm: async (_question, defaultValue) => { prompted++; assert.equal(defaultValue, false); return approved } }
      const result = await prepareHostIdentity({ ui, ssh: host.ssh, connectionUrl: 'ssh://fixture', serverId: 'new-host', settings, settingsStore: {}, passphrase: 'fixture', chooseElevation: async () => ({ elevation: platform === 'windows' ? 'windows-admin' : 'root' }) })
      assert.equal(prompted, 1)
      assert.equal(host.writes(), approved ? 1 : 0)
      if (approved) assert.equal(result.hostFingerprint, await host.ssh.hostFingerprint())
      else assert.equal(result, null)
    })
  }
}

test('enrolled hosts are read-only on reconnect and browser cancellation never saves configuration', async t => {
  const host = fakeHost('macos', id)
  const result = await prepareHostIdentity({ ui: { confirm: () => assert.fail('existing enrollment must not prompt') }, ssh: host.ssh, connectionUrl: 'ssh://fixture', serverId: 'new-host', settings: { servers: {} } })
  assert.equal(result.hostFingerprint, await host.ssh.hostFingerprint())
  assert.equal(host.writes(), 0)
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-enrollment-browser-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let saved = false; let closed = false
  const hosts = new OperatorHosts({ settings: { servers: {} }, settingsStore: { dataRoot: root, addServer: async () => { saved = true } }, factory: { openSsh: async () => ({ ssh: host.ssh, close: async () => { closed = true } }) }, prepareIdentity: async () => null })
  await assert.rejects(hosts.action({ action: 'host-add', hostId: 'new-host', connection: 'ssh mac@fixture' }), /cancelled host enrollment/u)
  assert.equal(saved, false)
  assert.equal(closed, true)
})

test('unsafe macOS enrollment evidence fails instead of falling back to Windows or legacy identity', async () => {
  let calls = 0
  const ssh = new SystemSsh({ runner: async () => { calls++; return calls === 1 ? { code: 0, stdout: `macos:${nativeUuid}` } : { code: 1, stdout: '', stderr: 'unsafe enrollment owner' } } })
  await assert.rejects(ssh.hostFingerprint('ssh://fixture'), /SSH command failed/u)
  assert.equal(calls, 2)
})

test('macOS and Windows enrollment assets enforce protected ownership and read-only discovery', async () => {
  const mac = await readFile(new URL('../remote/host-enrollment.sh', import.meta.url), 'utf8')
  const windows = await readFile(new URL('../remote/host-enrollment.ps1', import.meta.url), 'utf8')
  for (const fragment of ['test ! -L', 'stat -f %u', 'stat -f %l', 'mode & 0022', 'mode & 0004', 'stat -f %z', '.write-lock']) assert.ok(mac.includes(fragment), fragment)
  assert.ok(mac.indexOf('read) read_id') < mac.indexOf('mkdir -m 0755'))
  for (const fragment of ['ReparsePoint', 'GetAccessRules', 'ChangePermissions', 'TakeOwnership', 'SetOwner', 'CreateNew', 'Flush($true)', 'MoveFileEx', 'ReadAndExecute']) assert.ok(windows.includes(fragment), fragment)
  assert.ok(windows.indexOf("if($Operation -eq 'read')") < windows.indexOf('CreateDirectory'))
  assert.doesNotMatch(windows, /Set-ItemProperty|sysprep|Restart-Computer/u)
})

test('macOS enrollment script handles missing, corrupt, writable and linked records on disposable fixtures', { skip: process.platform !== 'linux' }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'intent-enrollment-fixture-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = await readFile(new URL('../remote/host-enrollment.sh', import.meta.url), 'utf8')
  const root = path.join(base, 'enrollment')
  const script = source.replace('root=/private/var/db/intentaiops-enrollment', `root='${root}'`).replace('test "$(uname -s)" = Darwin', ':').replace('test "$(id -u)" = 0', `test "$(id -u)" = ${process.getuid()}`).replace('stat -f %u "$1"', 'stat -c %u "$1"').replace('= 0 || return 1', `= ${process.getuid()} || return 1`).replaceAll('stat -f %Lp', 'stat -c %a').replaceAll('stat -f %l', 'stat -c %h').replaceAll('stat -f %z', 'stat -c %s').replace('permissions=$(ls -lde "$1") || return 1', "permissions=''").replace('for parent in / /private /private/var /private/var/db;', `for parent in '${base}';`).replace('chown 0:0', `chown ${process.getuid()}:${process.getgid()}`).replace(/current_native\(\) \{[^\n]+\}/u, `current_native() { printf '%s' '${nativeUuid}'; }`)
  const run = (operation, nextId = next, previous = 'MISSING') => runProcess('/bin/sh', ['-s', '--', operation, nextId, previous, nativeUuid], { input: script, timeoutMs: 15000 })
  assert.equal((await run('read')).stdout.trim(), 'MISSING')
  await assert.rejects(lstat(root), { code: 'ENOENT' })
  assert.equal((await run('replace')).code, 0)
  const file = path.join(root, 'host-id')
  assert.equal((await run('read')).stdout.trim(), next)
  assert.equal((await lstat(file)).mode & 0o777, 0o444)
  assert.notEqual((await run('replace', id, 'MISSING')).code, 0)
  assert.equal((await run('read')).stdout.trim(), next)
  await chmod(file, 0o644); await writeFile(file, 'private invalid content')
  const corrupt = await run('read')
  assert.notEqual(corrupt.code, 0)
  assert.ok(!corrupt.stdout.includes('private invalid content'))
  await writeFile(file, `intentaiops-host-enrollment-v1:${next}\n`); await chmod(file, 0o666)
  assert.notEqual((await run('read')).code, 0)
  await chmod(file, 0o444)
  const alias = path.join(base, 'linked-record')
  await link(file, alias)
  assert.notEqual((await run('read')).code, 0)
  await rm(alias); await rm(file); await symlink(alias, file)
  assert.notEqual((await run('read')).code, 0)
  await rm(file); await mkdir(path.join(root, '.write-lock'))
  assert.notEqual((await run('replace', id, 'MISSING')).code, 0)
  await rm(path.join(root, '.write-lock'), { recursive: true })
  const competing = await Promise.all([run('replace', id, 'MISSING'), run('replace', next, 'MISSING')])
  assert.equal(competing.filter(result => result.code === 0).length, 1)
  assert.ok([id, next].includes((await run('read')).stdout.trim()))
})
